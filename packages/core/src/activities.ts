/**
 * 不分來源的紀錄（規格 12.37「不分來源的核心」）.
 *
 * 紀錄從哪裡來（Intervals.icu、手動、之後的 Apple 健康與 Health Connect、FIT／GPX 檔）都轉成同一個格式：
 * - `ActivityRecord`：不分運動、不分來源的一筆，核心讀紀錄都經過 `Db.getActivities`.
 * - `detailsOf`：來源的原始資料（`raw_json`）只在這裡讀，轉成 `SourceDetails`（開始時間、心率區間的時間、
 *   來源算好的負荷與體能疲勞、功率等）. 核心其他地方不直接解讀 `raw_json`.
 *
 * 資料表這一版不變（schema 19）：跑步仍在 `workouts`（Intervals.icu、手動、舊的 Strava 與匯入），
 * 其他運動仍在 `other_activities`（Intervals.icu 的快取）. 兩張表在 Db 裡合成同一組查詢；
 * 之後要搬成一張表時只改 Db 內部（規格 12.37 的「實作」）.
 */
import { sportOfType } from "./sports";
import type { OtherActivity, Workout } from "./types";

/** 從來源的原始資料抽出來、核心用得到的細節；沒有的是 null */
export interface SourceDetails {
  /** 當地開始時間（來源給的字串，例：2026-10-19T07:12:00） */
  startLocal: string | null;
  /** UTC 開始時間（來源給的字串）；只有 startLocal 不在時拿來比對重疊 */
  startUtc: string | null;
  /** 經過時間與移動時間（秒，> 0） */
  elapsedSec: number | null;
  movingSec: number | null;
  /** 各心率區間的時間（秒）與區間的上限（bpm），以及那趟的閾值心率 */
  hrZoneTimes: number[] | null;
  hrZones: number[] | null;
  lthr: number | null;
  /** 來源算好的負荷（Intervals.icu 的 icu_training_load） */
  load: number | null;
  /** 來源算好的、這趟當時的體能與疲勞（Intervals.icu 的 icu_ctl、icu_atl） */
  ctl: number | null;
  atl: number | null;
  /** 騎車：由紀錄估的 FTP（icu_eftp） */
  eftp: number | null;
  /** 裝置量的最高心率、爬升、踏頻（> 0） */
  maxHr: number | null;
  elevationM: number | null;
  cadence: number | null;
  /** 平均功率、標準化功率（瓦，> 0；icu_ 開頭的是 Intervals.icu 算的，沒有時用裝置的） */
  watts: number | null;
  normalizedWatts: number | null;
  /** 裝置量的平均氣溫（°C） */
  avgTempC: number | null;
  /** 功率區間的時間（Intervals.icu 的 icu_zone_times：Z1、Z2…與甜蜜點等） */
  powerZoneTimes: { id: string; secs: number }[] | null;
}

const EMPTY: SourceDetails = Object.freeze({
  startLocal: null,
  startUtc: null,
  elapsedSec: null,
  movingSec: null,
  hrZoneTimes: null,
  hrZones: null,
  lthr: null,
  load: null,
  ctl: null,
  atl: null,
  eftp: null,
  maxHr: null,
  elevationM: null,
  cadence: null,
  watts: null,
  normalizedWatts: null,
  avgTempC: null,
  powerZoneTimes: null,
}) as SourceDetails;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const positive = (v: unknown): number | null => {
  const n = num(v);
  return n !== null && n > 0 ? n : null;
};
const numbers = (v: unknown): number[] | null =>
  Array.isArray(v) && v.every((x) => typeof x === "number" && Number.isFinite(x)) ? (v as number[]) : null;
const text = (v: unknown): string | null => (typeof v === "string" ? v : null);

/**
 * Intervals.icu 的活動（測試模式的假資料、舊的 Strava 紀錄也是同樣的欄位）→ 細節.
 * 原始資料是 null 或壞掉時每一項都是 null.
 */
export function detailsFromIntervals(raw: Record<string, unknown>): SourceDetails {
  const zones = Array.isArray(raw.icu_zone_times)
    ? (raw.icu_zone_times as { id?: unknown; secs?: unknown }[]).map((z) => ({ id: String(z?.id ?? ""), secs: typeof z?.secs === "number" ? z.secs : 0 }))
    : null;
  return {
    startLocal: text(raw.start_date_local),
    startUtc: text(raw.start_date),
    elapsedSec: positive(raw.elapsed_time),
    movingSec: positive(raw.moving_time),
    hrZoneTimes: numbers(raw.icu_hr_zone_times),
    hrZones: numbers(raw.icu_hr_zones),
    lthr: num(raw.lthr),
    load: num(raw.icu_training_load),
    ctl: num(raw.icu_ctl),
    atl: num(raw.icu_atl),
    eftp: num(raw.icu_eftp),
    maxHr: positive(raw.max_heartrate),
    elevationM: positive(raw.total_elevation_gain),
    cadence: positive(raw.average_cadence),
    watts: positive(raw.icu_average_watts) ?? positive(raw.average_watts),
    normalizedWatts: positive(raw.icu_weighted_avg_watts) ?? positive(raw.weighted_average_watts),
    avgTempC: num(raw.average_temp),
    powerZoneTimes: zones,
  };
}

/** 解析過的原始資料（同一個字串常被讀好幾次：強度分配、比對、去重） */
const cache = new Map<string, SourceDetails>();
const CACHE_MAX = 500;

/** 一筆紀錄的原始資料 → 細節. 這是核心唯一解讀 raw_json 的地方 */
export function detailsOf(rawJson: string | null | undefined): SourceDetails {
  if (!rawJson) return EMPTY;
  const hit = cache.get(rawJson);
  if (hit) return hit;
  let details = EMPTY;
  try {
    const raw: unknown = JSON.parse(rawJson);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) details = detailsFromIntervals(raw as Record<string, unknown>);
  } catch {
    // 壞掉的原始資料：當成沒有
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
  cache.set(rawJson, details);
  return details;
}

/** 恢復資料（Intervals.icu 的 wellness）裡它算好的體能、疲勞與每週變化；沒有時是 null */
export function wellnessFitnessOf(rawJson: string | null | undefined): { ctl: number | null; atl: number | null; rampRate: number | null } {
  try {
    const raw: unknown = rawJson ? JSON.parse(rawJson) : null;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ctl: null, atl: null, rampRate: null };
    const r = raw as Record<string, unknown>;
    return { ctl: num(r.ctl), atl: num(r.atl), rampRate: num(r.rampRate) };
  } catch {
    return { ctl: null, atl: null, rampRate: null };
  }
}

/** 紀錄的來源 */
export type ActivitySourceKind = "intervals" | "manual" | "strava" | "fake" | "import" | "other";

/** 不分運動、不分來源的一筆紀錄 */
export interface ActivityRecord {
  /** 在這台上唯一的名字：跑步 w:<id>、其他運動 o:<Intervals.icu 的 id> */
  key: string;
  /** workouts 的 id（跑步）；其他運動是 null */
  workoutId: number | null;
  /** 來源的 id（Intervals.icu 的活動 id）；手動的是 null */
  intervalsId: string | null;
  /** run、ride、swim、strength、other（sports.ts） */
  sport: string;
  /** 來源的類型，例：run、Ride、WeightTraining */
  type: string;
  source: ActivitySourceKind;
  date: string;
  duration_min: number | null;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace: string | null;
  elevation_m: number | null;
  /** 來源算好的負荷（現在只有 Intervals.icu 的）；我們自己估的見 load.ts */
  training_load: number | null;
  perceived_effort: number | null;
  subjective_notes: string | null;
  summary: string | null;
  details: SourceDetails;
}

function sourceKind(source: string | null | undefined, intervalsId: string | null): ActivitySourceKind {
  if (source === "manual" || source === "fake" || source === "strava" || source === "intervals" || source === "import") return source;
  if (!source) return intervalsId ? "intervals" : "other";
  return "other";
}

/** workouts 的一筆（跑步：Intervals.icu、手動、舊的 Strava 與匯入）→ 紀錄 */
export function recordOfWorkout(w: Workout): ActivityRecord {
  return {
    key: `w:${w.id}`,
    workoutId: w.id,
    intervalsId: w.intervals_id ?? null,
    sport: "run",
    type: w.type ?? "run",
    source: sourceKind(w.source, w.intervals_id ?? null),
    date: w.date,
    duration_min: w.duration_min ?? null,
    distance_km: w.distance_km ?? null,
    avg_hr: w.avg_hr ?? null,
    max_hr: w.max_hr ?? null,
    avg_pace: w.avg_pace ?? null,
    elevation_m: w.elevation_m ?? null,
    training_load: w.training_load ?? null,
    perceived_effort: w.perceived_effort ?? null,
    subjective_notes: w.subjective_notes ?? null,
    summary: w.summary ?? null,
    details: detailsOf(w.raw_json),
  };
}

/** other_activities 的一筆（Intervals.icu 的快取，含選手回報的體感與分析）→ 紀錄 */
export function recordOfOther(a: OtherActivity): ActivityRecord {
  const details = detailsOf(a.raw_json);
  return {
    key: `o:${a.intervals_id}`,
    workoutId: null,
    intervalsId: a.intervals_id,
    sport: sportOfType(a.type),
    type: a.type,
    source: a.intervals_id.startsWith("fake-") ? "fake" : "intervals",
    date: a.date,
    duration_min: a.duration_min ?? null,
    distance_km: a.distance_km ?? null,
    avg_hr: a.avg_hr ?? null,
    max_hr: details.maxHr,
    avg_pace: null,
    elevation_m: details.elevationM,
    training_load: a.training_load ?? null,
    perceived_effort: a.perceived_effort ?? null,
    subjective_notes: a.subjective_notes ?? null,
    summary: a.summary ?? null,
    details,
  };
}

/** 新的在前；同一天的依開始時間，沒有時間的排後面 */
export function byNewest(a: ActivityRecord, b: ActivityRecord): number {
  return b.date.localeCompare(a.date) || (b.details.startLocal ?? "").localeCompare(a.details.startLocal ?? "");
}
