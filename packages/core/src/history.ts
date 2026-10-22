/**
 * 紀錄頁與跑後回報的「一趟跑步」卡片（規格 12.9）：數字、強度分配、體感與預期、和課表比的結果、
 * 分析摘要的第一句. 只整理既有的資料，不呼叫模型.
 */
import { addDays } from "./dates";
import type { Db } from "./db";
import { EXPECTED_RPE } from "./plan";
import { DIFFICULTY_LABELS, OUTCOME_LABELS, type Difficulty, type Outcome } from "./plan-match";
import { planResultsSince } from "./planning";
import { computeTrainingValues, intensityDistribution } from "./training-values";
import type { Workout } from "./types";

export interface RunCard {
  workout: Workout;
  /** 依心率區間的時間（秒）：低強度為閾值心率 90% 以下；沒有區間資料時為 null */
  intensity: { low: number; moderate: number; high: number } | null;
  /** 對應的課；沒有結構化課表的週為 null */
  plan: {
    kindLabel: string;
    title: string;
    outcome: Outcome;
    outcomeLabel: string;
    reasons: string[];
    difficulty: Difficulty | null;
    difficultyLabel: string | null;
  } | null;
  /** 有課表的週、但沒有配到課 */
  outsidePlan: boolean;
  /** 這種課預期的體感範圍（對應到課時才有） */
  expectedRpe: [number, number] | null;
  /** 分析摘要的第一段（結論），其餘收起 */
  headline: string | null;
  details: string | null;
}

/** 摘要的第一段當結論，其餘是細節 */
export function splitSummary(summary: string | null | undefined): { headline: string | null; details: string | null } {
  const lines = (summary ?? "").trim().split("\n");
  const first = lines.findIndex((l) => l.trim() !== "");
  if (first < 0) return { headline: null, details: null };
  const details = lines
    .slice(first + 1)
    .join("\n")
    .trim();
  return { headline: lines[first]!.trim(), details: details || null };
}

export function runCardOf(
  workout: Workout,
  lthr: number | null,
  planned: Awaited<ReturnType<typeof planResultsSince>>,
): RunCard {
  const d = intensityDistribution([workout], lthr);
  const p = planned.byWorkout.get(workout.id);
  return {
    workout,
    intensity: d.withZones ? { low: d.lowSecs, moderate: d.moderateSecs, high: d.highSecs } : null,
    plan: p
      ? {
          kindLabel: p.kindLabel,
          title: p.title,
          outcome: p.result.outcome,
          outcomeLabel: OUTCOME_LABELS[p.result.outcome],
          reasons: p.result.reasons,
          difficulty: p.result.difficulty,
          difficultyLabel: p.result.difficulty ? DIFFICULTY_LABELS[p.result.difficulty] : null,
        }
      : null,
    outsidePlan: planned.inPlannedWeek.has(workout.id),
    expectedRpe: p && p.result.outcome !== "fallback" ? EXPECTED_RPE[p.kind] : p ? EXPECTED_RPE.easy : null,
    ...splitSummary(workout.summary),
  };
}

/** 最近 N 天的跑步卡片，新的在前 */
export async function runCards(db: Db, today: string, days: number): Promise<RunCard[]> {
  const [workouts, values, planned] = await Promise.all([
    db.getRecentWorkouts(days),
    computeTrainingValues(db, today),
    planResultsSince(db, today, addDays(today, -days)),
  ]);
  const lthr = values.hr?.lthr ?? null;
  return workouts.map((w) => runCardOf(w, lthr, planned));
}
