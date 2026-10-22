import { beforeEach, describe, expect, it } from "vitest";

import { Coach, Db, newRootKey, SyncApi, SyncEngine, type Activity, type LlmProvider } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

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

    // 沒有變更時不重送，也不重複套用
    expect(await engineB.sync()).toMatchObject({ received: 0, sent: 0 });
    expect(await engineA.sync()).toMatchObject({ received: 0, sent: 0 });

    // 那趟跑步同步到 B 之後，暫存的「不是同一趟」就套用
    const bw3 = await b.db.saveWorkout(run("i3", "2026-10-21", { raw_json: JSON.stringify({ id: "i3", start_date_local: "2026-10-21T18:00:00" }) }));
    expect(await engineB.sync()).toMatchObject({ pending: 0, sent: 0 });
    const bw2 = (await b.db.getWorkoutByIntervalsId("i2"))!.id;
    expect((await b.db.getDistinctPairs()).has(`${Math.min(bw2, bw3)}-${Math.max(bw2, bw3)}`)).toBe(true);
  });

  it("修改與刪除帶到另一台；同一筆兩台都改時，時間新的為準", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
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

  it("對話壓縮後，舊的對話在另一台也刪掉、摘要帶過去", async () => {
    const root = newRootKey();
    const a = await device();
    const b = await device();
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    const engineB = new SyncEngine(b.db, api, root, () => clock);
    const ids = [];
    for (let i = 0; i < 4; i++) ids.push(await a.db.appendConversation(i % 2 ? "assistant" : "user", `第 ${i} 則`));
    await engineA.sync();
    await engineB.sync();
    expect(await b.db.countConversations()).toBe(4);
    await a.db.applyCompression("選手狀態摘要", ids[1]!);
    await engineA.sync();
    await engineB.sync();
    expect((await b.db.getRecentConversations(10)).map((c) => c.content)).toEqual(["第 2 則", "第 3 則"]);
    expect((await b.db.getLatestSummary())?.content).toBe("選手狀態摘要");
  });

  it("伺服器只存加密後的資料；調換紀錄會被發現；別的金鑰進不來", async () => {
    const root = newRootKey();
    const a = await device();
    await a.db.setProfileKey("notes", "右膝曾經受傷");
    await a.db.setProfileKey("goal", "全馬");
    const engineA = new SyncEngine(a.db, api, root, () => clock);
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
    expect(await new SyncEngine(c.db, api, newRootKey(), () => clock).sync()).toMatchObject({ received: 0 });
    expect(await c.db.getProfile()).toEqual({});
  });

  it("刪除雲端的資料：這台的資料不動，同步狀態清掉", async () => {
    const root = newRootKey();
    const a = await device();
    await a.db.setProfileKey("goal", "全馬");
    const engineA = new SyncEngine(a.db, api, root, () => clock);
    await engineA.sync();
    await engineA.deleteRemote();
    expect(await serverDriver.all("SELECT * FROM records")).toEqual([]);
    expect((await a.db.getProfile()).goal).toBe("全馬");
    // 再開始同步：重新建立空間並送出全部
    const again = new SyncEngine(a.db, api, root, () => clock);
    expect(await again.sync()).toMatchObject({ sent: 1 });
  });

  it("另一台分析過的跑步：同步 Intervals.icu 時直接用，不再呼叫模型", async () => {
    const root = newRootKey();
    const a = await device();
    const w = await a.db.saveWorkout(run("i9", "2026-10-21"), 5, null);
    await a.db.saveWorkoutSummary(w, "A 的分析");
    await new SyncEngine(a.db, api, root, () => clock).sync();

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
});
