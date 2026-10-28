/** 騎車的分析（規格 12.31，多運動）：騎後 AI 分析、每週的量、有就顯示踏頻與功率 */
import { describe, expect, it } from "vitest";

import { otherActivitiesText } from "../src/activity-labels";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { rideMetrics, rideSummaryPrompt, weeklyVolume, weeklyVolumeText, type RideSummaryInput } from "../src/ride-analysis";
import type { CoachSettings, OtherActivity, Workout } from "../src/types";
import { makeCoach, toolTurn, turn } from "./helpers";

// 今天是 2026-10-10（星期六）
const TODAY = "2026-10-10";
const MULTI: Partial<CoachSettings> = { features: ["multisport"] };
const ZONES = [135, 142, 150, 158, 163, 170, 185];

const ride = (date: string, partial: Partial<OtherActivity> = {}, raw: Record<string, unknown> = {}): OtherActivity => ({
  intervals_id: `r-${date}`,
  date,
  type: "Ride",
  duration_min: 60,
  distance_km: 25,
  avg_hr: 128,
  training_load: 40,
  raw_json: JSON.stringify({ lthr: 160, icu_hr_zones: ZONES, icu_hr_zone_times: [2400, 1200, 0, 0, 0, 0, 0], ...raw }),
  ...partial,
});
const run = (date: string, minutes: number, load: number): Pick<Workout, "date" | "duration_min" | "training_load"> => ({ date, duration_min: minutes, training_load: load });
const POWER = { average_cadence: 88.4, icu_average_watts: 171.6, icu_weighted_avg_watts: 181.2, max_heartrate: 158, total_elevation_gain: 320 };

describe("騎車的數字", () => {
  it("有資料才有：踏頻、平均與標準化功率、最高心率、爬升、心率區間", () => {
    const full = rideMetrics(ride(TODAY, {}, POWER));
    expect(full).toMatchObject({ cadence: 88, watts: 172, normalizedWatts: 181, maxHr: 158, elevationM: 320 });
    expect(full.intensity!.low + full.intensity!.moderate + full.intensity!.high).toBe(3600);
    const bare = rideMetrics({ raw_json: JSON.stringify({ average_cadence: 0 }) });
    expect(bare).toEqual({ maxHr: null, elevationM: null, cadence: null, watts: null, normalizedWatts: null, intensity: null });
    // 裝置的功率（沒有 Intervals.icu 算的時）
    expect(rideMetrics({ raw_json: JSON.stringify({ average_watts: 150, weighted_average_watts: 160 }) })).toMatchObject({ watts: 150, normalizedWatts: 160 });
  });

  it("分析的提示：有功率才提功率；沒有心率時說不要推測；課表與最近的負荷", () => {
    const base: RideSummaryInput = {
      date: TODAY,
      type: "Ride",
      durationMin: 60,
      distanceKm: 25,
      avgHr: 128,
      load: 40,
      metrics: rideMetrics(ride(TODAY, {}, POWER)),
      perceivedEffort: 4,
      notes: "腿很輕",
      plan: "耐力騎「耐力騎」；程式的判斷：達成",
      recentLoad: "最近 7 天跑步＋其他運動的負荷 210（前三週平均每週 180）",
      weather: null,
    };
    const p = rideSummaryPrompt(base);
    expect(p).toContain("騎車訓練");
    expect(p).toContain("平均踏頻：88 rpm");
    expect(p).toContain("平均功率：172 W、標準化功率：181 W");
    expect(p).toContain("一併說明功率");
    expect(p).toContain("課表：耐力騎");
    expect(p).toContain("最近的負荷：最近 7 天");
    expect(p).toContain("體感強度：4/10\n主觀感受：腿很輕");
    expect(p).toMatch(/強度分配（依騎車的心率區間）：低 \d+%、中 \d+%、高 \d+%/);
    const bare = rideSummaryPrompt({ ...base, avgHr: null, metrics: rideMetrics({ raw_json: null }), perceivedEffort: null, plan: null, recentLoad: null });
    expect(bare).not.toContain("踏頻");
    expect(bare).not.toContain("功率");
    expect(bare).not.toContain("強度分配（依騎車");
    expect(bare).toContain("心率：沒有資料");
    expect(bare).toContain("不要推測心率");
    expect(bare).toContain("體感資料：未記錄");
  });
});

describe("騎後分析", () => {
  it("運動回報存了騎車的體感就產生分析，存起來；紀錄頁的騎車卡與教練看得到；有功率的卡多踏頻與標準化功率", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "穩定的耐力騎\n\n- 大多在低強度\n- 明天輕鬆跑" })], { settings: MULTI });
    await coach.db.upsertOtherActivities([ride(TODAY, {}, POWER)]);
    const report = await coach.reportRun(4, "腿很輕", { kind: "other", intervalsId: `r-${TODAY}` });
    expect(report).toMatchObject({ status: "other", summary: "穩定的耐力騎\n\n- 大多在低強度\n- 明天輕鬆跑" });
    // 用跑後摘要的模型
    expect(provider.calls[0]!.request.model).toBe("summary-model");
    expect(provider.calls[0]!.request.messages.at(-1)!.content).toContain("平均功率：172 W");
    const [card] = await coach.rideCards(7);
    expect(card).toMatchObject({ headline: "穩定的耐力騎", details: "- 大多在低強度\n- 明天輕鬆跑", cadence: 88, watts: 172, normalizedWatts: 181 });
    expect(otherActivitiesText(await coach.db.getOtherActivities(7))).toContain("體感 4/10（腿很輕）\n  分析：穩定的耐力騎");
  });

  it("沒有踏頻與功率的騎車卡不出現那幾格；不是騎車的不分析；開關關著不分析；失敗時體感照樣存著", async () => {
    const { coach } = await makeCoach([new Error("模型掛了")], { settings: MULTI });
    await coach.db.upsertOtherActivities([ride(TODAY), ride("2026-10-09", { intervals_id: "swim", type: "Swim" })]);
    expect(await coach.reportRun(5, "", { kind: "other", intervalsId: `r-${TODAY}` })).toMatchObject({ summary: null });
    expect((await coach.db.getOtherActivity(`r-${TODAY}`))!.perceived_effort).toBe(5);
    const [card] = await coach.rideCards(7);
    expect(card).toMatchObject({ cadence: null, watts: null, normalizedWatts: null, headline: null });
    expect(await coach.analyzeRide("swim")).toBeNull();
    const off = await makeCoach([]);
    await off.coach.db.upsertOtherActivities([ride(TODAY)]);
    expect(await off.coach.analyzeRide(`r-${TODAY}`)).toBeNull();
    expect(await off.coach.reportRun(5, "", { kind: "other", intervalsId: `r-${TODAY}` })).toMatchObject({ summary: null });
  });

  it("教練記下騎車的體感時也產生分析；多裝置同步帶著分析", async () => {
    const ma = await makeCoach([toolTurn("save_activity_feedback", { perceived_effort: 4, sport: "ride" }), turn({ text: "穩定的耐力騎" }), turn({ text: "好" })], { settings: MULTI });
    await ma.coach.db.upsertOtherActivities([ride(TODAY)]);
    await ma.coach.chat("剛騎完，體感 4");
    expect(ma.provider.calls[2]!.toolResults![0]!.content).toContain("穩定的耐力騎");
    const mb = await makeCoach([], { settings: MULTI });
    const snap = await snapshot(ma.driver);
    expect(snap.data.get(`as:r-${TODAY}`)).toMatchObject({ s: "穩定的耐力騎" });
    const target = await snapshot(mb.driver);
    for (const [name, data] of snap.data) if (name.startsWith("as:") || name.startsWith("af:")) await applyEntity(mb.driver, name, data, target);
    // 那趟還沒同步到這台也先存著，之後同步進來就看得到
    await mb.coach.db.upsertOtherActivities([ride(TODAY)]);
    expect((await mb.coach.db.getOtherActivity(`r-${TODAY}`))!.summary).toBe("穩定的耐力騎");
  });
});

describe("每週的量", () => {
  it("每週跑步與騎車的時間、負荷；騎車依心率區間分強度（沒有區間的另外算）；範圍外的不算", () => {
    const weeks = weeklyVolume(
      [run("2026-10-06", 45, 50), run("2026-10-10", 30, 30), run("2026-09-29", 60, 70), run("2026-08-01", 99, 99)],
      [
        ride("2026-10-07"),
        ride("2026-10-08", { intervals_id: "nozones", raw_json: null, duration_min: 30, training_load: 20 }),
        ride("2026-09-30", { duration_min: 90, distance_km: 40, training_load: 70 }),
        ride("2026-10-09", { intervals_id: "swim", type: "Swim", duration_min: 40 }),
        ride("2026-10-11", { intervals_id: "future" }),
      ],
      TODAY,
      3,
    );
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-09-21", "2026-09-28", "2026-10-05"]);
    expect(weeks[0]).toMatchObject({ run: { count: 0, minutes: 0 }, ride: { count: 0, minutes: 0 } });
    expect(weeks[1]).toMatchObject({ run: { count: 1, minutes: 60, load: 70 }, ride: { count: 1, minutes: 90, km: 40, load: 70 } });
    expect(weeks[2]).toMatchObject({ run: { count: 2, minutes: 75, load: 80 }, ride: { count: 2, minutes: 90, km: 50, load: 60 } });
    const z = weeks[2]!.ride.intensity;
    expect(z.unknown).toBe(30);
    expect(z.low + z.moderate + z.high).toBe(60);
  });

  it("教練看的騎車趨勢：最近 4 週與前 4 週比；開關開著時 get_training_values 帶出來", async () => {
    const days = Array.from({ length: 63 }, (_, i) => {
      const d = new Date(Date.parse(`${TODAY}T00:00:00Z`) - i * 86_400_000).toISOString().slice(0, 10);
      return d;
    });
    // 每週三騎：前 4 週 60 分鐘，最近 4 週 90 分鐘
    const rides = days.filter((d) => new Date(`${d}T00:00:00Z`).getUTCDay() === 3).map((d, i) => ride(d, { intervals_id: d, duration_min: i < 5 ? 90 : 60 }));
    const text = weeklyVolumeText(weeklyVolume([], rides, TODAY, 9), TODAY);
    expect(text).toContain("【騎車】每週的量");
    expect(text).toMatch(/・10-05 起：騎車 1 次｜1.5 小時｜25 km｜負荷 40｜低 \d+% 中 \d+% 高 \d+%；跑步＋騎車 1.5 小時、負荷 40/);
    expect(text).toContain("趨勢：最近 4 週平均每週騎 1.5 小時，和前 4 週比多 50%。");
    expect(weeklyVolumeText(weeklyVolume([], [], TODAY, 9), TODAY)).toBe("【騎車】最近沒有騎車。");

    const on = await makeCoach([toolTurn("get_training_values"), turn({ text: "好" })], { settings: MULTI });
    await on.coach.db.upsertOtherActivities(rides.slice(0, 3));
    await on.coach.chat("最近的量");
    expect(on.provider.calls[1]!.toolResults![0]!.content).toContain("【騎車】每週的量");
    const off = await makeCoach([toolTurn("get_training_values"), turn({ text: "好" })]);
    await off.coach.chat("最近的量");
    expect(off.provider.calls[1]!.toolResults![0]!.content).not.toContain("【騎車】");
  });
});
