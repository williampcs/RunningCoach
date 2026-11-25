/**
 * 這台抓過哪些日期的活動（規格 12.34「之前的週」、12.10）.
 *
 * 從 Intervals.icu 來的跑步與其他運動每台自己抓、不同步（device-sync/entities.ts），而且網頁版只有按「同步」時才抓最近 14 天；
 * 很久沒在這台按同步，那段時間這台就沒有紀錄，「之前的週」會把有做的課算成沒做. 所以記下這台抓過的日期範圍
 * （每次同步、匯入完整歷史、補抓成功後加上），之前的週照它判斷「這台有沒有那段時間的紀錄」，沒有的補抓一次.
 * 存在這台的快照（不同步）：每台抓過的範圍不一樣.
 */
import { addDays } from "./dates";
import type { Db } from "./db";
import type { ActivitySource } from "./types";

/** 快照的名稱 */
export const SNAPSHOT_ACTIVITY_COVERAGE = "activity_coverage";

/** 一段抓過的日期（含頭尾） */
export type CoverageRange = [from: string, to: string];

/** 合併重疊或相鄰的範圍，舊的在前 */
export function mergeRanges(ranges: CoverageRange[]): CoverageRange[] {
  const sorted = ranges.filter(([from, to]) => from <= to).sort((a, b) => a[0].localeCompare(b[0]));
  const merged: CoverageRange[] = [];
  for (const [from, to] of sorted) {
    const last = merged.at(-1);
    if (last && from <= addDays(last[1], 1)) {
      if (to > last[1]) last[1] = to;
    } else {
      merged.push([from, to]);
    }
  }
  return merged;
}

/** [from, to] 整段都抓過 */
export function isCovered(ranges: CoverageRange[], from: string, to: string): boolean {
  return ranges.some(([a, b]) => a <= from && b >= to);
}

export async function getCoverage(db: Db): Promise<CoverageRange[]> {
  const saved = await db.getSnapshot<CoverageRange[]>(SNAPSHOT_ACTIVITY_COVERAGE);
  return Array.isArray(saved?.value) ? saved.value.filter((r) => Array.isArray(r) && typeof r[0] === "string" && typeof r[1] === "string") : [];
}

/** 加上一段抓過的日期 */
export async function addCoverage(db: Db, from: string, to: string): Promise<void> {
  await db.saveSnapshot(SNAPSHOT_ACTIVITY_COVERAGE, mergeRanges([...(await getCoverage(db)), [from, to]]));
}

/** 補抓的結果 */
export interface BackfillResult {
  runs: number;
  others: number;
}

/**
 * 補抓一段期間的跑步與其他運動（一次請求）：只存紀錄，不產生分析（不花模型的費用），依活動 id 與時間去重，和匯入完整歷史一樣.
 * 成功後記下這段抓過了；來源沒帶其他運動、但本來就有其他運動的來源，不算抓過
 */
export async function backfillActivities(db: Db, source: ActivitySource, from: string, to: string): Promise<BackfillResult> {
  if (!source.fetchRunsBetween) throw new Error("這個資料來源不能補抓一段期間的紀錄。");
  const { runs, others } = await source.fetchRunsBetween(from, to);
  for (const run of runs) await db.saveWorkoutChecked(run);
  if (others?.length) {
    await db.upsertOtherActivities(others);
    // 之前匯入的檔案（騎車等）和 Intervals.icu 的同一趟：留 Intervals.icu 的（和同步一樣）
    await db.dropImportedOthersCoveredBy(others);
  }
  if (others || !source.fetchOtherActivities) await addCoverage(db, from, to);
  return { runs: runs.length, others: others?.length ?? 0 };
}

/** 快照的名稱：這台上次從 Intervals.icu 抓紀錄（同步、自動抓）的時間與最近一次的錯誤 */
export const SNAPSHOT_ACTIVITY_FETCH = "activity_fetch";

/** 上次抓紀錄：成功的時間；最近一次失敗的時間與訊息（之後成功了也留著，畫面只在比成功晚時顯示） */
export interface FetchStatus {
  at: string | null;
  error: string | null;
  errorAt: string | null;
}

export async function getFetchStatus(db: Db): Promise<FetchStatus | null> {
  return (await db.getSnapshot<FetchStatus>(SNAPSHOT_ACTIVITY_FETCH))?.value ?? null;
}

/** 記下一次抓紀錄的結果；error 是 null 時是成功 */
export async function recordFetch(db: Db, now: string, error: string | null): Promise<FetchStatus> {
  const before = (await getFetchStatus(db)) ?? { at: null, error: null, errorAt: null };
  const next = error === null ? { ...before, at: now } : { ...before, error, errorAt: now };
  await db.saveSnapshot(SNAPSHOT_ACTIVITY_FETCH, next);
  return next;
}
