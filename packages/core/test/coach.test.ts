import { describe, expect, it } from "vitest";

import { formatTokenFooter } from "../src";
import { activity, makeCoach, ScriptedProvider, toolTurn, turn, type RecordedCall } from "./helpers";

/** 選手訊息開頭的傳送時間（測試時鐘：台北 2026-10-10 12:00） */
const SENT = "[2026-10-10（星期六）12:00，今天]\n";

describe("Coach.chat", () => {
  it("用量統計：層5不含剛送出的訊息，訊息另計", async () => {
    const { coach } = await makeCoach([turn({ text: "好的" }), turn({ text: "收到" })]);
    await coach.chat("第一則");
    const { stats } = await coach.chat("第二則訊息");
    expect(stats.userMsgChars).toBe((SENT + "第二則訊息").length);
    expect(stats.layerChars.layer5).toBe((SENT + "第一則").length + "好的".length);
  });

  it("剛送出的長訊息與最近一來一回完整帶入", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "A".repeat(900) }), turn({ text: "好" })]);
    await coach.chat("我".repeat(1000));
    expect(provider.calls[0]!.request.messages.at(-1)!.content).toBe(SENT + "我".repeat(1000));

    await coach.chat("下一則");
    expect(provider.calls[1]!.request.messages.map((m) => m.content)).toEqual([
      SENT + "我".repeat(1000),
      "A".repeat(900),
      SENT + "下一則",
    ]);
  });

  it("get_full_message：讀回被截斷的較早訊息；找不到時說明可能已壓縮", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("get_full_message", { message_id: 1 }),
      toolTurn("get_full_message", { message_id: 999 }),
      turn({ text: "後半段是週末長跑。" }),
    ]);
    await coach.db.appendConversation("user", "長".repeat(800));
    await coach.db.appendConversation("assistant", "收到");
    await coach.db.appendConversation("user", "再說");
    await coach.db.appendConversation("assistant", "好");

    await coach.chat("我第一則訊息的後半段是什麼？");
    expect(provider.calls[0]!.request.messages[0]!.content).toContain("以 get_full_message 讀取，message_id=1）");
    expect(provider.calls[1]!.toolResults![0]!.content).toBe(`訊息 1（使用者）的完整內容：\n\n${"長".repeat(800)}`);
    expect(provider.calls[2]!.toolResults![0]!.content).toBe("找不到 message_id=999 的訊息。");
  });

  it("跑後回報：拉取活動 → 合併主觀感受存檔並生成摘要 → 最終回覆", async () => {
    const { coach, provider, driver } = await makeCoach(
      [
        toolTurn("fetch_latest_activity"),
        toolTurn("save_workout", { perceived_effort: 7, subjective_notes: "腿有點重" }),
        turn({ text: "10km 55分，心率偏高。" }), // 摘要模型
        turn({ text: "今天跑得不錯，明天排輕鬆跑。" }),
      ],
      { activities: [activity()] },
    );

    const { reply, stats } = await coach.chat("剛跑完 10K，體感 7/10，腿有點重");
    expect(reply).toBe("今天跑得不錯，明天排輕鬆跑。");

    // 工具結果交回給模型的內容
    expect(provider.calls[1]!.toolResults![0]!.content).toBe(
      "最新跑步活動：\n" +
        "日期：2026-10-10　✅ 是今天的活動\n" +
        "距離：10.02km｜時長：55.1分鐘\n" +
        "配速：5:30/km｜心率：152/171bpm\n" +
        "爬升：48m｜卡路里：640｜負荷(Load)：72",
    );
    // 摘要是另一個模型的單次生成
    expect(provider.calls[2]!.request.model).toBe("summary-model");
    expect(provider.calls[2]!.request.messages[0]!.content).toContain("體感強度：7/10\n主觀感受：腿有點重");
    expect(provider.calls[3]!.toolResults![0]!.content).toBe("訓練紀錄已儲存（id=1）。\n\n10km 55分，心率偏高。");

    expect(await driver.all("SELECT intervals_id, perceived_effort, subjective_notes, training_load FROM workouts")).toEqual([
      { intervals_id: "i100", perceived_effort: 7, subjective_notes: "腿有點重", training_load: 72 },
    ]);
    expect(await driver.all("SELECT workout_id, summary FROM workout_summaries")).toEqual([
      { workout_id: 1, summary: "10km 55分，心率偏高。" },
    ]);
    expect(await coach.db.getRecentConversations(10)).toMatchObject([
      { role: "user", content: "剛跑完 10K，體感 7/10，腿有點重" },
      { role: "assistant", content: "今天跑得不錯，明天排輕鬆跑。" },
    ]);
    // 主對話用量不含摘要模型的呼叫
    expect(stats.usage).toMatchObject({ apiCalls: 3, toolRounds: 2 });
    // 第一則對話：層5只有剛送出的訊息，已另列為「訊息」，不再重複出現在層5
    expect(formatTokenFooter(stats)).toMatch(/^📊 輸入 100（層1系統~\d+  訊息~\d+） \| 輸出 60 \| 工具 2 輪，累計輸入 300$/);
  });

  it("手錶尚未同步：活動不是今天時提示模型，並可暫存主觀感受", async () => {
    const { coach, provider } = await makeCoach(
      [
        toolTurn("fetch_latest_activity"),
        toolTurn("save_pending_subjective", { date: "2026-10-10", perceived_effort: "6", subjective_notes: "還行" }),
        turn({ text: "已先記下，同步後再合併。" }),
      ],
      { activities: [activity({ date: "2026-10-08" })] },
    );
    await coach.chat("剛跑完，體感 6");

    expect(provider.calls[1]!.toolResults![0]!.content).toContain(
      "⚠️ 活動日期為 2026-10-08，非今天，手錶資料可能尚未同步至 Intervals.icu",
    );
    expect(provider.calls[2]!.toolResults![0]!.content).toBe(
      "主觀感受已暫存（2026-10-10）。手錶同步至 Intervals.icu 後請執行 /sync 完成合併。",
    );
    expect(await coach.db.getPendingSubjectiveByDate("2026-10-10")).toMatchObject({
      perceived_effort: 6,
      subjective_notes: "還行",
    });
  });

  it("工具執行失敗時把錯誤交回模型，不中斷對話", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("add_race", { name: "半馬", date: "2026-11-01", distance_km: "很遠" }),
      toolTurn("save_workout", { perceived_effort: 5 }),
      toolTurn("no_such_tool"),
      turn({ text: "抱歉，請再說一次距離。" }),
    ]);
    await coach.chat("幫我記下半馬");

    expect(provider.calls[1]!.toolResults![0]!.content).toBe("執行失敗：distance_km 不是有效的數字：很遠");
    expect(provider.calls[2]!.toolResults![0]!.content).toBe("錯誤：請先呼叫 fetch_latest_activity 取得活動資料。");
    expect(provider.calls[3]!.toolResults![0]!.content).toBe("未知的 tool：no_such_tool");
  });

  it("賽事與資料類工具的輸出", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("add_race", { name: "萬金石", date: "2026-11-01", distance_km: 21.1, target_time: "1:50:00" }),
      toolTurn("update_race", { race_id: 1, target_time: "1:48:00", confirmed: 0 }),
      toolTurn("list_races", {}),
      toolTurn("update_athlete_profile", { key: "max_hr", value: "185" }),
      turn({ text: "好了" }),
      toolTurn("get_training_plan"),
      toolTurn("mark_race_not_started", { race_id: 1, reason: "injury", note: "右膝" }),
      toolTurn("list_races", { status: "upcoming" }),
      turn({ text: "好了" }),
    ]);
    await coach.chat("一");
    // 手動填寫的文字課表（網頁版、Discord 的 /plan）
    await coach.savePlanForThisWeek("週二間歇、週日長跑");
    await coach.chat("二");

    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results).toEqual([
      "賽事已新增（id=1）：2026-11-01 萬金石",
      "賽事「萬金石」（id=1）已更新：target_time=1:48:00、confirmed=0",
      "賽事頁上的賽事（1 場，新的在前）：\n- [1] 2026-11-01 萬金石 21.1km｜目標 1:48:00｜還有 22 天（考慮中）",
      "選手資料已更新：max_hr = 185",
      "當前訓練計畫（2026-W41，文字版）：\n\n週二間歇、週日長跑",
      "已記下「萬金石」沒有出賽（受傷或生病），紀錄保留。",
      "沒有狀態是 upcoming 的賽事。",
    ]);
    // 第二則訊息的 system prompt 已反映第一則訊息中更新的資料
    expect(provider.calls[5]!.request.system).toContain("最大心率：185bpm（實測）");
    expect(provider.calls[5]!.request.system).toContain("- [1] 2026-11-01 萬金石 21.1km｜目標 1:48:00｜距今 22 天（考慮中）");
  });

  it("訓練歷史與配速趨勢", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("get_recent_workouts", {}),
      toolTurn("get_pace_trend", { weeks: 4 }),
      toolTurn("get_pace_trend", { weeks: 1 }),
      turn({ text: "好" }),
    ]);
    const w1 = await coach.db.saveWorkout(activity({ intervals_id: "a", date: "2026-10-08", avg_pace: "5:30/km" }), 7, null);
    await coach.db.saveWorkoutSummary(w1, "節奏跑，狀態佳");
    await coach.db.saveWorkout(activity({ intervals_id: "b", date: "2026-10-06", avg_pace: "6:01/km", distance_km: 8 }));
    await coach.db.saveWorkout(activity({ intervals_id: "c", date: "2026-09-30", avg_pace: "5:50/km", avg_hr: null }));
    await coach.db.saveWorkout(activity({ intervals_id: "d", date: "2026-08-01", avg_pace: "5:00/km" }));
    await coach.chat("最近練得怎樣");

    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toBe(
      "最近 14 天的訓練紀錄（共 3 筆）：\n" +
        "\n【2026-10-08】10.02km｜5:30/km｜心率 152/171bpm｜體感 7/10\n" +
        "  AI摘要：節奏跑，狀態佳\n" +
        "\n【2026-10-06】8km｜6:01/km｜心率 152/171bpm\n" +
        "\n【2026-09-30】10.02km｜5:50/km｜心率 ?/171bpm",
    );
    expect(results[1]).toBe("過去 4 週週平均配速：\n  2026-W40：5:50/km（1 筆）\n  2026-W41：5:45/km（2 筆）");
    expect(results[2]).toBe("過去 1 週週平均配速：\n  2026-W41：5:45/km（2 筆）");
  });

  it("模型拒絕回答或沒有文字時回覆友善提示並存入對話", async () => {
    const { coach } = await makeCoach([turn({ finish: "refused" }), turn({ text: "  ", finish: "truncated" })]);
    expect((await coach.chat("a")).reply).toBe("這個問題我沒辦法回覆，換個方式問問看？");
    expect((await coach.chat("b")).reply).toBe("這次沒有產生回覆（可能是內容太長被截斷），請再問一次，或把問題拆小一點。");
    expect(await coach.db.countConversations()).toBe(4);
  });

  it("API 失敗時往外丟出，使用者訊息仍保留在對話中", async () => {
    const { coach } = await makeCoach([new Error("529 overloaded")]);
    await expect(coach.chat("哈囉")).rejects.toThrow("529 overloaded");
    expect(await coach.db.getRecentConversations(5)).toMatchObject([{ role: "user", content: "哈囉" }]);
  });
});

describe("對話壓縮", () => {
  const settings = { conversationMax: 4, conversationKeep: 2 };

  it("超過上限時在背景壓縮最舊的對話，並延續更新既有摘要", async () => {
    const { coach, provider } = await makeCoach([], { settings });
    for (const content of ["u1", "a1", "u2", "a2"]) {
      await coach.db.appendConversation(content.startsWith("u") ? "user" : "assistant", content);
    }
    // 壓縮與主對話並行，依用途回應；壓縮刻意慢一點，模擬真實情況下主對話先讀到舊狀態
    const respond = (summary: string, reply: string) => async (call: RecordedCall) => {
      if (call.request.model !== "compress-model") return turn({ text: reply });
      await new Promise((resolve) => setTimeout(resolve, 20));
      return turn({ text: summary });
    };
    provider.script.push(respond("【訓練狀態】第一版", "回覆"), respond("【訓練狀態】第一版", "回覆"));
    await coach.chat("u3");
    await coach.idle();

    const compressCall = provider.calls.find((c) => c.request.model === "compress-model")!;
    // 壓縮的輸入也帶傳送時間，但不加「今天」：摘要會沿用很多天
    const at = "[2026-10-10（星期六）12:00]";
    expect(compressCall.request.messages[0]!.content).toContain(`對話紀錄：\nUSER ${at}: u1\nASSISTANT: a1\nUSER ${at}: u2`);
    expect(compressCall.request.messages[0]!.content).toContain("不要用「明天」「下週」這類相對說法");
    expect((await coach.db.getLatestSummary())?.content).toBe("【訓練狀態】第一版");
    expect((await coach.db.getRecentConversations(10)).map((r) => r.content)).toEqual(["a2", "u3", "回覆"]);

    // 再累積到超過上限：第二次壓縮帶入前次摘要
    await coach.db.appendConversation("user", "u4");
    await coach.db.appendConversation("assistant", "a4");
    provider.script.push(respond("【訓練狀態】第二版", "回覆二"), respond("【訓練狀態】第二版", "回覆二"));
    const { reply } = await coach.chat("u5");
    await coach.idle();
    expect(reply).toBe("回覆二");

    const second = provider.calls.filter((c) => c.request.model === "compress-model")[1]!;
    expect(second.request.messages[0]!.content).toContain(
      `【現有摘要】\n【訓練狀態】第一版\n\n【新增對話】\nASSISTANT: a2\nUSER ${at}: u3\nASSISTANT: 回覆\nUSER ${at}: u4`,
    );
    expect((await coach.db.getLatestSummary())?.content).toBe("【訓練狀態】第二版");
    expect((await coach.db.getRecentConversations(10)).map((r) => r.content)).toEqual(["a4", "u5", "回覆二"]);
    // 主對話送出時壓縮尚未完成：context 是舊摘要加上全部未壓縮的對話，沒有缺口
    const chatCall = provider.calls.filter((c) => c.request.model === "chat-model").at(-1)!;
    expect(chatCall.request.messages.map((m) => m.content)).toEqual([
      "以下是之前對話的重點摘要：\n\n【訓練狀態】第一版",
      "已閱讀對話摘要，我會記住這些重要資訊。",
      "a2",
      SENT + "u3",
      "回覆",
      SENT + "u4",
      "a4",
      SENT + "u5",
    ]);
  });

  it("configure 更換設定時沿用同一個資料庫與壓縮狀態，進行中的壓縮不會重複觸發", async () => {
    const { coach, provider, activities } = await makeCoach([], { settings });
    for (let i = 0; i < 4; i++) await coach.db.appendConversation("user", `m${i}`);

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const respond = async (call: RecordedCall) => {
      if (call.request.model !== "compress-model") return turn({ text: "回覆" });
      await gate;
      return turn({ text: "【訓練狀態】摘要" });
    };
    provider.script.push(respond, respond);
    await coach.chat("m4"); // 背景壓縮開始，停在 gate

    const next = new ScriptedProvider([turn({ text: "新設定的回覆" })]);
    coach.configure({
      llm: { provider: next, models: { chat: "new-chat", summary: "new-summary", compress: "new-compress" }, chatEffort: "low" },
      activities,
      settings: { ...settings, timeZone: "Asia/Tokyo" },
    });
    expect(coach.settings.timeZone).toBe("Asia/Tokyo");
    expect(coach.describeModels().chat).toBe("new-chat（思考強度 low）");

    // 對話數仍超過上限，但上一次壓縮還沒結束，不再觸發
    const { reply } = await coach.chat("m5");
    expect(reply).toBe("新設定的回覆");
    expect(next.calls.map((c) => c.request.model)).toEqual(["new-chat"]);

    release();
    await coach.idle();
    expect(provider.calls.filter((c) => c.request.model === "compress-model")).toHaveLength(1);
    expect((await coach.db.getLatestSummary())?.content).toBe("【訓練狀態】摘要");
  });

  it("壓縮失敗時保留原對話，下一輪再試", async () => {
    const { coach, provider, logs } = await makeCoach([], { settings });
    for (let i = 0; i < 4; i++) await coach.db.appendConversation("user", `m${i}`);
    const respond = (call: RecordedCall) =>
      call.request.model === "compress-model" ? turn({ finish: "refused" }) : turn({ text: "回覆" });
    provider.script.push(respond, respond);
    await coach.chat("m4");
    await coach.idle();

    expect(await coach.db.getLatestSummary()).toBeNull();
    expect(await coach.db.countConversations()).toBe(6);
    expect(logs.some((l) => l.startsWith("warn Compression failed"))).toBe(true);
  });
});

describe("Coach.sync", () => {
  it("新增活動、合併主觀暫存、略過已存在的資料", async () => {
    const { coach, driver } = await makeCoach(
      [turn({ text: "摘要A" }), turn({ text: "摘要B" })],
      {
        activities: [
          activity({ intervals_id: "new1", date: "2026-10-10" }),
          activity({ intervals_id: "new2", date: "2026-10-08" }),
          activity({ intervals_id: "old", date: "2026-10-05" }),
        ],
      },
    );
    await coach.db.saveWorkout(activity({ intervals_id: "old", date: "2026-10-05" }));
    await coach.db.savePendingSubjective("2026-10-10", 8, "很累");
    await coach.db.savePendingSubjective("2026-09-20", 5, "過期的暫存");

    expect(await coach.sync()).toBe("✅ Intervals.icu 同步完成：新增 2 筆訓練紀錄，其中 1 筆合併了主觀感受，略過 1 筆已存在資料");
    expect(await driver.all("SELECT intervals_id, perceived_effort, subjective_notes FROM workouts ORDER BY id")).toEqual([
      { intervals_id: "old", perceived_effort: null, subjective_notes: null },
      { intervals_id: "new1", perceived_effort: 8, subjective_notes: "很累" },
      { intervals_id: "new2", perceived_effort: null, subjective_notes: null },
    ]);
    expect(await coach.db.countPendingSubjective()).toBe(0);
    expect(await coach.sync()).toBe("✅ 無新資料，所有活動已是最新狀態。");
  });

  it("沒有活動、摘要失敗時的處理", async () => {
    const empty = await makeCoach();
    expect(await empty.coach.sync()).toBe("Intervals.icu 最近 14 天無跑步活動。如果最近有跑步，請確認手錶或 App 已把紀錄上傳到 Intervals.icu。");

    // 有走路、騎車等其他活動：說明只讀跑步，不必檢查上傳（常見的是跑步被記成走路）
    const walker = await makeCoach();
    Object.assign(walker.activities, { fetchOtherActivityTypes: async () => ["Walk", "Walk", "VirtualRide", "Kayaking"] });
    expect(await walker.coach.sync()).toBe(
      "Intervals.icu 最近 14 天無跑步活動。另有 2 筆走路、1 筆騎車、1 筆其他運動，教練目前只讀跑步；" +
        "如果其中有跑步，可以在 Intervals.icu 把類型改成 Run。",
    );

    // 取得其他活動失敗時，照原本的訊息
    const broken = await makeCoach();
    Object.assign(broken.activities, {
      fetchOtherActivityTypes: async () => {
        throw new Error("down");
      },
    });
    expect(await broken.coach.sync()).toBe("Intervals.icu 最近 14 天無跑步活動。如果最近有跑步，請確認手錶或 App 已把紀錄上傳到 Intervals.icu。");

    const { coach } = await makeCoach([new Error("LLM 掛了")], { activities: [activity()] });
    expect(await coach.sync()).toBe("✅ Intervals.icu 同步完成：新增 1 筆訓練紀錄");
    expect(await coach.db.countWorkouts()).toBe(1);
  });
});

describe("Coach.reportRun（表單式跑後回報）", () => {
  it("今天有活動：直接存檔並生成摘要，不經過工具迴圈", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "穩定的有氧跑" })], { activities: [activity()] });
    const report = await coach.reportRun(6, "輕鬆");

    expect(report).toMatchObject({ status: "saved", workoutId: 1, summary: "穩定的有氧跑" });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.request.model).toBe("summary-model");
    expect((await coach.db.getRecentWorkouts(1))[0]).toMatchObject({ perceived_effort: 6, summary: "穩定的有氧跑" });
  });

  it("補填已同步紀錄的體感：更新欄位並帶著體感重新產生摘要", async () => {
    const { coach, provider } = await makeCoach(
      [turn({ text: "同步時的摘要" }), turn({ text: "加上體感後的摘要" })],
      { activities: [activity({ date: "2026-10-08" })] },
    );
    await coach.sync();
    const [synced] = await coach.db.getRecentWorkouts(7);
    expect(synced).toMatchObject({ perceived_effort: null, summary: "同步時的摘要" });

    const result = await coach.addSubjective(synced!.id, 8, "  最後兩公里很喘 ");
    expect(result).toMatchObject({
      summary: "加上體感後的摘要",
      workout: { perceived_effort: 8, subjective_notes: "最後兩公里很喘", summary: "加上體感後的摘要" },
    });
    expect(provider.calls[1]!.request.messages[0]!.content).toContain("體感強度：8/10\n主觀感受：最後兩公里很喘");
    // 列表只顯示一次，附最新的摘要
    expect(await coach.db.getRecentWorkouts(7)).toMatchObject([{ id: synced!.id, summary: "加上體感後的摘要" }]);

    await expect(coach.addSubjective(999, 5, "")).rejects.toThrow("找不到這筆訓練紀錄");
  });

  it("補填時摘要失敗：體感照樣存檔，保留原本的摘要", async () => {
    const { coach } = await makeCoach([turn({ text: "同步時的摘要" }), turn({ finish: "refused" })], {
      activities: [activity({ date: "2026-10-08" })],
    });
    await coach.sync();
    const [synced] = await coach.db.getRecentWorkouts(7);
    const result = await coach.addSubjective(synced!.id, 4, "");
    expect(result).toMatchObject({ summary: null, workout: { perceived_effort: 4, subjective_notes: null, summary: "同步時的摘要" } });
  });

  it("列出最近幾天還沒回報的跑步，指定要存到哪一筆", async () => {
    const run = (id: string, date: string, start: string | null, km = 8) =>
      activity({
        intervals_id: id,
        date,
        distance_km: km,
        raw_json: JSON.stringify(start ? { id, start_date_local: `${date}T${start}:00` } : { id }),
      });
    const evening = run("i-pm", "2026-10-10", "18:30", 5);
    const morning = run("i-am", "2026-10-10", "07:12", 10.2);
    const yesterday = run("i-y", "2026-10-09", "19:30", 6);
    const { coach, provider } = await makeCoach([turn({ text: "傍晚那趟的分析" }), turn({ text: "早上那趟的分析" })], {
      activities: [evening, morning, yesterday],
    });
    // 早上那趟已同步、還沒回報；昨天那趟已回報；另有一筆只在資料庫裡（來源這次沒回傳）
    const morningId = await coach.db.saveWorkout(morning);
    await coach.db.saveWorkout(yesterday, 6, "順");
    const localId = await coach.db.saveWorkout(run("i-local", "2026-10-09", null, 4));

    const { candidates, fetchError } = await coach.reportCandidates();
    expect(fetchError).toBeNull();
    expect(candidates.map((c) => [c.target, c.activity.date, c.startTime, c.activity.distance_km])).toEqual([
      [{ kind: "new", intervalsId: "i-pm" }, "2026-10-10", "18:30", 5],
      [{ kind: "saved", workoutId: morningId }, "2026-10-10", "07:12", 10.2],
      [{ kind: "saved", workoutId: localId }, "2026-10-09", null, 4],
    ]);

    // 還沒同步的那筆：存檔並帶著體感產生分析
    const pm = await coach.reportRun(7, "最後很喘", candidates[0]!.target);
    expect(pm).toMatchObject({ status: "saved", summary: "傍晚那趟的分析", activity: { intervals_id: "i-pm" } });
    expect(provider.calls[0]!.request.messages[0]!.content).toContain("體感強度：7/10\n主觀感受：最後很喘");

    // 已同步的那筆：更新體感並重新產生分析，不會存成新的一筆
    const am = await coach.reportRun(4, "", candidates[1]!.target);
    expect(am).toMatchObject({ status: "saved", workoutId: morningId, summary: "早上那趟的分析", activity: { intervals_id: "i-am" } });
    expect(await coach.db.countWorkouts()).toBe(4);
    expect((await coach.reportCandidates()).candidates.map((c) => c.target)).toEqual([{ kind: "saved", workoutId: localId }]);

    // 還沒同步的這一趟：暫存，同一天重送時以新的為準
    await coach.reportRun(5, "先記下", { kind: "pending" });
    expect(await coach.reportRun(6, "改一下", { kind: "pending" })).toMatchObject({ status: "pending", date: "2026-10-10" });
    expect(await coach.db.countPendingSubjective()).toBe(1);
    expect(await coach.db.getPendingSubjectiveByDate("2026-10-10")).toMatchObject({ perceived_effort: 6, subjective_notes: "改一下" });

    await expect(coach.reportRun(5, "", { kind: "new", intervalsId: "i-gone" })).rejects.toThrow("找不到這筆活動");
  });

  it("連不上活動來源時，只列出已同步的紀錄", async () => {
    const { coach, activities } = await makeCoach();
    activities.fetchActivities = async () => {
      throw new Error("Intervals.icu 回應 503");
    };
    const id = await coach.db.saveWorkout(activity({ date: "2026-10-09" }));
    expect(await coach.reportCandidates()).toEqual({
      candidates: [expect.objectContaining({ target: { kind: "saved", workoutId: id } })],
      fetchError: "Intervals.icu 回應 503",
    });
  });

  it("只用 iPhone、沒有心率：分析的提示不猜心率，紀錄寫明沒有心率", async () => {
    const run = activity({ avg_hr: null, max_hr: null, training_load: null });
    const { coach, provider } = await makeCoach([turn({ text: "穩定的慢跑" }), toolTurn("get_recent_workouts", { days: 7 }), turn({ text: "好" })], {
      activities: [run],
    });
    await coach.reportRun(5, "", { kind: "new", intervalsId: "i100" });
    const prompt = String(provider.calls[0]!.request.messages[0]!.content);
    expect(prompt).toContain("心率：沒有資料（只用手機記錄，或沒有配戴心率裝置）");
    expect(prompt).toContain("沒有心率資料：依配速、時長與體感評估，不要推測心率。");
    expect(prompt).not.toContain("bpm");

    await coach.chat("最近練得怎樣");
    expect(provider.calls[2]!.toolResults![0]!.content).toContain("【2026-10-10】10.02km｜5:30/km｜沒有心率｜體感 5/10");
  });

  it("手錶尚未同步：暫存主觀感受", async () => {
    const { coach, provider } = await makeCoach([], { activities: [activity({ date: "2026-10-09" })] });
    const report = await coach.reportRun(6, "輕鬆");

    expect(report).toMatchObject({ status: "pending", date: "2026-10-10" });
    expect(provider.calls).toHaveLength(0);
    expect(await coach.db.countPendingSubjective()).toBe(1);
  });
});

describe("狀態", () => {
  it("回報各層資料量與模型設定", async () => {
    const { coach } = await makeCoach();
    await coach.db.setProfileKey("max_hr", "185");
    await coach.db.addRace({ name: "半馬", date: "2026-11-01", distance_km: 21.1 });
    expect(await coach.savePlanForThisWeek("本週計畫")).toBe("2026-W41");

    expect(await coach.status()).toEqual({
      profileKeys: 1,
      upcomingRaces: 1,
      unrecordedRaces: 0,
      recentWorkouts: 0,
      totalWorkouts: 0,
      pendingSubjective: 0,
      trainingPlanLabel: "2026-W41",
      convSummaryChars: 0,
      conversationCount: 0,
      conversationMax: 20,
    });
    expect(coach.describeModels()).toEqual({
      chat: "chat-model（思考強度 medium）",
      summary: "summary-model（思考強度 low）",
      compress: "compress-model（思考強度 low）",
    });
  });
});
