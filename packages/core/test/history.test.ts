import { describe, expect, it } from "vitest";

import { splitSummary } from "../src/history";
import { activity, makeCoach, toolTurn, turn } from "./helpers";

const ZONES = [145, 153, 161, 170, 175, 182, 190];
const raw = (id: string, zoneMin: number[]) => JSON.stringify({ id, icu_hr_zone_times: zoneMin.map((m) => m * 60), icu_hr_zones: ZONES, lthr: 172 });

describe("分析摘要的結論與細節", () => {
  it("第一段當結論，其餘收起；空白與沒有摘要", () => {
    expect(splitSummary("\n穩定的有氧跑\n\n- 配速穩定\n- 體感相符")).toEqual({ headline: "穩定的有氧跑", details: "- 配速穩定\n- 體感相符" });
    expect(splitSummary("只有一句")).toEqual({ headline: "只有一句", details: null });
    expect(splitSummary(null)).toEqual({ headline: null, details: null });
  });
});

describe("紀錄頁的卡片", () => {
  const plan = {
    week_start: "2026-10-05",
    style: "fixed",
    reason: "這週",
    sessions: [
      { date: "2026-10-08", kind: "threshold", title: "4×1 km 閾值", steps: [{ distance_km: 2, target: { hr: "easy" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }] }], purpose: "閾值", success: "每趟在範圍內" },
    ],
    accept_warnings: true,
    warning_notes: "測試",
  };

  it("強度分配、對應的課與預期的體感；課表外的跑步；摘要分段", async () => {
    const { coach } = await makeCoach([toolTurn("save_training_plan", plan), turn({ text: "好" })]);
    const tempo = await coach.db.saveWorkout(activity({ intervals_id: "i1", date: "2026-10-08", distance_km: 8, duration_min: 45, raw_json: raw("i1", [15, 10, 5, 0, 15, 0, 0]) }), 8, "最後一趟很硬");
    await coach.db.saveWorkoutSummary(tempo, "閾值課完成，最後一趟偏難\n\n- 前三趟穩定");
    const easy = await coach.db.saveWorkout(activity({ intervals_id: "i2", date: "2026-10-06", distance_km: 6, duration_min: 38, raw_json: raw("i2", [38, 0, 0, 0, 0, 0, 0]) }));
    await coach.db.saveWorkout(activity({ intervals_id: "i3", date: "2026-09-30", distance_km: 5, duration_min: 30, raw_json: JSON.stringify({ id: "i3" }) }));
    await coach.chat("排課表");

    const cards = await coach.runCards(30);
    expect(cards.map((c) => c.workout.date)).toEqual(["2026-10-08", "2026-10-06", "2026-09-30"]);
    const [t, e, old] = cards;
    expect(t!.plan).toMatchObject({ kindLabel: "T 閾值", title: "4×1 km 閾值", outcome: "achieved", difficulty: "hard", difficultyLabel: "體感偏難" });
    expect(t!.expectedRpe).toEqual([6, 7]);
    expect(t!.intensity).toEqual({ low: 25 * 60, moderate: 5 * 60, high: 15 * 60 });
    expect(t).toMatchObject({ headline: "閾值課完成，最後一趟偏難", details: "- 前三趟穩定", outsidePlan: false });
    // 有課表的週、但那天沒有課
    expect(e!.workout.id).toBe(easy);
    expect(e).toMatchObject({ plan: null, outsidePlan: true, expectedRpe: null });
    // 課表以前的週；沒有心率區間
    expect(old).toMatchObject({ plan: null, outsidePlan: false, intensity: null, headline: null });
  });
});
