/**
 * 匯入完整歷史（規格 12.5、12.9）：從今天往回一次抓一年的跑步，直接存入，不產生 AI 分析（不花模型的費用），
 * 也不合併等待同步的跑後回報. 依活動 id 與時間重疊去重，可以重跑；中斷了再按一次即可.
 */
import { addDays } from "./dates";
import type { Db } from "./db";
import type { ActivitySource } from "./types";

/** 一次抓多少天 */
const CHUNK_DAYS = 365;
/** 連續幾段沒有跑步就停 */
const STOP_AFTER_EMPTY = 2;
/** 最多往回幾段（年） */
const MAX_CHUNKS = 30;

export interface ImportProgress {
  /** 這一段的起訖 */
  oldest: string;
  newest: string;
  /** 到目前為止抓到的跑步 */
  found: number;
}

export interface ImportResult {
  /** 新存入的 */
  added: number;
  /** 已經有的（依活動 id） */
  existing: number;
  /** 和既有的一筆是同一趟，合併 */
  merged: number;
  /** 來源列出、但拿不到內容的活動（從 Strava 匯入 Intervals.icu 的） */
  unavailable: number;
  /** 抓到的最早一趟 */
  earliest: string | null;
  /** 每年的趟數，舊的在前 */
  perYear: { year: string; runs: number }[];
}

export async function importHistory(
  db: Db,
  source: ActivitySource,
  today: string,
  onProgress?: (p: ImportProgress) => void,
): Promise<ImportResult> {
  if (!source.fetchRunsBetween) throw new Error("這個資料來源不支援匯入完整歷史。");
  const result: ImportResult = { added: 0, existing: 0, merged: 0, unavailable: 0, earliest: null, perYear: [] };
  const years = new Map<string, number>();
  let newest = today;
  let empty = 0;
  let found = 0;
  for (let i = 0; i < MAX_CHUNKS && empty < STOP_AFTER_EMPTY; i++) {
    const oldest = addDays(newest, -(CHUNK_DAYS - 1));
    onProgress?.({ oldest, newest, found });
    const { runs, unavailable } = await source.fetchRunsBetween(oldest, newest);
    result.unavailable += unavailable;
    empty = runs.length || unavailable ? 0 : empty + 1;
    for (const run of runs) {
      const saved = await db.saveWorkoutChecked(run);
      if (saved.status === "new") result.added++;
      else if (saved.status === "existing") result.existing++;
      else result.merged++;
      found++;
      years.set(run.date.slice(0, 4), (years.get(run.date.slice(0, 4)) ?? 0) + 1);
      if (!result.earliest || run.date < result.earliest) result.earliest = run.date;
    }
    newest = addDays(oldest, -1);
  }
  result.perYear = [...years.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, runs]) => ({ year, runs }));
  onProgress?.({ oldest: newest, newest, found });
  return result;
}
