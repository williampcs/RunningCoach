/**
 * 拿不到內容的活動（「空殼」，KI-048、規格 12.40）.
 *
 * Intervals.icu 不經 API 提供從 Strava 匯入的活動，只列出 id、時間、來源與一句說明；Garmin 的活動之後可能一樣.
 * 空殼不存成跑步（不會變成 0 公里的紀錄）、不算負荷；同步時記下最近 14 天有幾筆，看板提示原因與替代方式.
 * 之前已經存了內容的紀錄，之後變成空殼時照舊留著（不當成在 Intervals.icu 被刪了）.
 */
import { addDays } from "./dates";
import type { Db } from "./db";
import { unavailableOriginOf } from "./intervals";
import type { ActivitySource, Logger, UnavailableActivity, UnavailableOrigin } from "./types";

/** 同步記下的空殼（每次同步整份換掉） */
export const SNAPSHOT_UNAVAILABLE = "unavailable_activities";

export interface UnavailableSnapshot {
  /** 這次同步看的最舊、最新的日期 */
  since: string;
  until: string;
  /** 還沒有內容的（本機已經存了內容的不算） */
  items: UnavailableActivity[];
}

const ORIGIN_LABEL: Record<UnavailableOrigin, string> = { garmin: "Garmin", strava: "Strava", other: "其他來源" };
const ORIGIN_ORDER: UnavailableOrigin[] = ["garmin", "strava", "other"];

const isShellJson = (rawJson: string | null | undefined): boolean => {
  if (!rawJson) return false;
  try {
    return unavailableOriginOf(JSON.parse(rawJson) as Record<string, unknown>) !== null;
  } catch {
    return false;
  }
};

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export interface UnavailableResult {
  /** 這次拿到的空殼；來源不支援或讀取失敗時是 null（不更新記下的那份） */
  shells: UnavailableActivity[] | null;
  /**
   * 同步比對「已刪除」時也要當成還在的 id：本機已經存了內容的紀錄，在來源變成空殼時不刪
   * （本機存的也是空殼的就不保護，讓它照舊被移除）
   */
  keepIds: string[];
}

/**
 * 同步時讀最近 days 天的空殼並記下：本機已經存了內容的（跑步或其他運動）不算。
 * 失敗只記錄，不影響同步
 */
export async function refreshUnavailable(db: Db, activities: ActivitySource, days: number, logger: Logger): Promise<UnavailableResult> {
  if (!activities.fetchUnavailableActivities) return { shells: null, keepIds: [] };
  let shells: UnavailableActivity[];
  try {
    shells = await activities.fetchUnavailableActivities(days);
  } catch (e) {
    logger.warn(`Unavailable activities fetch failed: ${message(e)}`);
    return { shells: null, keepIds: [] };
  }
  const today = db.today();
  const others = new Map((await db.getOtherActivities(days + 1)).map((a) => [a.intervals_id, a]));
  const keepIds: string[] = [];
  const missing: UnavailableActivity[] = [];
  for (const shell of shells) {
    const run = await db.getWorkoutByIntervalsId(shell.intervals_id);
    const other = others.get(shell.intervals_id);
    const stored = (run && !run.removed_at && !isShellJson(run.raw_json)) || (other && !isShellJson(other.raw_json));
    if (stored) keepIds.push(shell.intervals_id);
    else missing.push(shell);
  }
  const snapshot: UnavailableSnapshot = { since: addDays(today, -(days - 1)), until: today, items: missing };
  await db.saveSnapshot(SNAPSHOT_UNAVAILABLE, snapshot);
  return { shells: missing, keepIds };
}

/** 例：「3 筆來自 Garmin、1 筆來自 Strava」；沒有時是 null */
export function unavailableCountText(items: readonly UnavailableActivity[]): string | null {
  if (!items.length) return null;
  const parts = ORIGIN_ORDER.flatMap((o) => {
    const n = items.filter((i) => i.origin === o).length;
    return n ? [`${n} 筆來自 ${ORIGIN_LABEL[o]}`] : [];
  });
  return parts.join("、");
}

/** 同步結果的一句話（沒有空殼時是空字串） */
export function unavailableSyncNote(items: readonly UnavailableActivity[] | null): string {
  const counts = items ? unavailableCountText(items) : null;
  return counts ? `另有 ${counts} 的活動，Intervals.icu 不能提供內容，沒有記成紀錄（看板有說明）` : "";
}

/**
 * 看板要提示的空殼：同步記下的那份裡，日期還在最近 days 天、那天也還沒有其他紀錄的
 * （選手手動記了那一趟，就不再提示）
 */
export async function unavailableForFeed(db: Db, today: string, days: number): Promise<UnavailableActivity[]> {
  const snapshot = await db.getSnapshot<UnavailableSnapshot>(SNAPSHOT_UNAVAILABLE);
  const items = Array.isArray(snapshot?.value?.items) ? snapshot.value.items : [];
  if (!items.length) return [];
  const since = addDays(today, -(days - 1));
  const recent = items.filter((i) => i.date >= since && i.date <= today);
  if (!recent.length) return [];
  const covered = new Set((await db.getRecentWorkouts(days + 1)).map((w) => w.date));
  return recent.filter((i) => !covered.has(i.date));
}
