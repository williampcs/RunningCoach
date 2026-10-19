/**
 * 同一趟跑步的判斷：同一個人不可能同時跑兩趟，所以時間重疊就是同一趟.
 *
 * 同一趟可能經不同路徑進來（Garmin 直接上傳 Intervals.icu、經「健康」由 Intervals.icu Companion 上傳，
 * 之後的手動新增或 HealthKit），各來源的開始與結束常差幾十秒到幾分鐘，
 * 所以看重疊佔較短那筆的比例，不要求開始時間相同。
 */
import type { Activity } from "./types";

/** 重疊達較短那筆的這個比例，視為同一趟並自動合併 */
const OVERLAP_RATIO = 0.5;
/** 沒有時間可比時，距離與時長都相差這個比例以內，才問選手是不是同一趟 */
const SIMILAR_RATIO = 0.05;

export interface TimeRange {
  start: number;
  end: number;
}

export type RunLike = Pick<Activity, "date" | "distance_km" | "duration_min" | "avg_hr" | "training_load"> & {
  raw_json?: string | null;
};

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * 原始資料中的時間區間：當地開始時間加上經過時間；缺任何一項時為 null.
 * 當地時間不帶時區，一律當成 UTC 解讀：只用來比較同一個人的兩筆紀錄，彼此一致即可。
 */
export function timeRangeOf(rawJson: string | null | undefined): TimeRange | null {
  if (!rawJson) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    return null;
  }
  const text =
    typeof raw.start_date_local === "string" ? raw.start_date_local : typeof raw.start_date === "string" ? raw.start_date : null;
  const seconds = num(raw.elapsed_time) ?? num(raw.moving_time);
  if (!text || !seconds) return null;
  const start = Date.parse(`${text.replace(/(Z|[+-]\d{2}:?\d{2})$/, "")}Z`);
  return Number.isFinite(start) ? { start, end: start + seconds * 1000 } : null;
}

/** 重疊的時間佔較短那筆的比例，0～1 */
export function overlapRatio(a: TimeRange, b: TimeRange): number {
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  const shorter = Math.min(a.end - a.start, b.end - b.start);
  return overlap > 0 && shorter > 0 ? overlap / shorter : 0;
}

/** 高可信度：兩筆都有時間，而且重疊達較短那筆的一半 */
export function sameRun(a: RunLike, b: RunLike): boolean {
  const ra = timeRangeOf(a.raw_json);
  const rb = timeRangeOf(b.raw_json);
  return ra !== null && rb !== null && overlapRatio(ra, rb) >= OVERLAP_RATIO;
}

const close = (x: number | null, y: number | null) =>
  x !== null && y !== null && Math.max(x, y) > 0 && Math.abs(x - y) / Math.max(x, y) <= SIMILAR_RATIO;

/** 低可信度：至少一筆沒有時間時，同一天、距離與時長都相差 5% 以內。兩筆都有時間時以重疊為準 */
export function maybeSameRun(a: RunLike, b: RunLike): boolean {
  if (timeRangeOf(a.raw_json) && timeRangeOf(b.raw_json)) return false;
  return a.date === b.date && close(a.distance_km, b.distance_km) && close(a.duration_min, b.duration_min);
}

/** 保留哪一筆：有心率優先，其次有訓練負荷；分數相同時保留先進來的 */
export function keepScore(w: Pick<RunLike, "avg_hr" | "training_load">): number {
  return (w.avg_hr != null ? 2 : 0) + (w.training_load != null ? 1 : 0);
}
