/** 負荷與體能、疲勞：我們自己算的（load.ts，規格 12.37） */
import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import {
  addDays,
  computeTrainingValues,
  Db,
  estimatedFitness,
  estimateLoad,
  fitnessSeries,
  formatTrainingValues,
  hrLoad,
  loadContextOf,
  loadOf,
  loadText,
  paceLoad,
  rpeLoad,
  type LoadContext,
} from "../src";
import { activity, NOW } from "./helpers";

const TODAY = "2026-10-10";
const clock = { now: () => NOW, today: () => TODAY };

async function freshDb() {
  const db = new Db(openNodeSqlite(":memory:"), clock);
  await db.init();
  return db;
}

const ctx: LoadContext = { hr: { run: { maxHr: 190, lthr: 170 } }, restHr: 50, thresholdPaceSec: 270 };

describe("每一趟的負荷", () => {
  it("心率：閾值心率做 60 分鐘 = 100；越低越少；只知道最大心率時閾值當成 89%", () => {
    expect(hrLoad(60, 170, { maxHr: 190, lthr: 170 }, 50)).toBe(100);
    expect(hrLoad(30, 170, { maxHr: 190, lthr: 170 }, 50)).toBe(50);
    const easy = hrLoad(60, 140, { maxHr: 190, lthr: 170 }, 50)!;
    expect(easy).toBeGreaterThan(40);
    expect(easy).toBeLessThan(65);
    expect(hrLoad(60, 169, { maxHr: 190, lthr: null }, 50)).toBe(100);
    expect(hrLoad(60, 170, { maxHr: null, lthr: 170 }, 50)).toBe(100);
    // 低於靜止心率算 0，不會是負的
    expect(hrLoad(60, 40, { maxHr: 190, lthr: 170 }, 50)).toBe(0);
  });

  it("心率：沒有量到的依據時不估（不用 220 − 年齡）", () => {
    expect(hrLoad(60, 150, { maxHr: null, lthr: null }, 50)).toBeNull();
    expect(hrLoad(60, 150, { maxHr: 60, lthr: 55 }, 50)).toBeNull();
  });

  it("配速：閾值配速 60 分鐘 = 100；不合理的配速不算；IF 最多 1.3", () => {
    expect(paceLoad(60, 60 / 4.5, 270)).toBe(100);
    expect(paceLoad(30, 30 / 4.5, 270)).toBe(50);
    expect(paceLoad(60, 10, 270)).toBe(Math.round(0.75 * 0.75 * 100)); // 6:00/km
    expect(paceLoad(10, 10, 270)).toBeNull(); // 1:00/km
    expect(paceLoad(60, 2, 270)).toBeNull(); // 30:00/km
    expect(paceLoad(10, 10 / 2.1, 270)).toBe(Math.round((10 / 60) * 1.3 * 1.3 * 100));
  });

  it("體感：對照表（閾值在 7–8 附近）", () => {
    expect(rpeLoad(60, 3)).toBe(42);
    expect(rpeLoad(60, 5)).toBe(56);
    expect(rpeLoad(60, 7)).toBe(81);
    expect(rpeLoad(60, 8)).toBe(94);
    expect(rpeLoad(30, 10)).toBe(61);
    expect(rpeLoad(60, 0)).toBeNull();
    expect(rpeLoad(60, 11)).toBeNull();
  });

  it("順序：Intervals.icu 的 → 心率 → 配速（只有跑步）→ 體感", () => {
    const base = { duration_min: 60, distance_km: 12, avg_hr: 150, perceived_effort: 4, training_load: null };
    expect(loadOf({ ...base, training_load: 77 }, "run", ctx)).toEqual({ value: 77, source: "intervals" });
    expect(loadOf(base, "run", ctx)?.source).toBe("hr");
    expect(loadOf({ ...base, avg_hr: null }, "run", ctx)?.source).toBe("pace");
    expect(loadOf({ ...base, avg_hr: null }, "ride", ctx)?.source).toBe("rpe");
    expect(loadOf({ ...base, avg_hr: null, distance_km: null }, "run", ctx)).toEqual({ value: 49, source: "rpe" });
    expect(loadOf({ ...base, avg_hr: null, distance_km: null, perceived_effort: null }, "run", ctx)).toBeNull();
    expect(estimateLoad({ ...base, training_load: 77 }, "run", ctx)?.source).toBe("hr");
    expect(loadOf({ ...base, duration_min: 0 }, "run", ctx)).toBeNull();
  });

  it("騎車用騎車自己的心率設定，沒有時用跑步的", () => {
    const withRide: LoadContext = { ...ctx, hr: { ...ctx.hr, ride: { maxHr: 180, lthr: 160 } } };
    const ride = { duration_min: 60, avg_hr: 160, training_load: null };
    expect(loadOf(ride, "ride", withRide)).toEqual({ value: 100, source: "hr" });
    expect(loadOf(ride, "ride", ctx)!.value).toBeLessThan(100);
  });

  it("文字：Intervals.icu 的只寫數字；估的標來源", () => {
    expect(loadText({ value: 72, source: "intervals" })).toBe("72");
    expect(loadText({ value: 45, source: "rpe" })).toBe("45（依體感估）");
  });
});

describe("體能與疲勞", () => {
  it("指數平均：42 天與 7 天", () => {
    const one = fitnessSeries(new Map([["2026-10-01", 100]]), "2026-10-01", "2026-10-01");
    expect(one[0]!.ctl).toBeCloseTo(100 * (1 - Math.exp(-1 / 42)), 6);
    expect(one[0]!.atl).toBeCloseTo(100 * (1 - Math.exp(-1 / 7)), 6);
    const daily = new Map<string, number>();
    for (let i = 0; i <= 180; i++) daily.set(addDays(TODAY, -i), 50);
    const last = fitnessSeries(daily, addDays(TODAY, -180), TODAY).pop()!;
    expect(last.ctl).toBeCloseTo(50 * (1 - Math.exp(-181 / 42)), 6);
    expect(last.atl).toBeCloseTo(50, 3);
  });

  it("混合的來源：各來源的筆數、最早的日期、每週變化", () => {
    const items = [
      { date: "2026-10-09", sport: "run", duration_min: 40, avg_hr: null, perceived_effort: 3, training_load: null },
      { date: "2026-10-08", sport: "ride", duration_min: 60, avg_hr: null, perceived_effort: null, training_load: 50 },
      { date: "2026-10-01", sport: "strength", duration_min: 30, avg_hr: null, perceived_effort: null, training_load: null },
    ];
    const f = estimatedFitness(items, ctx, TODAY)!;
    expect(f).toMatchObject({ date: TODAY, source: "estimate", counts: { rpe: 1, intervals: 1, none: 1 }, since: "2026-10-08" });
    expect(f.ctl).toBeGreaterThan(0);
    expect(f.atl).toBeGreaterThan(f.ctl);
    expect(f.rampRate).toBeCloseTo(f.ctl, 6);
    expect(estimatedFitness([items[2]!], ctx, TODAY)).toBeNull();
  });
});

describe("估負荷的依據", () => {
  it("靜止心率是恢復資料的中位數；閾值配速先用 Intervals.icu 的設定，沒有時用 VDOT", () => {
    const vdot = { value: 50, kind: "profile" as const, distanceM: 5000, secs: 1200, date: null };
    const a = loadContextOf({ max_hr: "188" }, { lthr: 168, max_hr: 192, hr_zones: null, threshold_pace: 4 } as never, null, [{ resting_hr: 48 }, { resting_hr: 52 }, { resting_hr: 55 }], vdot);
    expect(a).toMatchObject({ restHr: 52, thresholdPaceSec: 250, hr: { run: { maxHr: 188, lthr: 168 } } });
    const b = loadContextOf({ birth_year: "1990" }, null, [{ types: ["Ride", "VirtualRide"], lthr: 155, max_hr: 180 } as never], [], vdot);
    expect(b.restHr).toBe(60);
    expect(b.hr.run).toEqual({ maxHr: null, lthr: null });
    expect(b.hr.ride).toEqual({ maxHr: 180, lthr: 155 });
    expect(b.thresholdPaceSec).toBeGreaterThan(200);
    expect(b.thresholdPaceSec).toBeLessThan(260);
  });
});

describe("用哪個值（訓練數值）", () => {
  it("沒有 Intervals.icu：負荷與體能疲勞由我們估，標明是估的", async () => {
    const db = await freshDb();
    for (let i = 1; i <= 20; i++) {
      await db.addManualWorkout({ date: addDays(TODAY, -i * 2), distance_km: 6, duration_min: 40, avg_hr: null, perceived_effort: 3, subjective_notes: null });
    }
    const v = await computeTrainingValues(db, TODAY);
    expect(v.fitness).toMatchObject({ source: "estimate", counts: { rpe: 20 } });
    expect(v.weeks.at(-2)).toMatchObject({ loadEstimated: true });
    expect(v.weeks.at(-2)!.load).toBeGreaterThan(0);
    const text = formatTrainingValues(v, {});
    expect(text).toContain("【體能與疲勞】我們估的");
    expect(text).toContain("依體感估 20 筆");
    expect(text).toContain("是估計值");
    expect(text).toContain("沒有的依心率、配速或體感估");
  });

  it("有 Intervals.icu：每週的負荷與體能疲勞照舊用它的", async () => {
    const db = await freshDb();
    await db.saveWorkout(activity({ intervals_id: "a", date: "2026-10-08", training_load: 72 }));
    await db.saveWorkout(activity({ intervals_id: "b", date: "2026-10-06", training_load: 40, raw_json: JSON.stringify({ start_date_local: "2026-10-06T06:00:00", elapsed_time: 3000 }) }));
    await db.upsertWellness([{ date: TODAY, resting_hr: 50, hrv: null, hrv_sdnn: null, sleep_secs: null, sleep_score: null, readiness: null, raw_json: JSON.stringify({ ctl: 45.5, atl: 60.1 }) }]);
    const v = await computeTrainingValues(db, TODAY);
    expect(v.fitness).toMatchObject({ source: "wellness", ctl: 45.5, atl: 60.1 });
    expect(v.weeks.at(-1)).toMatchObject({ load: 112, loadEstimated: false });
    const text = formatTrainingValues(v, {});
    expect(text).toContain("【體能與疲勞】Intervals.icu");
    expect(text).toContain("（負荷是 Intervals.icu 的訓練負荷");
  });

  it("什麼都沒有時：沒有負荷、沒有體能疲勞", async () => {
    const db = await freshDb();
    const v = await computeTrainingValues(db, TODAY);
    expect(v.fitness).toBeNull();
    expect(v.weeks.every((w) => w.load === null)).toBe(true);
  });
});
