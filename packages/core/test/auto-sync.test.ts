import { describe, expect, it } from "vitest";

import { addCoverage, getCoverage, IntervalsError, isoWeekLabel, recentAdherence, type Activity, type ActivitySource } from "../src";
import { activity, makeCoach, turn } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）
class Source implements ActivitySource {
  fail = false;
  ranges: [string, string][] = [];
  constructor(public runs: Activity[]) {}
  async fetchLatestActivity() {
    return this.runs[0] ?? null;
  }
  async fetchActivities() {
    if (this.fail) throw new IntervalsError("Intervals.icu 回應 401（請確認 API Key 與 Athlete ID）");
    return this.runs;
  }
  async fetchOtherActivities() {
    return [];
  }
  async fetchRunsBetween(oldest: string, newest: string) {
    this.ranges.push([oldest, newest]);
    return { runs: this.runs.filter((r) => r.date >= oldest && r.date <= newest), others: [], unavailable: 0 };
  }
}

const HOUR = 60 * 60 * 1000;

describe("自動抓紀錄（規格 12.34 的 A1）", () => {
  it("還沒抓過不自動抓；抓過之後超過 1 小時才抓；只存紀錄、不產生分析；記下時間與抓過的範圍", async () => {
    let now = new Date("2026-10-10T04:00:00Z");
    const src = new Source([activity({ intervals_id: "r1", date: "2026-10-09", raw_json: "{}" })]);
    const { coach, provider } = await makeCoach([turn({ text: "昨天那趟的分析" })], { source: src, now: () => now });
    // 第一次由選手選（最近 14 天或全部）
    expect(await coach.autoSyncActivities()).toBe(false);
    expect(await coach.fetchStatus()).toBeNull();

    await coach.sync();
    expect(provider.calls).toHaveLength(1);
    expect(await coach.fetchStatus()).toMatchObject({ at: "2026-10-10T04:00:00.000Z", error: null });

    now = new Date(now.getTime() + 30 * 60 * 1000);
    src.runs.unshift(activity({ intervals_id: "r2", date: "2026-10-10", raw_json: "{}" }));
    expect(await coach.autoSyncActivities()).toBe(false);
    now = new Date(now.getTime() + HOUR);
    expect(await coach.autoSyncActivities()).toBe(true);
    // 新的一趟存了、沒有分析（模型沒有再被呼叫）
    const saved = (await coach.db.getRecentWorkouts(7)).find((w) => w.intervals_id === "r2")!;
    expect(saved.summary).toBeNull();
    expect(provider.calls).toHaveLength(1);
    expect((await coach.fetchStatus())!.at).toBe(now.toISOString());
    expect((await getCoverage(coach.db)).some(([, to]) => to === "2026-10-10")).toBe(true);
  });

  it("按「同步」時補最近 2 天還沒分析、也還沒回報的跑步；回報過體感的、更早的不補", async () => {
    let now = new Date("2026-10-10T04:00:00Z");
    const src = new Source([activity({ intervals_id: "old", date: "2026-10-01", raw_json: "{}" })]);
    const { coach, provider } = await makeCoach([turn({ text: "舊的分析" }), turn({ text: "今天的分析" })], { source: src, now: () => now });
    await coach.sync();
    now = new Date(now.getTime() + 2 * HOUR);
    src.runs.unshift(
      activity({ intervals_id: "today", date: "2026-10-10", raw_json: "{}" }),
      activity({ intervals_id: "felt", date: "2026-10-09", raw_json: "{}", distance_km: 5, duration_min: 30 }),
      activity({ intervals_id: "older", date: "2026-10-07", raw_json: "{}", distance_km: 8, duration_min: 45 }),
    );
    expect(await coach.autoSyncActivities()).toBe(true);
    const byId = async () => Object.fromEntries((await coach.db.getRecentWorkouts(14)).map((w) => [w.intervals_id, w]));
    await coach.db.updateWorkoutSubjective((await byId()).felt!.id, 6, null);
    expect(provider.calls).toHaveLength(1);

    await coach.sync();
    const after = await byId();
    expect(after.today!.summary).toBe("今天的分析");
    expect(after.felt!.summary).toBeNull();
    expect(after.older!.summary).toBeNull();
    expect(provider.calls).toHaveLength(2);
  });

  it("自動抓：有等著合併的跑後感受的那天先不存，留給按「同步」時合併並分析", async () => {
    let now = new Date("2026-10-10T04:00:00Z");
    const src = new Source([activity({ intervals_id: "r0", date: "2026-10-05", raw_json: "{}" })]);
    const { coach, provider } = await makeCoach([turn({ text: "分析一" }), turn({ text: "合併後的分析" })], { source: src, now: () => now });
    await coach.sync();
    await coach.db.savePendingSubjective("2026-10-10", 7, "腿很重");
    src.runs.unshift(activity({ intervals_id: "r1", date: "2026-10-10", raw_json: "{}" }));
    now = new Date(now.getTime() + 2 * HOUR);
    expect(await coach.autoSyncActivities()).toBe(true);
    expect(await coach.db.getWorkoutByIntervalsId("r1")).toBeNull();
    await coach.sync();
    const merged = (await coach.db.getWorkoutByIntervalsId("r1"))!;
    expect(merged.perceived_effort).toBe(7);
    expect((await coach.db.getWorkout(merged.id))!.summary).toBe("合併後的分析");
    expect(provider.calls).toHaveLength(2);
  });

  it("失敗：記下錯誤（設定顯示），不丟出；1 小時內不再試", async () => {
    let now = new Date("2026-10-10T04:00:00Z");
    const src = new Source([]);
    const { coach } = await makeCoach([], { source: src, now: () => now });
    await coach.sync();
    src.fail = true;
    now = new Date(now.getTime() + 2 * HOUR);
    expect(await coach.autoSyncActivities()).toBe(false);
    const status = (await coach.fetchStatus())!;
    expect(status.error).toContain("401");
    expect(status.errorAt).toBe(now.toISOString());
    expect(status.at).toBe("2026-10-10T04:00:00.000Z");
    src.fail = false;
    now = new Date(now.getTime() + 10 * 60 * 1000);
    expect(await coach.autoSyncActivities()).toBe(false);
  });

  it("教練的最近 4 週摘要：這台沒抓過的週不算成沒做；按「同步」後補抓那 4 週一次（這次打開 App 只試一次）", async () => {
    const now = new Date("2026-10-10T04:00:00Z");
    // 9/8 的跑步（4 週內、14 天外）
    const src = new Source([activity({ intervals_id: "r1", date: "2026-09-08", raw_json: "{}" })]);
    const { coach } = await makeCoach([], { source: src, now: () => now });
    const meta = (weekStart: string) => ({ weekLabel: isoWeekLabel(weekStart), weekStart, style: "fixed" as const, reason: "", outline: null, notes: null, content: "" });
    const easy = (date: string) => ({ date, kind: "easy" as const, title: "輕鬆跑", steps: [{ duration_min: 50 }], purpose: "", success: "", fallback: null });
    await coach.db.saveStructuredPlan(meta("2026-09-07"), [easy("2026-09-08")]);
    await coach.db.saveStructuredPlan(meta("2026-09-28"), [easy("2026-09-29")]);
    await coach.db.saveStructuredPlan(meta("2026-10-05"), [easy("2026-10-06")]);
    // 這台只抓過最近 14 天：9/7 那週這台沒有，不算進來
    await addCoverage(coach.db, "2026-09-27", "2026-10-10");
    const before = (await recentAdherence(coach.db, "2026-10-10"))!;
    expect(before).toContain("週這台沒有那段時間的手錶紀錄（沒有算進來，不是沒做）");
    expect(before).toContain("輕鬆跑 1 堂：沒做 1");

    await coach.sync();
    expect(src.ranges).toEqual([["2026-09-07", "2026-10-04"]]);
    const after = (await recentAdherence(coach.db, "2026-10-10"))!;
    expect(after).not.toContain("這台沒有");
    expect(after).toContain("輕鬆跑 2 堂：做了 1、沒做 1");
    // 涵蓋了就不再抓
    await coach.sync();
    expect(src.ranges).toHaveLength(1);
  });
});
