import { describe, expect, it } from "vitest";

import { checkManualWorkout, computeTrainingValues, manualPace, maybeSameRun, type ManualWorkoutInput } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { targetText, type SessionDraft, type TargetContext } from "../src/plan";
import { activity, makeCoach, turn } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）
const TODAY = "2026-10-10";
const run = (partial: Partial<ManualWorkoutInput> = {}): ManualWorkoutInput => ({
  date: TODAY,
  distance_km: 5,
  duration_min: 35,
  perceived_effort: 3,
  avg_hr: null,
  subjective_notes: null,
  ...partial,
});

describe("手動新增一筆（規格 12.36）", () => {
  it("存成一般的紀錄（標手動）、算配速、產生分析；可以改與刪", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "輕鬆的一趟。" }), turn({ text: "改過之後的分析。" })]);
    const { workout, summary } = await coach.addManualWorkout(run({ subjective_notes: "  很舒服  " }));
    expect(workout).toMatchObject({ source: "manual", distance_km: 5, duration_min: 35, avg_pace: "7:00/km", perceived_effort: 3, subjective_notes: "很舒服", avg_hr: null });
    expect(workout.sync_id).toMatch(/^[0-9a-f]{32}$/);
    expect(summary).toBe("輕鬆的一趟。");
    // 分析走同一個出口（跑後摘要的模型），提示寫明是手動記的、沒有心率
    const prompt = JSON.stringify(provider.calls[0]!.request);
    expect(prompt).toContain("summary-model");
    expect(prompt).toContain("選手手動記錄");
    expect(prompt).toContain("不要推測心率");
    expect(prompt).toContain("體感和配速都在輕鬆的範圍");

    const updated = await coach.updateManualWorkout(workout.id, run({ distance_km: 6, duration_min: 36, perceived_effort: 4, avg_hr: 150 }));
    expect(updated.workout).toMatchObject({ distance_km: 6, avg_pace: "6:00/km", avg_hr: 150, perceived_effort: 4 });
    expect(updated.summary).toBe("改過之後的分析。");
    expect(await coach.db.countWorkouts()).toBe(1);

    await coach.deleteManualWorkout(workout.id);
    expect(await coach.db.countWorkouts()).toBe(0);
  });

  it("從 Intervals.icu 來的不能用手動的方式改或刪", async () => {
    const { coach } = await makeCoach();
    const id = await coach.db.saveWorkout(activity());
    await expect(coach.updateManualWorkout(id, run())).rejects.toThrow("只能改手動新增的紀錄");
    await expect(coach.deleteManualWorkout(id)).rejects.toThrow("只能刪除手動新增的紀錄");
  });

  it("欄位檢查：未來的日子、距離、時間、體感、心率與太快的配速", () => {
    expect(() => checkManualWorkout(run({ date: "2026-10-11" }), TODAY)).toThrow("還沒到");
    expect(() => checkManualWorkout(run({ distance_km: 0 }), TODAY)).toThrow("距離");
    expect(() => checkManualWorkout(run({ duration_min: 0 }), TODAY)).toThrow("時間");
    expect(() => checkManualWorkout(run({ perceived_effort: 11 }), TODAY)).toThrow("體感");
    expect(() => checkManualWorkout(run({ avg_hr: 20 }), TODAY)).toThrow("心率");
    expect(() => checkManualWorkout(run({ distance_km: 10, duration_min: 15 }), TODAY)).toThrow("配速");
    expect(manualPace({ distance_km: 10, duration_min: 55.5 })).toBe("5:33/km");
  });

  it("同一天從 Intervals.icu 進來看起來是同一趟：不自動合併，教練動態問要不要合併；合併後保留有心率的那筆、體感帶過去", async () => {
    const { coach } = await makeCoach([turn({ text: "分析" })]);
    const manual = (await coach.addManualWorkout(run({ distance_km: 10, duration_min: 55 }))).workout;
    const watchId = await coach.db.saveWorkout(activity({ distance_km: 10.02, duration_min: 55.1 }));
    expect(watchId).not.toBe(manual.id);
    expect(maybeSameRun(manual, activity({ distance_km: 10.02, duration_min: 55.1 }))).toBe(true);
    const feed = await coach.feed();
    const dup = feed.find((f) => f.kind === "duplicate");
    expect(dup?.actions).toContainEqual({ type: "merge", keepId: watchId, dupId: manual.id });
    await coach.mergeWorkouts(watchId, manual.id);
    const kept = await coach.db.getWorkout(watchId);
    expect(kept).toMatchObject({ avg_hr: 152, perceived_effort: 3 });
    expect(await coach.db.countWorkouts()).toBe(1);
    // 刪掉手動的那筆：手錶那筆照樣在
    await coach.deleteManualWorkout(manual.id);
    expect(await coach.db.countWorkouts()).toBe(1);
  });

  it("跟著同步到另一台：新增、修改（以修改時間為準）、分析、刪除", async () => {
    const a = await makeCoach([turn({ text: "分析一" }), turn({ text: "分析二" })]);
    const b = await makeCoach();
    const copy = async () => {
      const snap = await snapshot(a.driver);
      const target = await snapshot(b.driver);
      const names = [...snap.data.keys()].filter((k) => k.startsWith("mw:") || k.startsWith("ws:"));
      // 這台有、別台沒有的就是刪除
      for (const name of [...target.data.keys()].filter((k) => k.startsWith("mw:") && !snap.data.has(k))) await applyEntity(b.driver, name, null, target);
      for (const name of names.sort((x, y) => (x.startsWith("mw:") ? -1 : y.startsWith("mw:") ? 1 : 0))) {
        expect(await applyEntity(b.driver, name, snap.data.get(name)!, target)).toBe("applied");
      }
    };
    const { workout } = await a.coach.addManualWorkout(run({ subjective_notes: "下雨" }));
    await copy();
    const [copied] = await b.coach.db.getRecentWorkouts(7);
    expect(copied).toMatchObject({ source: "manual", sync_id: workout.sync_id, distance_km: 5, avg_pace: "7:00/km", perceived_effort: 3, subjective_notes: "下雨", summary: "分析一" });
    // 不另外送 w:（體感在 mw 裡）
    expect([...(await snapshot(a.driver)).data.keys()].some((k) => k.startsWith("w:"))).toBe(false);

    await a.coach.updateManualWorkout(workout.id, run({ distance_km: 7, duration_min: 42 }));
    await copy();
    expect((await b.coach.db.getRecentWorkouts(7))[0]).toMatchObject({ distance_km: 7, avg_pace: "6:00/km", summary: "分析二" });

    await a.coach.deleteManualWorkout(workout.id);
    await copy();
    expect(await b.coach.db.countWorkouts()).toBe(0);
  });
});

describe("沒有心率時（規格 12.36）", () => {
  const ctxOf = async (coach: Awaited<ReturnType<typeof makeCoach>>["coach"]): Promise<TargetContext> => ({
    values: await computeTrainingValues(coach.db, TODAY),
    challenge: false,
    fallbackPaceSec: 420,
  });

  it("選手說手動記錄：就算填了出生年也不給推算的心率；目標寫配速＋說話測試", async () => {
    const { coach } = await makeCoach();
    await coach.db.setProfileKey("birth_year", "1990");
    await coach.db.setProfileKey("record_with", "none");
    let ctx = await ctxOf(coach);
    expect(ctx.values.hr).toBeNull();
    expect(ctx.values.noHr).toContain("手動記錄");
    // 還沒有配速的依據：只寫體感與說話測試
    expect(targetText({ hr: "easy" }, ctx)).toBe("體感 2–4/10（能說完整的句子）");
    expect(targetText({ zone: "Z2" }, ctx)).toBe("體感 2–4/10（Z2，能說完整的句子）");
    expect(targetText({ pace: "T" }, ctx)).toBe("體感 6–7/10（T，還沒有配速的依據）");

    // 填了 5 km 的個人最佳：算得出配速
    await coach.db.setProfileKey("pb_5k", "28:00");
    ctx = await ctxOf(coach);
    expect(ctx.values.vdot).toMatchObject({ kind: "profile", distanceM: 5000, secs: 1680 });
    expect(targetText({ hr: "easy" }, ctx)).toMatch(/^約 \d:\d\d–\d:\d\d\/km（能說完整的句子，體感 2–4\/10）$/);
    expect(targetText({ pace: "E" }, ctx)).toMatch(/^\d:\d\d–\d:\d\d\/km（E，能說完整的句子）$/);
    expect(targetText({ zone: "Z4" }, ctx)).toMatch(/^約 \d:\d\d–\d:\d\d\/km（Z4，體感 6–7\/10）$/);
    expect(targetText({ pace: "T" }, ctx)).toMatch(/^\d:\d\d–\d:\d\d\/km（T）$/);
  });

  it("有手錶、有心率：照舊用心率", async () => {
    const { coach } = await makeCoach();
    await coach.db.setProfileKey("birth_year", "1990");
    await coach.db.setProfileKey("record_with", "watch");
    const ctx = await ctxOf(coach);
    expect(ctx.values.noHr).toBeNull();
    expect(targetText({ hr: "easy" }, ctx)).toMatch(/^心率 ≤\d+$/);
  });

  it("沒說怎麼記錄，但最近 3 次以上都沒有心率：一樣不給心率；有一趟有心率就照用", async () => {
    const { coach } = await makeCoach();
    await coach.db.setProfileKey("birth_year", "1990");
    for (const [i, date] of ["2026-10-04", "2026-10-06", "2026-10-08"].entries()) {
      await coach.db.saveWorkout(activity({ intervals_id: `p${i}`, date, avg_hr: null, max_hr: null, training_load: null, raw_json: null }), 4);
    }
    let values = await computeTrainingValues(coach.db, TODAY);
    expect(values.hr).toBeNull();
    expect(values.noHr).toBe("最近 3 次跑步都沒有心率");
    // sRPE：體感 × 分鐘
    expect(values.weeks.at(-1)!.srpe).toBe(Math.round(4 * 55.1 * 2));
    await coach.db.saveWorkout(activity({ intervals_id: "w1", date: "2026-10-09" }));
    values = await computeTrainingValues(coach.db, TODAY);
    expect(values.hr).not.toBeNull();
  });

  it("教練看到的：記錄方式、量不到心率、沒有推算的區間；手動記的選手回報跑步時請他到「回報」記", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "好" })], { settings: { shell: "web" } });
    await coach.db.setProfileKey("birth_year", "1990");
    await coach.db.setProfileKey("record_with", "none");
    await coach.chat("今天跑了 5 公里");
    const system = JSON.stringify(provider.calls[0]!.request.system);
    expect(system).toContain("記錄方式：沒有在記錄，手動記");
    expect(system).toContain("心率：量不到");
    expect(system).not.toContain("心率區間：Z1");
    expect(system).toContain("請選手到「回報」記一筆");
    expect(system).toContain("沒有心率時（v8");
  });

  it("課表照手動記的輕鬆跑比對成達成", async () => {
    const { coach } = await makeCoach([turn({ text: "分析" })]);
    await coach.db.setProfileKey("record_with", "none");
    const easy: SessionDraft = { date: TODAY, kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 30, target: { hr: "easy" } }], purpose: "", success: "", fallback: null };
    await coach.db.saveStructuredPlan({ weekLabel: "2026-W41", weekStart: "2026-10-05", style: "fixed", reason: "", outline: null, notes: null, content: "" }, [easy]);
    const { workout } = await coach.addManualWorkout(run({ distance_km: 4.5, duration_min: 32, perceived_effort: 3 }));
    const card = (await coach.runCards(7)).find((c) => c.workout.id === workout.id)!;
    expect(card.plan).toMatchObject({ outcome: "achieved" });
  });
});
