/**
 * 檔案讀出來的活動 → 紀錄（規格 12.40「讀 FIT 檔」，12.37「不分來源的核心」）.
 *
 * 只存摘要，不存每秒的資料（現有的功能用不到）：日期、類型、距離、時間、心率、配速、爬升、卡路里，
 * 原始資料（raw_json）用和 Intervals.icu 一樣的欄位名稱，detailsOf、去重、負荷、Garmin 的標示都照原本的讀法.
 * 心率區間的時間：知道選手的心率區間時用每秒的心率算好存進去（和 Intervals.icu 的 icu_hr_zone_times 同格式）.
 */
import { sportOfType } from "../sports";
import type { Activity, OtherActivity, Sport, SportSettings, RunSettings } from "../types";
import type { ParsedActivity } from "./types";

/** 匯入的運動：跑步、騎車、游泳、肌力訓練；走路、健行等不匯入（和工作單一致） */
export const IMPORT_SPORTS: readonly Sport[] = ["run", "ride", "swim", "strength"];

/** 心率區間：各區的上限（由低到高）、閾值心率，與是哪一組（之後區間改了也看得出是用哪組算的） */
export interface HrZoneBasis {
  bounds: number[];
  lthr: number | null;
  /** intervals：Intervals.icu 的運動設定；profile：選手資料的實測最大心率換算的（只有跑步） */
  source: "intervals" | "profile";
}

/**
 * 這項運動的心率區間：Intervals.icu 各運動的設定，跑步沒有時用跑步設定；都沒有的跑步用選手資料換算的
 * （training-values 的 heartRateInfo，來源是實測的最大心率時才用；220 − 年齡的估計不用）
 */
export function zoneBasisFor(
  type: string,
  sportSettings: SportSettings[] | null,
  runSettings: RunSettings | null,
  profile: { bounds: number[]; lthr: number | null } | null = null,
): HrZoneBasis | null {
  const isRun = sportOfType(type) === "run";
  const own = sportSettings?.find((s) => s.types.includes(type)) ?? sportSettings?.find((s) => s.types.some((t) => sportOfType(t) === sportOfType(type)));
  const zones = own?.hr_zones ?? (isRun ? runSettings?.hr_zones : null);
  const lthr = own?.lthr ?? (isRun ? (runSettings?.lthr ?? null) : null);
  const bounds = (zones ?? []).filter((z) => Number.isFinite(z) && z > 0);
  if (bounds.length >= 3) return { bounds, lthr, source: "intervals" };
  if (isRun && profile && profile.bounds.length >= 3) return { bounds: profile.bounds, lthr: profile.lthr, source: "profile" };
  return null;
}

/** 每秒的心率 → 各區的秒數（兩點相差超過 30 秒的當成暫停，只算 1 秒） */
export function hrZoneTimes(samples: { t: number; bpm: number }[], bounds: number[]): number[] | null {
  if (samples.length < 2 || !bounds.length) return null;
  const out = bounds.map(() => 0);
  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1];
    const gap = next ? (next.t - samples[i]!.t) / 1000 : 1;
    const secs = gap > 0 && gap <= 30 ? gap : 1;
    const bpm = samples[i]!.bpm;
    let zone = bounds.findIndex((b) => bpm <= b);
    if (zone < 0) zone = bounds.length - 1;
    out[zone]! += secs;
  }
  return out.map((s) => Math.round(s));
}

/** 這一趟在各裝置上共通的名字：運動與開始時間（到分鐘）的雜湊. 同一個檔重複匯入、兩台各匯一次都一樣 */
export async function fileActivityId(p: Pick<ParsedActivity, "type" | "startUtc">): Promise<string> {
  const key = `${sportOfType(p.type)}|${p.startUtc.slice(0, 16)}`;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const round1 = (v: number) => Math.round(v * 10) / 10;

function paceOf(distanceM: number | null, seconds: number | null): string | null {
  if (!distanceM || !seconds || distanceM <= 0) return null;
  const perKm = Math.round(seconds / (distanceM / 1000));
  if (perKm <= 0 || perKm > 60 * 60) return null;
  return `${Math.floor(perKm / 60)}:${String(perKm % 60).padStart(2, "0")}/km`;
}

/** 算好心率區間的時間，清掉每秒的心率（掃大檔時不佔記憶體） */
export function withHrZones(p: ParsedActivity, zones: HrZoneBasis | null): ParsedActivity {
  const times = zones ? hrZoneTimes(p.hrSamples, zones.bounds) : null;
  return { ...p, hrSamples: [], hrZones: times && zones ? { times, bounds: zones.bounds, lthr: zones.lthr, source: zones.source } : (p.hrZones ?? null) };
}

/** 原始資料：和 Intervals.icu 的活動一樣的欄位名稱（只放有值的） */
export function rawOf(p: ParsedActivity): Record<string, unknown> {
  const raw: Record<string, unknown> = {
    source: "FILE",
    file_type: p.format,
    type: p.type,
    start_date_local: p.startLocal,
    start_date: p.startUtc,
  };
  const put = (k: string, v: unknown) => {
    if (v !== null && v !== undefined) raw[k] = v;
  };
  put("elapsed_time", p.elapsedSec);
  put("moving_time", p.movingSec);
  put("distance", p.distanceM !== null ? Math.round(p.distanceM) : null);
  put("average_heartrate", p.avgHr);
  put("max_heartrate", p.maxHr);
  put("total_elevation_gain", p.elevationGainM);
  put("calories", p.calories);
  put("average_cadence", p.avgCadence);
  put("average_watts", p.avgPower);
  // 製造商是 Garmin、型號不知道時寫「Garmin」：garminLabelOf 看 device_name 開頭的 Garmin
  put("device_name", p.device ?? (p.garmin ? "Garmin" : null));
  if (p.laps.length > 1) put("laps", p.laps);
  if (p.hrZones) {
    // 欄位名稱沿用 Intervals.icu 的（detailsOf 這樣讀）；是匯入時用選手當時的區間算的
    raw.icu_hr_zone_times = p.hrZones.times;
    raw.icu_hr_zones = p.hrZones.bounds;
    if (p.hrZones.lthr) raw.lthr = p.hrZones.lthr;
    // 用哪一組區間算的、什麼時候匯入的
    raw.hr_zones_source = p.hrZones.source === "intervals" ? "Intervals.icu 的運動設定" : "選手資料的最大心率";
  }
  return raw;
}

export type ImportRecord =
  | { kind: "run"; id: string; activity: Activity }
  | { kind: "other"; id: string; activity: OtherActivity };

/** 一趟 → 要存的紀錄：跑步進 workouts（source 'file'），其他運動進 other_activities（id 是 file:<雜湊>） */
export async function importRecordOf(p: ParsedActivity): Promise<ImportRecord> {
  const id = await fileActivityId(p);
  const raw = rawOf(p);
  const seconds = p.movingSec ?? p.elapsedSec;
  const date = p.startLocal.slice(0, 10);
  const distanceKm = p.distanceM ? Math.round(p.distanceM / 10) / 100 : null;
  if (sportOfType(p.type) === "run") {
    return {
      kind: "run",
      id,
      activity: {
        source: "file",
        date,
        type: "run",
        distance_km: distanceKm,
        duration_min: seconds ? round1(seconds / 60) : null,
        avg_hr: p.avgHr,
        max_hr: p.maxHr,
        avg_pace: paceOf(p.distanceM, seconds),
        elevation_m: p.elevationGainM,
        calories: p.calories,
        training_load: null,
        raw_json: JSON.stringify(raw),
      },
    };
  }
  return {
    kind: "other",
    id,
    activity: {
      intervals_id: `file:${id}`,
      date,
      type: p.type,
      duration_min: seconds ? round1(seconds / 60) : null,
      distance_km: distanceKm,
      avg_hr: p.avgHr,
      training_load: null,
      raw_json: JSON.stringify(raw),
    },
  };
}
