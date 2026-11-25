import { describe, expect, it } from "vitest";

import { addDays, getCoverage, isCovered, isoWeekLabel, mergeRanges, type Activity, type ActivitySource, type OtherActivity } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { activity, makeCoach } from "./helpers";

/** 和 Intervals.icu 一樣只回傳日期範圍內的活動；記下每次一段期間的請求 */
class WindowSource implements ActivitySource {
  ranges: [string, string][] = [];
  fail = false;
  constructor(
    public runs: Activity[],
    public others: OtherActivity[],
    public today: () => string,
  ) {}
  async fetchLatestActivity() {
    return null;
  }
  async fetchActivities(days: number) {
    const from = addDays(this.today(), -(days - 1));
    return this.runs.filter((a) => a.date >= from && a.date <= this.today());
  }
  async fetchOtherActivities(days: number) {
    const from = addDays(this.today(), -(days - 1));
    return this.others.filter((a) => a.date >= from && a.date <= this.today());
  }
  async fetchRunsBetween(oldest: string, newest: string) {
    this.ranges.push([oldest, newest]);
    if (this.fail) throw new Error("Intervals.icu 回應 429");
    const inRange = <T extends { date: string }>(list: T[]) => list.filter((a) => a.date >= oldest && a.date <= newest);
    return { runs: inRange(this.runs), others: inRange(this.others), unavailable: 0 };
  }
}

const other = (id: string, date: string, type = "Ride"): OtherActivity => ({
  intervals_id: id,
  date,
  type,
  duration_min: 40,
  distance_km: type === "Ride" ? 9.5 : null,
  avg_hr: 130,
  training_load: 30,
  raw_json: "{}",
});

const FLAGS = { features: ["multisport"] };
const meta = (weekStart: string) => ({ weekLabel: isoWeekLabel(weekStart), weekStart, style: "fixed" as const, reason: "", outline: null, notes: null, content: "" });
const draft = (date: string, kind: "easy" | "strength" | "cross", title: string) => ({
  date,
  kind,
  ...(kind === "cross" ? { sport: "ride" as const } : {}),
  title,
  steps: [{ duration_min: 40 }],
  purpose: "",
  success: "",
  fallback: null,
});
const outcomes = (weeks: { sessions: { title: string; outcome: string }[] }[]) => weeks.map((w) => w.sessions.map((s) => `${s.title}:${s.outcome}`));

describe("這台抓過的範圍（規格 12.34：兩台的「之前的週」）", () => {
  it("範圍的合併與涵蓋", () => {
    expect(mergeRanges([["2026-10-01", "2026-10-05"], ["2026-09-01", "2026-09-10"], ["2026-10-06", "2026-10-08"], ["2026-09-05", "2026-09-07"]])).toEqual([
      ["2026-09-01", "2026-09-10"],
      ["2026-10-01", "2026-10-08"],
    ]);
    const ranges = mergeRanges([["2026-09-01", "2026-09-10"], ["2026-10-01", "2026-10-08"]]);
    expect(isCovered(ranges, "2026-10-02", "2026-10-08")).toBe(true);
    expect(isCovered(ranges, "2026-09-08", "2026-10-02")).toBe(false);
  });

  it("很久沒在這台同步：那幾週標「這台沒有」，打開時補抓一次（跑步與騎車，一次請求、不產生分析），之後和另一台一樣", async () => {
    // 8/31 那週（教練看的最近 4 週以外）
    let now = new Date("2026-09-08T04:00:00Z");
    const today = () => now.toISOString().slice(0, 10);
    const src = new WindowSource([activity({ intervals_id: "r1", date: "2026-09-01", raw_json: "{}" })], [other("o1", "2026-09-02")], today);
    // A：9/8 同步過（那週的跑步與騎車都在 14 天內）
    const a = await makeCoach([], { source: src, settings: FLAGS, now: () => now });
    await a.coach.db.saveStructuredPlan(meta("2026-08-31"), [draft("2026-09-01", "easy", "輕鬆跑"), draft("2026-09-02", "cross", "耐力騎")]);
    await a.coach.sync();
    now = new Date("2026-10-10T04:00:00Z");
    await a.coach.db.saveStructuredPlan(meta("2026-10-05"), [draft("2026-10-06", "easy", "這週")]);
    // B：10/10 才第一次同步（最近 14 天，加上教練看的最近 4 週：9/7 起），課表從 A 同步過來
    const b = await makeCoach([], { source: src, settings: FLAGS, now: () => now });
    await b.coach.sync();
    expect(await getCoverage(b.coach.db)).toEqual([["2026-09-07", "2026-10-10"]]);
    const snap = await snapshot(a.driver);
    for (const prefix of ["pl:", "ps:"]) for (const [k, v] of snap.data) if (k.startsWith(prefix)) await applyEntity(b.driver, k, v, await snapshot(b.driver));

    const aWeeks = await a.coach.pastPlanWeeks(8, { checkCoverage: true });
    expect(outcomes(aWeeks.weeks)).toEqual([["輕鬆跑:achieved", "耐力騎:achieved"]]);
    expect(aWeeks.weeks[0]!.uncovered).toBe(false);

    // 修之前就是這樣不一致：B 沒有那週的紀錄，算成沒做；現在標出這台沒有
    let bWeeks = await b.coach.pastPlanWeeks(8, { checkCoverage: true });
    expect(outcomes(bWeeks.weeks)).toEqual([["輕鬆跑:missed", "耐力騎:missed"]]);
    expect(bWeeks.weeks[0]!.uncovered).toBe(true);
    // 沒連 Intervals.icu（不檢查）時不標
    expect((await b.coach.pastPlanWeeks(8)).weeks[0]!.uncovered).toBe(false);

    src.ranges = [];
    expect(await b.coach.backfillPastWeeks(bWeeks.weeks)).toEqual({ runs: 1, others: 1 });
    expect(src.ranges).toEqual([["2026-08-31", "2026-09-06"]]);
    bWeeks = await b.coach.pastPlanWeeks(8, { checkCoverage: true });
    expect(outcomes(bWeeks.weeks)).toEqual(outcomes(aWeeks.weeks));
    expect(bWeeks.weeks[0]!.uncovered).toBe(false);
    // 不產生分析（不花模型的費用）：腳本是空的，呼叫模型會丟錯
    expect(b.provider.calls).toHaveLength(0);
    expect(await getCoverage(b.coach.db)).toEqual([["2026-08-31", "2026-10-10"]]);
  });

  it("補抓失敗：丟出錯誤，這次打開 App 不再重試同一段（頻率限制）；那幾週仍標這台沒有", async () => {
    const now = new Date("2026-10-10T04:00:00Z");
    const src = new WindowSource([], [], () => "2026-10-10");
    const { coach } = await makeCoach([], { source: src, settings: FLAGS, now: () => now });
    await coach.db.saveStructuredPlan(meta("2026-09-21"), [draft("2026-09-22", "strength", "肌力")]);
    await coach.db.saveStructuredPlan(meta("2026-09-14"), [draft("2026-09-15", "easy", "輕鬆跑")]);
    await coach.db.saveStructuredPlan(meta("2026-10-05"), [draft("2026-10-06", "easy", "這週")]);
    const { weeks } = await coach.pastPlanWeeks(8, { checkCoverage: true });
    expect(weeks.map((w) => w.uncovered)).toEqual([true, true]);
    src.fail = true;
    await expect(coach.backfillPastWeeks(weeks)).rejects.toThrow("429");
    expect(await coach.backfillPastWeeks(weeks)).toBeNull();
    // 兩週一次請求：最舊那週的週一到最新那週的週日
    expect(src.ranges).toEqual([["2026-09-14", "2026-09-27"]]);
    expect((await coach.pastPlanWeeks(8, { checkCoverage: true })).weeks.every((w) => w.uncovered)).toBe(true);
  });

  it("同步與匯入完整歷史都記下抓過的範圍；匯入也帶進騎車等其他運動", async () => {
    const now = new Date("2026-10-10T04:00:00Z");
    const src = new WindowSource([activity({ intervals_id: "r1", date: "2026-08-03", raw_json: "{}" })], [other("o1", "2026-08-04"), other("o2", "2026-08-05", "WeightTraining")], () => "2026-10-10");
    const { coach } = await makeCoach([], { source: src, settings: FLAGS, now: () => now });
    await coach.sync();
    // 最近 14 天，加上教練看的最近 4 週（9/7 – 10/4）
    expect(await getCoverage(coach.db)).toEqual([["2026-09-07", "2026-10-10"]]);
    const result = await coach.importHistory();
    expect(result).toMatchObject({ added: 1, others: 2 });
    expect((await coach.db.getOtherActivities(90)).map((a) => a.intervals_id).sort()).toEqual(["o1", "o2"]);
    const [range] = await getCoverage(coach.db);
    expect(range![1]).toBe("2026-10-10");
    expect(range![0] < "2025-01-01").toBe(true);
  });
});
