import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { Db } from "../src";
import { activity, NOW } from "./helpers";

const clock = { now: () => NOW, today: () => "2026-10-10" };

async function freshDb() {
  const driver = openNodeSqlite(":memory:");
  const db = new Db(driver, clock);
  await db.init();
  return { db, driver };
}

describe("Db", () => {
  it("init 可重複執行", async () => {
    const { db, driver } = await freshDb();
    await db.init();
    const [row] = await driver.all("PRAGMA user_version");
    expect(row?.user_version).toBe(8);
  });

  it("schema 2 → 3：恢復資料補上 Apple 的 HRV（SDNN）欄位，保留原有資料", async () => {
    const driver = openNodeSqlite(":memory:");
    await driver.exec(`
      CREATE TABLE wellness (
        date TEXT PRIMARY KEY, resting_hr INTEGER, hrv REAL, sleep_secs INTEGER, sleep_score INTEGER,
        readiness INTEGER, raw_json TEXT, synced_at TEXT NOT NULL);
      INSERT INTO wellness (date, resting_hr, hrv, synced_at) VALUES ('2026-10-10', 52, 61, 'x');
      PRAGMA user_version = 2;
    `);
    const db = new Db(driver, clock);
    await db.init();
    await db.upsertWellness([
      { date: "2026-10-09", resting_hr: 55, hrv: null, hrv_sdnn: 48, sleep_secs: null, sleep_score: null, readiness: null },
    ]);
    expect(await db.getWellness(7)).toEqual([
      expect.objectContaining({ date: "2026-10-09", hrv: null, hrv_sdnn: 48 }),
      expect.objectContaining({ date: "2026-10-10", hrv: 61, hrv_sdnn: null }),
    ]);
  });

  it("升級最早期的 v1 資料庫：補上欄位並從 raw_json 回填訓練負荷", async () => {
    const driver = openNodeSqlite(":memory:");
    await driver.exec(`
      CREATE TABLE races (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, date TEXT NOT NULL,
        distance_km REAL NOT NULL, target_time TEXT, confirmed INTEGER DEFAULT 1,
        result_time TEXT, notes TEXT, created_at TEXT NOT NULL);
      CREATE TABLE workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, strava_id TEXT UNIQUE, date TEXT NOT NULL,
        type TEXT DEFAULT 'run', distance_km REAL, duration_min REAL, avg_hr INTEGER, max_hr INTEGER,
        avg_pace TEXT, elevation_m REAL, calories INTEGER, perceived_effort INTEGER,
        subjective_notes TEXT, laps_json TEXT, streams_json TEXT, raw_json TEXT,
        source TEXT DEFAULT 'strava', synced_at TEXT NOT NULL);
      INSERT INTO races (name, date, distance_km, created_at) VALUES ('舊賽事', '2026-11-01', 21.1, 'x');
      INSERT INTO workouts (strava_id, date, raw_json, synced_at)
        VALUES ('s1', '2026-10-01', '{"icu_training_load": 55}', 'x'), ('s2', '2026-10-02', 'not json', 'x');
    `);
    const db = new Db(driver, clock);
    await db.init();

    expect((await db.getUpcomingRaces(90)).map((r) => [r.name, r.cancelled])).toEqual([["舊賽事", 0]]);
    const loads = await driver.all("SELECT strava_id, training_load, intervals_id FROM workouts ORDER BY id");
    expect(loads).toEqual([
      { strava_id: "s1", training_load: 55, intervals_id: null },
      { strava_id: "s2", training_load: null, intervals_id: null },
    ]);
  });

  it("賽事：近期清單、待補登成績、取消與部分更新", async () => {
    const { db } = await freshDb();
    const soon = await db.addRace({ name: "半馬", date: "2026-11-01", distance_km: 21.1, target_time: "1:58:00" });
    await db.addRace({ name: "太遠", date: "2027-06-01", distance_km: 42.195 });
    const past = await db.addRace({ name: "上週 10K", date: "2026-10-04", distance_km: 10 });
    await db.addRace({ name: "太久以前", date: "2026-09-01", distance_km: 10 });
    const today = await db.addRace({ name: "今天的比賽", date: "2026-10-10", distance_km: 5 });

    expect((await db.getUpcomingRaces(90)).map((r) => r.id)).toEqual([today, soon]);
    expect((await db.getPastRacesWithoutResult(14)).map((r) => r.id)).toEqual([past]);

    await db.updateRaceResult(past, "48:30", "");
    expect(await db.getPastRacesWithoutResult(14)).toEqual([]);

    await db.updateRace(soon, { target_time: "1:55:00", notes: null });
    await db.cancelRace(today, "感冒");
    const races = await db.getUpcomingRaces(90);
    expect(races).toHaveLength(1);
    expect(races[0]).toMatchObject({ id: soon, target_time: "1:55:00", name: "半馬", notes: null });
  });

  it("saveWorkout：同一活動只存一筆，再次儲存時補上主觀感受但不覆蓋成空值", async () => {
    const { db, driver } = await freshDb();
    const id1 = await db.saveWorkout(activity({ training_load: null }));
    const id2 = await db.saveWorkout(activity({ training_load: 72 }), 7, "腿有點重");
    const id3 = await db.saveWorkout(activity({ training_load: null }), null, null);
    expect([id2, id3]).toEqual([id1, id1]);

    const rows = await driver.all("SELECT perceived_effort, subjective_notes, training_load, source FROM workouts");
    expect(rows).toEqual([
      { perceived_effort: 7, subjective_notes: "腿有點重", training_load: 72, source: "intervals" },
    ]);
  });

  it("同一筆訓練有多筆摘要時只列一次，附最新的摘要", async () => {
    const { db } = await freshDb();
    const first = await db.saveWorkout(activity({ intervals_id: "a", date: "2026-10-10" }));
    await db.saveWorkoutSummary(first, "第一次的摘要");
    await db.saveWorkoutSummary(first, "重新回報後的摘要");
    await db.saveWorkout(activity({ intervals_id: "b", date: "2026-10-08" }));

    expect((await db.getRecentWorkouts(14)).map((w) => [w.intervals_id, w.summary])).toEqual([
      ["a", "重新回報後的摘要"],
      ["b", null],
    ]);
  });

  it("訓練計畫只有最新一筆啟用", async () => {
    const { db } = await freshDb();
    await db.saveTrainingPlan("2026-W40", "舊計畫");
    await db.saveTrainingPlan("2026-W41", "新計畫");
    expect(await db.getActiveTrainingPlan()).toMatchObject({ week_label: "2026-W41", content: "新計畫" });
  });

  it("applyCompression：只留最新摘要，並刪除已涵蓋的對話", async () => {
    const { db } = await freshDb();
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await db.appendConversation(i % 2 ? "assistant" : "user", `m${i}`));
    await db.applyCompression("摘要一", ids[1]!);
    await db.applyCompression("摘要二", ids[2]!);

    expect((await db.getLatestSummary())?.content).toBe("摘要二");
    expect((await db.getRecentConversations(10)).map((r) => r.content)).toEqual(["m3", "m4"]);
  });

  it("交易失敗時回復，且不影響之後的操作", async () => {
    const { db, driver } = await freshDb();
    await db.saveTrainingPlan("2026-W40", "原計畫");
    // content 為 NOT NULL，違反限制時整筆交易（含停用舊計畫）應回復
    await expect(db.saveTrainingPlan("2026-W41", null as unknown as string)).rejects.toThrow();
    expect(await db.getActiveTrainingPlan()).toMatchObject({ week_label: "2026-W40" });
    expect(await driver.all("SELECT COUNT(*) AS n FROM training_plans")).toEqual([{ n: 1 }]);
  });

  it("並行呼叫不會落進別人的交易", async () => {
    const { db } = await freshDb();
    await Promise.all([
      db.saveTrainingPlan("2026-W41", "計畫"),
      db.appendConversation("user", "a"),
      db.saveWorkout(activity()),
      db.appendConversation("assistant", "b"),
      db.setProfileKey("max_hr", "185"),
    ]);
    expect(await db.countConversations()).toBe(2);
    expect(await db.countWorkouts()).toBe(1);
    expect(await db.getProfile()).toEqual({ max_hr: "185" });
  });
});
