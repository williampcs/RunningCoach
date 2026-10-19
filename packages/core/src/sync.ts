/**
 * 完整同步流程（/sync）.
 *
 * 1. 從活動來源拉取最近 14 天的跑步活動
 * 2. 以 intervals_id 去重，只處理新資料
 * 3. 檢查 pending_subjective 是否有符合日期的主觀暫存
 * 4. 合併主客觀資料（或僅存客觀資料）後存入 workouts
 * 5. 生成 AI 摘要存入 workout_summaries
 * 6. 清理超過 7 天的 pending_subjective
 * 另外更新恢復資料（靜息心率、HRV、睡眠）；沒有跑步時也更新，失敗不影響活動的同步
 */
import type { Db } from "./db";
import { IntervalsError } from "./intervals";
import type { Llm } from "./llm";
import { recoveryNoteFor } from "./recovery";
import { generateWorkoutSummary } from "./tools";
import type { ActivitySource, Activity, Logger } from "./types";

/** 同步時拉取的天數 */
export const SYNC_DAYS = 14;

const ACTIVITY_LABELS: Record<string, string> = {
  Walk: "走路",
  Hike: "健行",
  Ride: "騎車",
  VirtualRide: "騎車",
  EBikeRide: "騎車",
  GravelRide: "騎車",
  MountainBikeRide: "騎車",
  Swim: "游泳",
  OpenWaterSwim: "游泳",
  WeightTraining: "肌力訓練",
  Yoga: "瑜伽",
};

/** 例：「另有 2 筆走路、1 筆騎車，教練目前只讀跑步；…」；沒有其他活動或取得失敗時為 null */
async function otherActivitiesNote(activities: ActivitySource, logger: Logger): Promise<string | null> {
  if (!activities.fetchOtherActivityTypes) return null;
  let types: string[];
  try {
    types = await activities.fetchOtherActivityTypes(SYNC_DAYS);
  } catch (e) {
    logger.warn(`Other activity types fetch failed: ${message(e)}`);
    return null;
  }
  if (!types.length) return null;
  const counts = new Map<string, number>();
  for (const t of types) {
    const label = ACTIVITY_LABELS[t] ?? "其他運動";
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const list = [...counts].map(([label, n]) => `${n} 筆${label}`).join("、");
  return `另有 ${list}，教練目前只讀跑步；如果其中有跑步，可以在 Intervals.icu 把類型改成 Run。`;
}

/** 同步不到跑步時附上的提示；外殼可以據此再顯示上傳的方式 */
export const NO_RUNS_HINT = "如果最近有跑步，請確認手錶或 App 已把紀錄上傳到 Intervals.icu。";

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 執行同步，回傳結果摘要字串 */
export async function runSync(deps: {
  db: Db;
  llm: Llm;
  activities: ActivitySource;
  logger: Logger;
}): Promise<string> {
  const { db, llm, activities, logger } = deps;

  // 恢復資料先處理：受傷休息、沒有跑步紀錄時更需要它
  let wellnessDays = 0;
  let wellnessFailed = false;
  if (activities.fetchWellness) {
    try {
      const days = await activities.fetchWellness(SYNC_DAYS);
      await db.upsertWellness(days);
      wellnessDays = days.length;
    } catch (e) {
      logger.warn(`Wellness fetch failed: ${message(e)}`);
      wellnessFailed = true;
    }
  }
  const wellnessNote = wellnessFailed ? "（恢復資料暫時無法取得）" : wellnessDays ? `已更新恢復資料 ${wellnessDays} 天。` : "";

  let fetched: Activity[];
  try {
    fetched = await activities.fetchActivities(SYNC_DAYS);
  } catch (e) {
    if (e instanceof IntervalsError) return `❌ Intervals.icu 連線失敗：${e.message}`;
    logger.error(`Intervals.icu fetch error: ${message(e)}`);
    return `❌ 拉取 Intervals.icu 資料時發生錯誤：${message(e)}`;
  }
  if (!fetched.length) {
    // 有其他活動時，上傳的路是通的，常見的是跑步被記成走路：說明只讀跑步，不必檢查上傳
    const others = await otherActivitiesNote(activities, logger);
    return `Intervals.icu 最近 ${SYNC_DAYS} 天無跑步活動。${others ?? ""}${wellnessNote}${others ? "" : NO_RUNS_HINT}`;
  }

  let newCount = 0;
  let mergedCount = 0;
  let skippedCount = 0;

  for (const activity of fetched) {
    // 去重：已存在則跳過
    if (activity.intervals_id && (await db.getWorkoutByIntervalsId(activity.intervals_id))) {
      skippedCount += 1;
      continue;
    }

    const pending = await db.getPendingSubjectiveByDate(activity.date);
    const perceivedEffort = pending?.perceived_effort ?? null;
    const subjectiveNotes = pending?.subjective_notes ?? null;

    let workoutId: number;
    try {
      workoutId = await db.saveWorkout(activity, perceivedEffort, subjectiveNotes);
    } catch (e) {
      logger.error(`save_workout failed for intervals_id=${activity.intervals_id}: ${message(e)}`);
      continue;
    }

    try {
      const summary = await generateWorkoutSummary(llm, {
        ...activity,
        perceived_effort: perceivedEffort,
        subjective_notes: subjectiveNotes,
        recovery: await recoveryNoteFor(db, activity.date),
      });
      await db.saveWorkoutSummary(workoutId, summary);
    } catch (e) {
      logger.warn(`Summary generation failed for workout_id=${workoutId}: ${message(e)}`);
    }

    // 清除已配對的 pending 資料
    if (pending) {
      await db.deletePendingSubjective(pending.id);
      mergedCount += 1;
    }
    newCount += 1;
  }

  await db.cleanupOldPendingSubjective();

  if (newCount === 0) {
    return (skippedCount > 0 ? "✅ 無新資料，所有活動已是最新狀態。" : "✅ Intervals.icu 同步完成") + wellnessNote;
  }
  const details = [`新增 ${newCount} 筆訓練紀錄`];
  if (mergedCount) details.push(`其中 ${mergedCount} 筆合併了主觀感受`);
  if (skippedCount) details.push(`略過 ${skippedCount} 筆已存在資料`);
  if (wellnessDays) details.push(`更新恢復資料 ${wellnessDays} 天`);
  return `✅ Intervals.icu 同步完成：${details.join("，")}${wellnessFailed ? "（恢復資料暫時無法取得）" : ""}`;
}
