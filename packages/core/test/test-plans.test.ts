import { describe, expect, it } from "vitest";

import { addDays, clearPastPlans, generateActivities, isoWeekLabel, pastPlanWeeks, recentAdherence, seedPastPlans, TEST_PLAN_REASON, type FakeSpec } from "../src";
import { makeCoach } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）；這週的週一是 10/5
const TODAY = "2026-10-10";

async function withRuns(runsPerWeek = 4) {
  const { coach } = await makeCoach();
  const spec: FakeSpec = { scenario: "steady", endDate: TODAY, weeks: 10, runsPerWeek, easyPaceSec: 345, maxHr: 188, seed: 1 };
  for (const a of generateActivities(spec)) await coach.db.saveWorkout(a);
  return coach;
}

describe("測試模式：塞進過去的課表（規格 12.38）", () => {
  it("6 週：每週一份、新的在前、不啟用（這週的課表不變）；結果有達成、部分、跳過、改用替代、沒做、自己改課與原因", async () => {
    const coach = await withRuns();
    const db = coach.db;
    // 這週已經有課表
    await db.saveStructuredPlan(
      { weekLabel: isoWeekLabel("2026-10-05"), weekStart: "2026-10-05", style: "fixed", reason: "這週", outline: null, notes: null, content: "" },
      [{ date: "2026-10-11", kind: "easy", title: "這週的輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "", success: "", fallback: null }],
    );
    const result = await seedPastPlans(db, TODAY, 6);
    expect(result.weeks).toBe(6);
    expect(result.sessions).toBeGreaterThan(18);

    expect((await db.getActiveTrainingPlan())!.reason).toBe("這週");
    const { weeks } = await pastPlanWeeks(db, TODAY, { multisport: false });
    expect(weeks.map((w) => w.weekStart)).toEqual([1, 2, 3, 4, 5, 6].map((k) => addDays("2026-10-05", -7 * k)));
    const outcomes = new Set(weeks.flatMap((w) => w.sessions.map((s) => s.outcome)));
    for (const o of ["achieved", "partial", "skipped", "fallback", "missed"]) expect(outcomes).toContain(o);
    const reasons = weeks.flatMap((w) => w.sessions.flatMap((s) => (s.selfChange ? [`${s.selfChange.action}:${s.selfChange.reason}`] : [])));
    expect(reasons.sort()).toEqual(["easy:time", "shorten:tired", "shorten:unwell"].sort());
    // 跳過與改用替代是選手自己按的
    expect(weeks.flatMap((w) => w.sessions).filter((s) => s.outcome === "skipped").every((s) => s.byAthlete)).toBe(true);

    // 教練的最近 4 週摘要
    const summary = await recentAdherence(db, TODAY, { multisport: false });
    expect(summary).toContain("【最近 4 週照課表的情形】");
    expect(summary).toContain("選手自己在課表頁跳過");
  });

  it("再塞一次會換掉之前塞的（不重複）；週數限制在 2–8；清掉只清塞進的，自己的課表不動", async () => {
    const coach = await withRuns(3);
    const db = coach.db;
    await seedPastPlans(db, TODAY, 6);
    expect((await seedPastPlans(db, TODAY, 20)).weeks).toBe(8);
    expect((await pastPlanWeeks(db, TODAY, { multisport: false })).weeks).toHaveLength(8);
    expect((await seedPastPlans(db, TODAY, 1)).weeks).toBe(2);
    expect((await pastPlanWeeks(db, TODAY, { multisport: false })).weeks).toHaveLength(2);

    // 選手自己的（不是塞進的）過去課表
    await db.saveStructuredPlan(
      { weekLabel: isoWeekLabel("2026-09-07"), weekStart: "2026-09-07", style: "fixed", reason: "自己的", outline: null, notes: null, content: "" },
      [{ date: "2026-09-08", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "", success: "", fallback: null }],
    );
    // 這週的課表（時間軸上那週不列在「之前的週」）
    await db.saveStructuredPlan(
      { weekLabel: isoWeekLabel("2026-10-05"), weekStart: "2026-10-05", style: "fixed", reason: "這週", outline: null, notes: null, content: "" },
      [{ date: "2026-10-11", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "", success: "", fallback: null }],
    );
    expect(await clearPastPlans(db)).toBe(2);
    const left = (await pastPlanWeeks(db, TODAY, { multisport: false })).weeks;
    expect(left.map((w) => w.weekStart)).toEqual(["2026-09-07"]);
    expect(await db.getSelfChanges("2026-01-01", TODAY)).toEqual([]);
    expect(await clearPastPlans(db)).toBe(0);
    expect(TEST_PLAN_REASON).toContain("測試模式");
  });

  it("沒有跑步時也塞得進去：照週二、週四、週日排，都是沒做或跳過、改用替代", async () => {
    const { coach } = await makeCoach();
    await seedPastPlans(coach.db, TODAY, 3);
    const { weeks } = await pastPlanWeeks(coach.db, TODAY, { multisport: false });
    expect(weeks).toHaveLength(3);
    const outcomes = new Set(weeks.flatMap((w) => w.sessions.map((s) => s.outcome)));
    expect(outcomes.has("achieved")).toBe(false);
    expect(outcomes).toContain("missed");
  });
});
