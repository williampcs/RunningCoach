/** 不分來源的紀錄（規格 12.37）：轉換、Db.getActivities、舊版資料庫照開 */
import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { Db, detailsOf, recordOfOther, recordOfWorkout, type SqlDriver, type Workout } from "../src";
import { activity, NOW } from "./helpers";

const clock = { now: () => NOW, today: () => "2026-10-10" };

async function freshDb() {
  const driver = openNodeSqlite(":memory:");
  const db = new Db(driver, clock);
  await db.init();
  return { db, driver };
}

const intervalsRun = {
  id: "i100",
  start_date_local: "2026-10-10T07:12:00",
  start_date: "2026-10-09T23:12:00Z",
  elapsed_time: 3400,
  moving_time: 3306,
  icu_hr_zone_times: [600, 1800, 600, 200, 100],
  icu_hr_zones: [130, 150, 165, 175, 185],
  lthr: 168,
  icu_training_load: 72,
  icu_ctl: 41.2,
  icu_atl: 55.8,
  max_heartrate: 171,
  total_elevation_gain: 48,
  average_temp: 29,
};

describe("detailsOf：來源的原始資料只在這裡解讀", () => {
  it("Intervals.icu 的跑步", () => {
    expect(detailsOf(JSON.stringify(intervalsRun))).toMatchObject({
      startLocal: "2026-10-10T07:12:00",
      startUtc: "2026-10-09T23:12:00Z",
      elapsedSec: 3400,
      movingSec: 3306,
      hrZoneTimes: [600, 1800, 600, 200, 100],
      hrZones: [130, 150, 165, 175, 185],
      lthr: 168,
      load: 72,
      ctl: 41.2,
      atl: 55.8,
      maxHr: 171,
      elevationM: 48,
      avgTempC: 29,
      watts: null,
      powerZoneTimes: null,
    });
  });

  it("騎車的功率：icu_ 優先，沒有時用裝置的；功率區間", () => {
    const d = detailsOf(
      JSON.stringify({ average_watts: 150, weighted_average_watts: 170, icu_average_watts: 160, icu_eftp: 212, average_cadence: 88, icu_zone_times: [{ id: "Z1", secs: 600 }, { id: "SS", secs: 60 }] }),
    );
    expect(d).toMatchObject({ watts: 160, normalizedWatts: 170, eftp: 212, cadence: 88, powerZoneTimes: [{ id: "Z1", secs: 600 }, { id: "SS", secs: 60 }] });
  });

  it("沒有、壞掉、不是物件的原始資料：每一項都是 null（是否經 Garmin Connect 是 false）", () => {
    for (const raw of [null, undefined, "", "not json", "[1,2]", "42"]) {
      const { garminConnect, ...rest } = detailsOf(raw);
      expect(Object.values(rest).every((v) => v === null)).toBe(true);
      expect(garminConnect).toBe(false);
    }
  });

  it("型別不對的欄位不收：區間時間有字串、時間是 0", () => {
    const d = detailsOf(JSON.stringify({ icu_hr_zone_times: [1, "2"], elapsed_time: 0, moving_time: -5, lthr: "168" }));
    expect(d).toMatchObject({ hrZoneTimes: null, elapsedSec: null, movingSec: null, lthr: null });
  });
});

describe("轉換成不分來源的紀錄", () => {
  const workout = (partial: Partial<Workout>): Workout => ({
    id: 1,
    intervals_id: null,
    strava_id: null,
    date: "2026-10-10",
    type: "run",
    distance_km: 5,
    duration_min: 30,
    avg_hr: null,
    max_hr: null,
    avg_pace: "6:00/km",
    elevation_m: null,
    calories: null,
    training_load: null,
    perceived_effort: 3,
    subjective_notes: "輕鬆",
    source: "manual",
    synced_at: "x",
    ...partial,
  });

  it("手動記的跑步", () => {
    expect(recordOfWorkout(workout({ id: 7 }))).toMatchObject({
      key: "w:7",
      workoutId: 7,
      intervalsId: null,
      sport: "run",
      source: "manual",
      distance_km: 5,
      perceived_effort: 3,
      training_load: null,
      details: { startLocal: null, load: null },
    });
  });

  it("Intervals.icu 的跑步：來源沒寫時依 intervals_id 判斷", () => {
    const r = recordOfWorkout(workout({ id: 8, intervals_id: "i100", source: null, training_load: 72, raw_json: JSON.stringify(intervalsRun) }));
    expect(r).toMatchObject({ key: "w:8", intervalsId: "i100", source: "intervals", training_load: 72, details: { load: 72, lthr: 168 } });
    expect(recordOfWorkout(workout({ source: "strava", strava_id: "s1" })).source).toBe("strava");
    expect(recordOfWorkout(workout({ source: "fake", intervals_id: "fake-1" })).source).toBe("fake");
  });

  it("其他運動：運動依類型、最高心率與爬升從原始資料來", () => {
    const r = recordOfOther({
      intervals_id: "i9",
      date: "2026-10-09",
      type: "VirtualRide",
      duration_min: 60,
      distance_km: 30,
      avg_hr: 130,
      training_load: 55,
      raw_json: JSON.stringify({ max_heartrate: 160, total_elevation_gain: 300 }),
      perceived_effort: 5,
      subjective_notes: null,
      summary: "分析",
    });
    expect(r).toMatchObject({ key: "o:i9", workoutId: null, sport: "ride", type: "VirtualRide", source: "intervals", max_hr: 160, elevation_m: 300, perceived_effort: 5, summary: "分析" });
  });
});

describe("Db.getActivities", () => {
  it("跑步與其他運動合在一起、新的在前；不含重複與已移除的；可以只取某些運動", async () => {
    const { db } = await freshDb();
    await db.saveWorkout(activity({ intervals_id: "a", date: "2026-10-08", raw_json: JSON.stringify({ start_date_local: "2026-10-08T07:00:00", elapsed_time: 3000 }) }));
    // 同一趟從另一個來源進來：時間重疊，標成重複
    await db.saveWorkout(activity({ intervals_id: "b", date: "2026-10-08", avg_hr: null, training_load: null, raw_json: JSON.stringify({ start_date_local: "2026-10-08T07:01:00", elapsed_time: 2900 }) }));
    await db.addManualWorkout({ date: "2026-10-10", distance_km: 5, duration_min: 32, avg_hr: null, perceived_effort: 3, subjective_notes: null });
    await db.upsertOtherActivities([
      { intervals_id: "r1", date: "2026-10-09", type: "Ride", duration_min: 60, distance_km: 25, avg_hr: 125, training_load: 40, raw_json: null },
      { intervals_id: "w1", date: "2026-10-01", type: "WeightTraining", duration_min: 40, distance_km: null, avg_hr: null, training_load: 20, raw_json: null },
      { intervals_id: "old", date: "2026-08-01", type: "Ride", duration_min: 60, distance_km: 25, avg_hr: null, training_load: 30, raw_json: null },
    ]);
    await db.setActivityFeedback("r1", 4, "順");

    const all = await db.getActivities(14);
    expect(all.map((a) => [a.date, a.sport, a.source])).toEqual([
      ["2026-10-10", "run", "manual"],
      ["2026-10-09", "ride", "intervals"],
      ["2026-10-08", "run", "intervals"],
      ["2026-10-01", "strength", "intervals"],
    ]);
    expect(all.find((a) => a.key === "o:r1")).toMatchObject({ perceived_effort: 4, subjective_notes: "順" });
    expect((await db.getActivities(14, { sports: ["ride"] })).map((a) => a.key)).toEqual(["o:r1"]);
    expect((await db.getActivities(14, { sports: ["run"] })).map((a) => a.source)).toEqual(["manual", "intervals"]);
  });
});

/** 現在的資料庫，退回 schema 18（沒有手動記的跑步的 sync_id、updated_at） */
async function schema18(driver: SqlDriver) {
  await driver.exec(`
    DROP INDEX idx_workouts_sync_id;
    ALTER TABLE workouts DROP COLUMN sync_id;
    ALTER TABLE workouts DROP COLUMN updated_at;
    PRAGMA user_version = 18;
  `);
}

async function dump(driver: SqlDriver) {
  const tables = (await driver.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).map((r) => String(r.name));
  const out: Record<string, unknown[]> = {};
  for (const t of tables) out[t] = await driver.all(`SELECT * FROM ${t} ORDER BY rowid`);
  return out;
}

async function fill(db: Db, withManual: boolean) {
  await db.saveWorkout(activity({ intervals_id: "a", date: "2026-10-08", raw_json: JSON.stringify(intervalsRun) }), 4, "還好");
  await db.upsertOtherActivities([{ intervals_id: "r1", date: "2026-10-09", type: "Ride", duration_min: 60, distance_km: 25, avg_hr: 125, training_load: 40, raw_json: null }]);
  await db.setActivityFeedback("r1", 5, null);
  await db.addRace({ name: "秋季半馬", date: "2026-11-20", distance_km: 21.1, target_time: "1:55:00" });
  if (withManual) await db.addManualWorkout({ date: "2026-10-10", distance_km: 5, duration_min: 32, avg_hr: null, perceived_effort: 3, subjective_notes: null });
}

describe("舊版的資料庫照開（這一版沒有 schema 變更）", () => {
  it("schema 19：再開一次內容不變，紀錄讀得出來", async () => {
    const { db, driver } = await freshDb();
    await fill(db, true);
    const before = await dump(driver);
    const again = new Db(driver, clock);
    await again.init();
    expect(await dump(driver)).toEqual(before);
    expect((await again.getActivities(14)).map((a) => a.key)).toHaveLength(3);
  });

  it("schema 18：升級只補上 19 的欄位，原有的內容不變", async () => {
    const { db, driver } = await freshDb();
    await fill(db, false);
    await schema18(driver);
    const before = await dump(driver);
    const upgraded = new Db(driver, clock);
    await upgraded.init();
    const after = await dump(driver);
    expect(after.workouts).toEqual(before.workouts!.map((w) => ({ ...(w as object), sync_id: null, updated_at: null })));
    for (const t of Object.keys(before).filter((t) => t !== "workouts")) expect(after[t]).toEqual(before[t]);
    const [row] = await driver.all("PRAGMA user_version");
    expect(row?.user_version).toBe(20);
    expect((await upgraded.getActivities(14)).map((a) => [a.sport, a.perceived_effort])).toEqual([
      ["ride", 5],
      ["run", 4],
    ]);
  });

  it("只有跑步的舊資料（沒有其他運動的表）：升級後讀得出來", async () => {
    const driver = openNodeSqlite(":memory:");
    await driver.exec(`
      CREATE TABLE workouts (
        id INTEGER PRIMARY KEY AUTOINCREMENT, strava_id TEXT UNIQUE, date TEXT NOT NULL,
        type TEXT DEFAULT 'run', distance_km REAL, duration_min REAL, avg_hr INTEGER, max_hr INTEGER,
        avg_pace TEXT, elevation_m REAL, calories INTEGER, perceived_effort INTEGER,
        subjective_notes TEXT, laps_json TEXT, streams_json TEXT, raw_json TEXT,
        source TEXT DEFAULT 'strava', synced_at TEXT NOT NULL);
      INSERT INTO workouts (strava_id, date, distance_km, duration_min, avg_hr, raw_json, synced_at)
        VALUES ('s1', '2026-10-05', 8, 45, 148, '{"icu_training_load": 55, "start_date_local": "2026-10-05T06:30:00"}', 'x');
    `);
    const db = new Db(driver, clock);
    await db.init();
    const [run] = await db.getActivities(14);
    expect(run).toMatchObject({ source: "strava", sport: "run", training_load: 55, avg_hr: 148, details: { startLocal: "2026-10-05T06:30:00" } });
  });

  it("升級失敗時整個退回：原本的資料不受影響", async () => {
    const { db, driver } = await freshDb();
    await fill(db, false);
    await schema18(driver);
    const before = await dump(driver);
    // 升級進行到最後一步（寫入版本號）時失敗
    const failing: SqlDriver = {
      all: (q, p) => driver.all(q, p),
      run: (q, p) => driver.run(q, p),
      exec: async (q) => {
        if (q.startsWith("PRAGMA user_version")) throw new Error("disk I/O error");
        return driver.exec(q);
      },
    };
    await expect(new Db(failing, clock).init()).rejects.toThrow("disk I/O error");
    expect(await dump(driver)).toEqual(before);
    const [row] = await driver.all("PRAGMA user_version");
    expect(row?.user_version).toBe(18);
  });
});
