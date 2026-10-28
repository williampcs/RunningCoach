import { beforeEach, describe, expect, it } from "vitest";

import { Coach, Db, newRootKey, SyncApi, SyncEngine, type Activity, type LlmProvider } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { deriveKeys, recordId, seal } from "../../../packages/core/src/device-sync/crypto";

import { createSyncHandler } from "../src/handler";
import { SyncStore } from "../src/store";

let clock: Date;
let serverDriver: NodeSqliteDriver;
let api: SyncApi;

async function device() {
  const driver = openNodeSqlite(":memory:");
  const db = new Db(driver, { now: () => clock, today: () => clock.toISOString().slice(0, 10) });
  await db.init();
  return { db, driver };
}

const run = (id: string, date: string, partial: Partial<Activity> = {}): Activity => ({
  intervals_id: id,
  date,
  type: "run",
  distance_km: 10,
  duration_min: 55,
  avg_hr: 150,
  max_hr: 170,
  avg_pace: "5:30/km",
  elevation_m: 40,
  calories: 600,
  training_load: 60,
  raw_json: JSON.stringify({ id, start_date_local: `${date}T06:30:00`, moving_time: 3300 }),
  ...partial,
});

beforeEach(async () => {
  clock = new Date("2026-10-22T01:00:00Z");
  serverDriver = openNodeSqlite(":memory:");
  const store = new SyncStore(serverDriver);
  await store.init();
  const handle = createSyncHandler({ store, allowedOrigins: [] });
  api = new SyncApi("http://sync.test", (input, init) => handle(new Request(input as string, init)));
});

describe("兩台裝置同步", () => {
  it("選手資料、賽事、課表、自評、對話、摘要、跑步上的體感與分析都帶到另一台；沒有的跑步先暫存", async () => {
    const root = newRootKey();
    const a = await device();
    await a.db.setProfileKey("pref_intensity", "moderate");
    await a.db.addRace({ name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:45:00" });
    await a.db.saveStructuredPlan(
      { weekLabel: "2026-W43", weekStart: "2026-10-19", style: "fixed", reason: "這週", outline: null, notes: null, content: "文字版" },
      [{ date: "2026-10-23", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "恢復", success: "心率", fallback: null }],
    );
    await a.db.saveCheckin({ date: "2026-10-22", energy: 4, soreness: 2, sleep: 4, notes: "不錯" });
    await a.db.appendConversation("user", "今天要跑什麼？");
    await a.db.appendConversation("assistant", "40 分鐘輕鬆跑", ["目前的課表"]);
    const w1 = await a.db.saveWorkout(run("i1", "2026-10-20"), 6, "腿有點重");
    await a.db.saveWorkoutSummary(w1, "穩定的有氧跑\n\n- 心率穩");
    const w2 = await a.db.saveWorkout(run("i2", "2026-10-21"));
    const w3 = await a.db.saveWorkout(run("i3", "2026-10-21", { raw_json: JSON.stringify({ id: "i3", start_date_local: "2026-10-21T18:00:00" }) }));
    await a.db.markDistinct(w2, w3);

    const engineA = new SyncEngine(a.db, api, root, () => clock);
    expect(await engineA.ensureSpace()).toBe(true);
    const sentA = await engineA.sync();
    expect(sentA.sent).toBeGreaterThanOrEqual(10);

    // 另一台：已經從 Intervals.icu 同步到 i1、i2，還沒有 i3
    const b = await device();
    await b.db.saveWorkout(run("i1", "2026-10-20"));
    await b.db.saveWorkout(run("i2", "2026-10-21"));
    const engineB = new SyncEngine(b.db, api, Uint8Array.from(root), () => clock);
    expect(await engineB.ensureSpace()).toBe(false);
    const got = await engineB.sync();
    expect(got.received).toBeGreaterThanOrEqual(10);
    expect(got.pending).toBe(1);

    expect((await b.db.getProfile()).pref_intensity).toBe("moderate");
    expect((await b.db.getAllRaces()).map((r) => [r.name, r.target_time])).toEqual([["台北馬", "3:45:00"]]);
    const plan = await b.db.getActiveTrainingPlan();
    expect(plan).toMatchObject({ week_start: "2026-10-19", style: "fixed" });
    expect((await b.db.getPlannedSessions(plan!.id)).map((s) => s.title)).toEqual(["輕鬆跑"]);
    expect(await b.db.getCheckins(1)).toEqual([expect.objectContaining({ date: "2026-10-22", energy: 4, notes: "不錯" })]);
    expect((await b.db.getRecentConversations(10)).map((c) => [c.role, c.content, c.sources])).toEqual([
      ["user", "今天要跑什麼？", []],
      ["assistant", "40 分鐘輕鬆跑", ["目前的課表"]],
    ]);
    const bw1 = await b.db.getWorkoutByIntervalsId("i1");
    expect(bw1).toMatchObject({ perceived_effort: 6, subjective_notes: "腿有點重" });
    expect((await b.db.getRecentWorkouts(30)).find((w) => w.intervals_id === "i1")?.summary).toBe("穩定的有氧跑\n\n- 心率穩");

    // 沒有變更時不重送，也不重複套用；兩台同步的總筆數一樣
    const againB = await engineB.sync();
    const againA = await engineA.sync();
    expect(againB).toMatchObject({ received: 0, sent: 0 });
    expect(againA).toMatchObject({ received: 0, sent: 0 });
    expect(againB.total).toBeGreaterThanOrEqual(10);
    expect(againA.total).toBe(againB.total);

    // 那趟跑步同步到 B 之後，暫存的「不是同一趟」就套用
    const bw3 = await b.db.saveWorkout(run("i3", "2026-10-21", { raw_json: JSON.stringify({ id: "i3", start_date_local: "2026-10-21T18:00:00" }) }));
    expect(await engineB.sync()).toMatchObject({ pending: 0, sent: 0 });
    const bw2 = (await b.db.getWorkoutByIntervalsId("i2"))!.id;
    expect((await b.db.getDistinctPairs()).has(`${Math.min(bw2, bw3)}-${Math.max(bw2, bw3)}`)).toBe(true);
  });

  it("交叉訓練的運動與「做完了」帶到另一台；沒有這兩項的課內容不變（之前同步過的不重送）", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    const planId = await a.db.saveStructuredPlan(
      { weekLabel: "2026-W43", weekStart: "2026-10-19", style: "fixed", reason: "這週", outline: null, notes: null, content: "" },
      [
        { date: "2026-10-20", kind: "strength", title: "肌力", steps: [{ duration_min: 20 }], purpose: "", success: "", fallback: null },
        { date: "2026-10-21", kind: "cross", sport: "ride", title: "輕鬆騎", steps: [{ duration_min: 45, target: { zone: "Z2" } }], purpose: "", success: "", fallback: null },
        { date: "2026-10-22", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40 }], purpose: "", success: "", fallback: null },
      ],
    );
    const [strength] = await a.db.getPlannedSessions(planId);
    await a.db.updatePlannedSession(strength!.id, { done_at: "2026-10-20T12:00:00.000Z" });
    await engineA.sync();
    await engineB.sync();
    const plan = await b.db.getActiveTrainingPlan();
    expect((await b.db.getPlannedSessions(plan!.id)).map((s) => [s.title, s.sport, s.done_at])).toEqual([
      ["肌力", null, "2026-10-20T12:00:00.000Z"],
      ["輕鬆騎", "ride", null],
      ["輕鬆跑", null, null],
    ]);
    // 取消「做完了」也帶過去
    clock = new Date("2026-10-22T02:00:00Z");
    await a.db.updatePlannedSession(strength!.id, { done_at: null });
    expect(await engineA.sync()).toMatchObject({ sent: 1 });
    await engineB.sync();
    expect((await b.db.getPlannedSessions(plan!.id))[0]!.done_at).toBeNull();
  });

  it("修改與刪除帶到另一台；同一筆兩台都改時，時間新的為準", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    await a.db.setProfileKey("goal", "半馬破 2 小時");
    await a.db.saveCheckin({ date: "2026-10-21", energy: 3, soreness: 3, sleep: 3, notes: null });
    const race = await a.db.addRace({ name: "田中馬", date: "2026-11-08", distance_km: 42.195 });
    await engineA.sync();
    await engineB.sync();

    // B 改賽事、A 刪掉選手資料的一項
    const raceOnB = (await b.db.getAllRaces())[0]!;
    await b.db.updateRace(raceOnB.id, { target_time: "4:00:00" });
    await a.db.deleteProfileKey("goal");
    await engineB.sync();
    await engineA.sync();
    await engineB.sync();
    expect((await a.db.getAllRaces()).find((r) => r.id === race)?.target_time).toBe("4:00:00");
    expect((await b.db.getProfile()).goal).toBeUndefined();

    // 兩台都改同一天的自評：後改的（updated_at 較新）為準，兩台一致
    await a.db.saveCheckin({ date: "2026-10-21", energy: 2, soreness: 4, sleep: 2, notes: "A" });
    clock = new Date(clock.getTime() + 60_000);
    await b.db.saveCheckin({ date: "2026-10-21", energy: 5, soreness: 1, sleep: 5, notes: "B（較晚）" });
    await engineA.sync();
    await engineB.sync();
    await engineA.sync();
    expect((await a.db.getCheckins(5)).find((c) => c.date === "2026-10-21")?.notes).toBe("B（較晚）");
    expect((await b.db.getCheckins(5)).find((c) => c.date === "2026-10-21")?.notes).toBe("B（較晚）");
    expect(await engineA.sync()).toMatchObject({ received: 0, sent: 0 });
    expect(await engineB.sync()).toMatchObject({ received: 0, sent: 0 });
  });

  it("對話壓縮後，舊的對話在另一台也標成已整理（原文保留）、摘要帶過去", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await a.db.appendConversation(i % 2 ? "assistant" : "user", `第 ${i} 則`));
    await engineA.sync();
    await engineB.sync();
    expect(await b.db.countConversations()).toBe(4);
    await a.db.applyCompression("選手狀態摘要", ids[1]!);
    await engineA.sync();
    await engineB.sync();
    expect((await b.db.getRecentConversations(10)).map((c) => c.content)).toEqual(["第 2 則", "第 3 則"]);
    expect((await b.db.getConversationPage(10)).map((c) => [c.content, c.archived])).toEqual([
      ["第 0 則", true],
      ["第 1 則", true],
      ["第 2 則", false],
      ["第 3 則", false],
    ]);
    expect((await b.db.getLatestSummary())?.content).toBe("選手狀態摘要");
    // 已整理只會從沒有變成有：B 沒改過，再同步也不會被改回去
    expect(await engineB.sync()).toMatchObject({ received: 0, sent: 0 });
    expect(await engineA.sync()).toMatchObject({ received: 0, sent: 0 });
  });

  it("記住的事與回覆帶到另一台；修改、刪除也是；兩台各記了同一句只留一條", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    const shoes = await a.db.addMemory("鞋子跑到 600 公里要換", "coach");
    await a.db.addMemory("週三晚上不能練", "user");
    await b.db.addMemory("週三晚上不能練", "user");
    const asked = await a.db.appendConversation("assistant", "週四的節奏跑");
    const row = (await a.db.getConversation(asked))!;
    await a.db.appendConversation("user", "可以換天嗎", [], { role: "assistant", timestamp: row.timestamp!, text: row.content });
    for (let i = 0; i < 2; i++) {
      await engineA.sync();
      await engineB.sync();
    }
    // 兩台同一時間記的：留下哪一份由 sync_id 決定，順序不一定
    for (const d of [a, b]) {
      expect((await d.db.getMemories()).map((m) => [m.content, m.source]).sort()).toEqual([
        ["週三晚上不能練", "user"],
        ["鞋子跑到 600 公里要換", "coach"],
      ].sort());
    }
    expect((await b.db.getRecentConversations(10)).at(-1)?.reply_to).toEqual({ role: "assistant", timestamp: row.timestamp, text: "週四的節奏跑" });

    clock = new Date(clock.getTime() + 60_000);
    await a.db.updateMemory(shoes, "鞋子跑到 700 公里要換");
    const onB = (await b.db.getMemories()).find((m) => m.content === "週三晚上不能練")!;
    await b.db.deleteMemory(onB.id);
    for (let i = 0; i < 2; i++) {
      await engineA.sync();
      await engineB.sync();
    }
    for (const d of [a, b]) expect((await d.db.getMemories()).map((m) => m.content)).toEqual(["鞋子跑到 700 公里要換"]);
  });

  it("伺服器只存加密後的資料；調換紀錄會被發現；別的金鑰進不來", async () => {
    const root = newRootKey();
    const a = await device();
    await a.db.setProfileKey("notes", "右膝曾經受傷");
    await a.db.setProfileKey("goal", "全馬");
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    await engineA.ensureSpace();
    await engineA.sync();

    const rows = await serverDriver.all("SELECT id, blob FROM records");
    const dump = JSON.stringify(rows) + JSON.stringify(await serverDriver.all("SELECT * FROM spaces"));
    expect(dump).not.toContain("膝");
    expect(dump).not.toContain("notes");
    expect(dump).not.toContain("goal");

    // 伺服器把兩筆的內容互換
    const [x, y] = rows;
    await serverDriver.run("UPDATE records SET blob=? WHERE id=?", [y!.blob ?? null, x!.id ?? null]);
    await serverDriver.run("UPDATE records SET blob=? WHERE id=?", [x!.blob ?? null, y!.id ?? null]);
    const b = await device();
    await expect(new SyncEngine(b.db, api, root, () => clock).sync()).rejects.toThrow();

    // 別的同步金鑰：自己一個空間，看不到這裡的資料
    const c = await device();
    const engineC = new SyncEngine(c.db, api, newRootKey(), () => clock);
    await engineC.ensureSpace();
    expect(await engineC.sync()).toMatchObject({ received: 0 });
    expect(await c.db.getProfile()).toEqual({});
  });

  it("刪除雲端的資料：這台的資料不動，同步狀態清掉", async () => {
    const root = newRootKey();
    const a = await device();
    await a.db.setProfileKey("goal", "全馬");
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    await engineA.ensureSpace();
    const b = await device();
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.sync();
    await engineB.sync();
    await engineA.deleteRemote();
    expect(await serverDriver.all("SELECT * FROM records")).toEqual([]);
    expect((await a.db.getProfile()).goal).toBe("全馬");

    // 另一台：同步失敗，而且記住了。之後即使有人用同一把金鑰把空間建回來，也不再送出資料
    await expect(engineB.sync()).rejects.toMatchObject({ status: 404 });
    await new SyncEngine(a.db, api, root, () => clock).ensureSpace();
    await b.db.setProfileKey("notes", "被偷之後的新資料");
    await expect(new SyncEngine(b.db, api, root, () => clock).sync()).rejects.toMatchObject({ status: 404 });
    expect(await serverDriver.all("SELECT * FROM records")).toEqual([]);
    // 在那台停止同步之後才能重新加入
    await engineB.forget();
    expect(await new SyncEngine(b.db, api, root, () => clock).sync()).toMatchObject({ sent: 2 });

    // 開始同步的第一台以外，空間不存在時不會建立
    const c = await device();
    await expect(new SyncEngine(c.db, api, newRootKey(), () => clock).sync()).rejects.toMatchObject({ status: 404 });
  });

  it("另一台分析過的跑步：同步 Intervals.icu 時直接用，不再呼叫模型", async () => {
    const root = newRootKey();
    const a = await device();
    const w = await a.db.saveWorkout(run("i9", "2026-10-21"), 5, null);
    await a.db.saveWorkoutSummary(w, "A 的分析");
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    await engineA.ensureSpace();
    await engineA.sync();

    let calls = 0;
    const provider: LlmProvider = {
      effortFor: () => null,
      startChat: () => ({
        next: async () => {
          calls++;
          throw new Error("不該呼叫");
        },
      }),
    };
    const coach = new Coach({
      driver: openNodeSqlite(":memory:"),
      llm: { provider, models: { chat: "m", summary: "m", compress: "m" }, chatEffort: "medium" },
      activities: { fetchLatestActivity: async () => null, fetchActivities: async () => [run("i9", "2026-10-21")] },
      now: () => clock,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    await coach.init();
    await new SyncEngine(coach.db, api, root, () => clock).sync();
    await coach.sync();
    expect(calls).toBe(0);
    expect((await coach.db.getRecentWorkouts(30))[0]?.summary).toBe("A 的分析");
  });

  it("伺服器把某一筆換回之前的版本：會被發現，不會套用", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    await a.db.setProfileKey("goal", "半馬");
    await engineA.sync();
    await engineB.sync();
    const [old] = await serverDriver.all("SELECT id, blob FROM records");

    await a.db.setProfileKey("goal", "全馬");
    await engineA.sync();
    await engineB.sync();
    expect((await b.db.getProfile()).goal).toBe("全馬");

    // 伺服器把舊的加密內容當成新的一版送出（序號變大，內容是之前的）
    await serverDriver.run("UPDATE records SET blob=?, seq=seq+10 WHERE id=?", [old!.blob ?? null, old!.id ?? null]);
    await expect(engineB.sync()).rejects.toThrow(/更舊/);
    expect((await b.db.getProfile()).goal).toBe("全馬");
  });

  it("這個版本不認得的種類、還在暫存的：不會被當成刪除送出", async () => {
    const root = newRootKey();
    const a = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    await engineA.ensureSpace();
    // 新版本才有的種類（直接放到伺服器上）
    const keys = await deriveKeys(root);
    const id = await recordId(keys, "zz:future");
    await api.request("POST", `/v1/spaces/${keys.space}/changes`, { items: [{ id, base: 0, blob: await seal(keys, id, { k: "zz:future", v: 1, m: "2026-10-22T00:00:00Z", d: { x: 1 } }) }] }, keys.token);
    // 課表還沒到的課（課表不在伺服器上）
    const sessionName = "ps:0123456789abcdef0123456789abcdef";
    const sid = await recordId(keys, sessionName);
    const session = { plan: "fedcba9876543210fedcba9876543210", position: 0, date: "2026-10-23", kind: "easy", title: "輕鬆跑", steps: "[]", purpose: null, success: null, fallback: null, status: null, note: null, updated_at: "2026-10-22T00:00:00Z" };
    await api.request("POST", `/v1/spaces/${keys.space}/changes`, { items: [{ id: sid, base: 0, blob: await seal(keys, sid, { k: sessionName, v: 1, m: "2026-10-22T00:00:00Z", d: session }) }] }, keys.token);

    await engineA.sync();
    await a.db.setProfileKey("goal", "全馬");
    expect(await engineA.sync()).toMatchObject({ sent: 1 });
    const rows = await serverDriver.all("SELECT id, seq FROM records WHERE id IN (?, ?)", [id, sid]);
    expect(rows.map((r) => Number(r.seq)).sort()).toEqual([1, 2]);
  });

  it("換了一組同步金鑰：舊的同步狀態不沿用，資料全部送到新的空間", async () => {
    const a = await device();
    await a.db.setProfileKey("goal", "全馬");
    const first = new SyncEngine(a.db, api, newRootKey(), () => clock);
    await first.ensureSpace();
    expect(await first.sync()).toMatchObject({ sent: 1 });
    // 沒有先停止同步就換了金鑰（例如清除設定後重新開始）
    const second = new SyncEngine(a.db, api, newRootKey(), () => clock);
    await second.ensureSpace();
    expect(await second.sync()).toMatchObject({ sent: 1 });
  });

  it("兩台原本各有同一份賽事與課表（例如之前匯出、匯入過）：加入同步後只留一份，課的狀態取最近更新的", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    for (const d of [a, b]) {
      await d.db.addRace({ name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:45:00" });
      await d.db.saveStructuredPlan(
        { weekLabel: "2026-W43", weekStart: "2026-10-19", style: "fixed", reason: "這週", outline: null, notes: null, content: "文字版" },
        [
          { date: "2026-10-20", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "恢復", success: "心率", fallback: null },
          { date: "2026-10-22", kind: "threshold", title: "節奏跑", steps: [{ duration_min: 30, target: { hr: "easy" } }], purpose: "乳酸閾值", success: "配速", fallback: null },
        ],
      );
      clock = new Date(clock.getTime() + 1000);
    }
    // B 把第一堂課標成跳過（比較新）
    const planB = (await b.db.getActiveTrainingPlan())!;
    const firstB = (await b.db.getPlannedSessions(planB.id))[0]!;
    clock = new Date(clock.getTime() + 60_000);
    await b.db.updatePlannedSession(firstB.id, { status: "skipped" });

    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    for (let i = 0; i < 3; i++) {
      await engineA.sync();
      await engineB.sync();
    }
    for (const d of [a, b]) {
      expect((await d.db.getAllRaces()).map((r) => r.name)).toEqual(["台北馬"]);
      const active = (await d.db.getActiveTrainingPlan())!;
      expect((await d.db.getPlannedSessions(active.id)).map((s) => [s.title, s.status])).toEqual([
        ["輕鬆跑", "skipped"],
        ["節奏跑", "planned"],
      ]);
    }
    expect(await engineA.sync()).toMatchObject({ received: 0, sent: 0 });
    expect(await engineB.sync()).toMatchObject({ received: 0, sent: 0 });
  });

  it("對話依時間排序：另一台較早的對話後來才同步進來，不會蓋過這台新的訊息；壓縮依時間刪除", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    // B（手機）有較早的對話
    await b.db.appendConversation("user", "手機上的舊問題");
    clock = new Date(clock.getTime() + 60_000);
    await b.db.appendConversation("assistant", "手機上的舊回答");
    clock = new Date(clock.getTime() + 60_000);
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    await engineA.ensureSpace();
    await engineB.sync();
    // A（電腦）在還沒取回 B 的對話前，先寫了新的訊息
    await a.db.appendConversation("user", "電腦上的新問題");
    clock = new Date(clock.getTime() + 60_000);
    await a.db.appendConversation("assistant", "電腦上的新回答");
    await engineA.sync();
    await engineB.sync();
    const order = ["手機上的舊問題", "手機上的舊回答", "電腦上的新問題", "電腦上的新回答"];
    for (const d of [a, b]) {
      expect((await d.db.getRecentConversations(10)).map((c) => c.content)).toEqual(order);
      expect((await d.db.getMemorySnapshot(2)).conversations.map((c) => c.content)).toEqual(order.slice(2));
    }
    // A 壓縮最早的兩則：依時間刪除，不是依這台的 id
    const oldest = await a.db.getOldestConversations(2);
    expect(oldest.map((c) => c.content)).toEqual(order.slice(0, 2));
    await a.db.applyCompression("摘要", oldest.at(-1)!.id);
    expect((await a.db.getRecentConversations(10)).map((c) => c.content)).toEqual(order.slice(2));
    await engineA.sync();
    await engineB.sync();
    expect((await b.db.getRecentConversations(10)).map((c) => c.content)).toEqual(order.slice(2));
  });
});
