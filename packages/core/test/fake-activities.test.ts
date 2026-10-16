import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import {
  addDays,
  Coach,
  daysBetween,
  FakeActivitySource,
  fakeActivity,
  formatPace,
  analyzeRecovery,
  generateActivities,
  generateWellness,
  parsePace,
  type Activity,
  type FakeSpec,
} from "../src";
import { silentLogger } from "../src/types";
import { ScriptedProvider } from "./helpers";

const END = "2026-10-11"; // 星期日
const spec = (partial: Partial<FakeSpec> = {}): FakeSpec => ({
  scenario: "steady",
  endDate: END,
  weeks: 6,
  runsPerWeek: 4,
  easyPaceSec: 345,
  maxHr: 188,
  seed: 7,
  ...partial,
});

const weekVolume = (runs: Activity[], weeksAgo: number) =>
  runs
    .filter((r) => Math.floor(daysBetween(r.date, END) / 7) === weeksAgo)
    .reduce((sum, r) => sum + (r.distance_km ?? 0), 0);

describe("generateActivities", () => {
  it("is reproducible and stays inside the requested weeks", () => {
    const a = generateActivities(spec());
    expect(generateActivities(spec())).toEqual(a);
    expect(generateActivities(spec({ seed: 8 }))).not.toEqual(a);
    expect(a).toHaveLength(6 * 4);
    expect(a[0]!.date >= addDays(END, -41)).toBe(true);
    expect(a.at(-1)!.date).toBe(END);
    expect(new Set(a.map((r) => r.intervals_id)).size).toBe(a.length);
  });

  it("produces plausible runs marked as fake", () => {
    for (const run of generateActivities(spec())) {
      expect(run.source).toBe("fake");
      expect(run.intervals_id).toMatch(/^fake-/);
      expect(run.distance_km).toBeGreaterThan(0);
      const pace = parsePace(run.avg_pace!)!;
      expect(pace).toBeGreaterThan(240);
      expect(pace).toBeLessThan(420);
      expect(run.duration_min).toBeCloseTo((run.distance_km! * pace) / 60, 0);
      expect(run.max_hr!).toBeGreaterThanOrEqual(run.avg_hr!);
      expect(run.max_hr!).toBeLessThanOrEqual(188);
      expect(JSON.parse(run.raw_json!)).toMatchObject({ fake: true, icu_training_load: run.training_load });
    }
  });

  it("makes the long run on the last training day of the week", () => {
    const runs = generateActivities(spec());
    const sundays = runs.filter((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() === 0);
    const others = runs.filter((r) => new Date(`${r.date}T00:00:00Z`).getUTCDay() !== 0);
    const avg = (xs: Activity[]) => xs.reduce((s, r) => s + r.distance_km!, 0) / xs.length;
    expect(avg(sundays)).toBeGreaterThan(avg(others) + 4);
  });

  it("shapes each scenario", () => {
    const build = generateActivities(spec({ scenario: "build" }));
    expect(weekVolume(build, 0)).toBeGreaterThan(weekVolume(build, 5) * 1.25);

    const overreach = generateActivities(spec({ scenario: "overreach" }));
    const easyHr = (runs: Activity[], recent: boolean) => {
      const picked = runs.filter((r) => (daysBetween(r.date, END) < 14) === recent && r.distance_km! < 14);
      return picked.reduce((s, r) => s + r.avg_hr!, 0) / picked.length;
    };
    expect(easyHr(overreach, true)).toBeGreaterThan(easyHr(overreach, false) + 5);
    expect(weekVolume(overreach, 0)).toBeGreaterThan(weekVolume(generateActivities(spec()), 0) * 1.2);

    const injury = generateActivities(spec({ scenario: "injury_break" }));
    const recentGap = injury.filter((r) => {
      const age = daysBetween(r.date, END);
      return age >= 7 && age <= 16;
    });
    expect(recentGap).toHaveLength(0);
    const lastWeek = injury.filter((r) => daysBetween(r.date, END) < 7);
    expect(lastWeek.length).toBeGreaterThan(0);
    expect(lastWeek.every((r) => r.distance_km! < 6)).toBe(true);

    const taper = generateActivities(spec({ scenario: "taper" }));
    expect(weekVolume(taper, 0)).toBeLessThan(weekVolume(taper, 2) * 0.7);

    const irregular = generateActivities(spec({ scenario: "irregular", weeks: 8 }));
    expect(irregular.length).toBeLessThan(8 * 4);
    expect(irregular.some((r) => r.avg_hr === null && r.max_hr === null)).toBe(true);
  });
});

describe("generateWellness", () => {
  it("covers every day, stays reproducible and shows overreaching to the recovery check", () => {
    const steady = generateWellness(spec());
    expect(steady).toHaveLength(42);
    expect(generateWellness(spec())).toEqual(steady);
    // 另一組亂數：產生恢復資料不會改變跑步紀錄
    expect(generateActivities(spec())).toEqual(generateActivities(spec()));
    expect(analyzeRecovery(steady, [], END).watchFlags).toEqual([]);

    const overreach = analyzeRecovery(generateWellness(spec({ scenario: "overreach" })), [], END);
    expect(overreach.watchFlags.length).toBeGreaterThan(0);
    expect(generateWellness(spec({ scenario: "irregular" })).length).toBeLessThan(42);
  });
});

describe("fakeActivity", () => {
  it("derives pace and load from what was entered", () => {
    const run = fakeActivity({ date: END, distanceKm: 10, durationMin: 52, avgHr: 160, maxHr: 175 });
    expect(run).toMatchObject({
      date: END,
      source: "fake",
      distance_km: 10,
      duration_min: 52,
      avg_pace: "5:12/km",
      avg_hr: 160,
      max_hr: 175,
    });
    expect(run.intervals_id).toMatch(/^fake-custom-/);
    expect(run.training_load).toBeGreaterThan(0);
  });
});

describe("FakeActivitySource", () => {
  it("uses the same date window as Intervals.icu and hides runs after today", async () => {
    const runs = generateActivities(spec());
    let today = addDays(END, -3);
    const source = new FakeActivitySource(runs, () => today);

    const visible = await source.fetchActivities(14);
    expect(visible.every((r) => r.date <= today && daysBetween(r.date, today) <= 14)).toBe(true);
    expect(visible[0]!.date >= visible.at(-1)!.date).toBe(true);
    expect((await source.fetchLatestActivity())!.date <= today).toBe(true);

    today = END;
    expect((await source.fetchLatestActivity())!.date).toBe(END);
  });

  it("treats a run added later on the same day as the latest one", async () => {
    const generated = generateActivities(spec());
    const custom = fakeActivity({ date: END, distanceKm: 5, durationMin: 30 });
    const source = new FakeActivitySource([...generated, custom], () => END);
    expect((await source.fetchLatestActivity())!.intervals_id).toBe(custom.intervals_id);
  });

  it("feeds the normal sync path and keeps the fake source marking", async () => {
    const driver = openNodeSqlite(":memory:");
    const runs = generateActivities(spec({ weeks: 2 }));
    const coach = new Coach({
      driver,
      // 摘要模型沒有腳本：摘要失敗只記錄警告，訓練紀錄照樣存檔
      llm: { provider: new ScriptedProvider([]), models: { chat: "c", summary: "s", compress: "p" }, chatEffort: "medium" },
      activities: new FakeActivitySource(runs, () => END),
      now: () => new Date(`${END}T04:00:00Z`), // 台北 12:00
      logger: silentLogger,
    });
    await coach.init();
    expect(await coach.sync()).toBe(`✅ Intervals.icu 同步完成：新增 ${runs.length} 筆訓練紀錄`);
    expect(await driver.all("SELECT DISTINCT source FROM workouts")).toEqual([{ source: "fake" }]);
  });
});

describe("pace helpers", () => {
  it("round-trips pace strings", () => {
    expect(parsePace("5:45")).toBe(345);
    expect(parsePace("5:45/km")).toBe(345);
    expect(parsePace("abc")).toBeNull();
    expect(formatPace(345)).toBe("5:45/km");
  });
});
