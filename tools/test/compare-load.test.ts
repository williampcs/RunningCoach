import { describe, expect, it } from "vitest";

import { compareActivityOf, compareLoads, reportText } from "../compare-load";
import { addDays, fitnessSeries, type LoadContext } from "../../packages/core/src";

const TODAY = "2026-10-10";
const ctx: LoadContext = { hr: { run: { maxHr: 190, lthr: 170 } }, restHr: 50, thresholdPaceSec: 270 };

describe("compare-load", () => {
  it("reads an Intervals.icu activity", () => {
    expect(
      compareActivityOf({ start_date_local: "2026-10-09T07:00:00", moving_time: 3600, distance: 12000, average_heartrate: 150, icu_rpe: 4, icu_training_load: 60, type: "Run" }),
    ).toEqual({ date: "2026-10-09", sport: "run", minutes: 60, km: 12, avgHr: 150, rpe: 4, icuLoad: 60 });
    expect(compareActivityOf({ type: "Run" })).toBeNull();
    expect(compareActivityOf({ start_date_local: "2026-10-09T07:00:00", elapsed_time: 1800, type: "Ride", perceived_exertion: 12 })?.rpe).toBeNull();
  });

  it("compares per method, per RPE and fitness", () => {
    const activities = [] as ReturnType<typeof compareActivityOf>[];
    const daily = new Map<string, number>();
    for (let i = 0; i < 120; i += 2) {
      const date = addDays(TODAY, -i);
      activities.push({ date, sport: "run", minutes: 60, km: 10, avgHr: null, rpe: 4, icuLoad: 50 });
      daily.set(date, 50);
    }
    // Intervals.icu 的 CTL、ATL：和我們同一個模型算的，mixed 的差應該是 0
    const wellness = fitnessSeries(daily, addDays(TODAY, -180), TODAY).map((p) => ({ date: p.date, ctl: p.ctl, atl: p.atl, restingHr: null }));
    const result = compareLoads({ today: TODAY, days: 180, activities: activities.filter((a) => a !== null), wellness, ctx });
    expect(result.byMethod.hr).toEqual({});
    expect(result.byMethod.pace.run).toMatchObject({ n: 60, medianDiff: 56 - 50 });
    expect(result.byRpe).toEqual([expect.objectContaining({ rpe: 4, n: 60, table: 0.7, medianDiff: -1 })]);
    expect(result.byRpe[0]!.icuIf).toBeCloseTo(Math.sqrt(0.5), 6);
    expect(result.fitness.mixed.ctlMae).toBeCloseTo(0, 6);
    expect(result.fitness.mixed.days).toBe(91);
    // 我們估的用配速（56）比 Intervals.icu 的（50）高：體能也比較高
    expect(result.fitness.ours.last!.ctl).toBeGreaterThan(result.fitness.ours.last!.icuCtl!);
    const text = reportText(result, ctx);
    expect(text).toContain("依體感分組");
    expect(text).toContain("體感  4  n=60");
  });
});
