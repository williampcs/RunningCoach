/** 從檔案讀出來的一趟活動（FIT、GPX、TCX 共用的格式；還沒轉成紀錄） */
export interface ParsedLap {
  distance_m: number | null;
  time_s: number | null;
  avg_hr: number | null;
  max_hr: number | null;
}

export interface ParsedActivity {
  format: "fit" | "gpx" | "tcx";
  /** 和 Intervals.icu 一樣的活動類型（Run、Ride、Swim、WeightTraining…） */
  type: string;
  /** UTC 開始時間（ISO，帶 Z） */
  startUtc: string;
  /** 當地開始時間（不帶時區，例：2026-10-19T07:12:00） */
  startLocal: string;
  elapsedSec: number | null;
  movingSec: number | null;
  distanceM: number | null;
  avgHr: number | null;
  maxHr: number | null;
  elevationGainM: number | null;
  calories: number | null;
  avgCadence: number | null;
  avgPower: number | null;
  /** 裝置（例：Garmin Forerunner 265、Garmin、COROS PACE 3）；不知道時 null */
  device: string | null;
  /** 製造商是 Garmin（KI-048 的標示） */
  garmin: boolean;
  laps: ParsedLap[];
  /** 每秒的心率（UTC 毫秒），只用來算心率區間的時間，不存（算完就清掉，掃大檔時不佔記憶體） */
  hrSamples: { t: number; bpm: number }[];
  /** 各心率區間的秒數，與算的時候用的區間上限、閾值心率（convert.ts 的 withHrZones）；不知道區間時沒有 */
  hrZones?: { times: number[]; bounds: number[]; lthr: number | null; source: "intervals" | "profile" } | null;
}
