/**
 * 訓練數值：心率區間、Daniels 的配速、臨界速度、強度分配與負荷（規格 12.8）.
 *
 * 數字由程式算，教練只負責解釋與調整：同樣的資料每次得到同樣的數字，每個數值都標明來源。
 * - 心率：依序取 Intervals.icu 的跑步設定（閾值心率與區間）、選手資料的實測最大心率、220－年齡。
 * - 配速：Daniels 的 VDOT，由最近 90 天的比賽成績或最佳表現推算；臨界速度只拿來對照。
 * - 強度分配：Intervals.icu 算好的各心率區間時間，依閾值心率分成低、中、高（80/20）。
 */
import { addDays, daysBetween, isoWeekLabel, weekdayIndex } from "./dates";
import type { Db } from "./db";
import { formatPace } from "./fake-activities";
import type { PaceCurveSummary, Race, RunSettings, Workout } from "./types";

/** 推算 VDOT 用的比賽與最佳表現，只看最近這麼多天：太久以前的成績不代表現在的體能 */
export const VDOT_LOOKBACK_DAYS = 90;
/** 強度分配與 session RPE 看最近這麼多天 */
const DISTRIBUTION_DAYS = 28;
/** Daniels 的公式適用的範圍：1.5 km 以上、3.5 分鐘到 5 小時 */
const MIN_VDOT_DISTANCE_M = 1500;
const MIN_VDOT_MINUTES = 3.5;
const MAX_VDOT_MINUTES = 300;
/** 最高的 VDOT 比第二高的多出這個比例時，視為 GPS 誤差之類的異常，改用第二高的（比賽成績除外） */
const OUTLIER_RATIO = 1.08;
/** 低強度：區間上限不超過閾值心率的 90%（約第一閾值以下）；中強度到閾值心率為止，再上去是高強度 */
const LOW_MAX_OF_LTHR = 0.9;
/** 沒有閾值心率時，Daniels 的輕鬆跑心率上限（最大心率的 79%） */
const EASY_MAX_OF_HRMAX = 0.79;

// ---------------------------------------------------------------------------
// Daniels 與 Gilbert 的公式
// ---------------------------------------------------------------------------

/** 以速度 v（公尺／分鐘）跑步的攝氧量，ml/kg/min */
function vo2AtVelocity(v: number): number {
  return -4.6 + 0.182258 * v + 0.000104 * v * v;
}

/** 能以多少比例的最大攝氧量持續 t 分鐘 */
function sustainableFraction(t: number): number {
  return 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
}

/** 攝氧量對應的速度（公尺／分鐘），vo2AtVelocity 的近似反函數 */
function velocityAtVo2(vo2: number): number {
  return 29.54 + 5.000663 * vo2 - 0.007546 * vo2 * vo2;
}

function rawVdot(distanceM: number, secs: number): number {
  const minutes = secs / 60;
  return vo2AtVelocity(distanceM / minutes) / sustainableFraction(minutes);
}

/** 一次全力跑的 VDOT；超出公式的適用範圍時為 null */
export function vdotOf(distanceM: number, secs: number): number | null {
  const minutes = secs / 60;
  if (distanceM < MIN_VDOT_DISTANCE_M || minutes < MIN_VDOT_MINUTES || minutes > MAX_VDOT_MINUTES) return null;
  return rawVdot(distanceM, secs);
}

/** 以 VDOT 推算某個距離的完賽秒數 */
export function predictSecs(vdot: number, distanceM: number): number {
  // 越慢 VDOT 越低，二分搜尋
  let lo = 30;
  let hi = 12 * 3600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (rawVdot(distanceM, mid) > vdot) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** Daniels 的訓練配速，每公里秒數；easy 是範圍（快、慢） */
export interface DanielsPaces {
  easy: [number, number];
  marathon: number;
  threshold: number;
  interval: number;
  repetition: number;
}

/** E 為最大攝氧量的 59–74%，T 為 88%，I 為 97.5%，R 為 105%，M 為推算的全馬配速 */
export function danielsPaces(vdot: number): DanielsPaces {
  const at = (fraction: number) => 60_000 / velocityAtVo2(vdot * fraction);
  return {
    easy: [at(0.74), at(0.59)],
    marathon: predictSecs(vdot, 42_195) / 42.195,
    threshold: at(0.88),
    interval: at(0.975),
    repetition: at(1.05),
  };
}

// ---------------------------------------------------------------------------
// VDOT 的來源
// ---------------------------------------------------------------------------

export interface VdotEstimate {
  value: number;
  /** race：選手回報的比賽成績；race_effort：Intervals.icu 標為比賽的活動；best_effort：訓練中的最佳表現 */
  kind: "race" | "race_effort" | "best_effort";
  distanceM: number;
  secs: number;
  date: string | null;
  name?: string;
}

/** 「1:52:30」「52:30」→ 秒；無法解讀時為 null */
export function parseDuration(text: string | null | undefined): number | null {
  const m = /^\s*(?:(\d{1,2}):)?(\d{1,2}):(\d{2})(?:\.\d+)?\s*$/.exec(text ?? "");
  if (!m) return null;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** 最近 90 天的比賽成績與最佳表現中，VDOT 最高的一個 */
export function estimateVdot(races: Race[], curve: PaceCurveSummary | null, today: string): VdotEstimate | null {
  const since = addDays(today, -VDOT_LOOKBACK_DAYS);
  const candidates: VdotEstimate[] = [];
  for (const r of races) {
    const secs = parseDuration(r.result_time);
    if (r.cancelled || secs === null || r.date < since || r.date > today) continue;
    const value = vdotOf(r.distance_km * 1000, secs);
    if (value !== null) candidates.push({ value, kind: "race", distanceM: r.distance_km * 1000, secs, date: r.date, name: r.name });
  }
  for (const e of curve?.efforts ?? []) {
    const value = vdotOf(e.distance_m, e.secs);
    if (value !== null) {
      candidates.push({ value, kind: e.race ? "race_effort" : "best_effort", distanceM: e.distance_m, secs: e.secs, date: e.date });
    }
  }
  candidates.sort((a, b) => b.value - a.value);
  const [top, second] = candidates;
  if (top && second && top.kind !== "race" && top.value > second.value * OUTLIER_RATIO) return second;
  return top ?? null;
}

// ---------------------------------------------------------------------------
// 心率
// ---------------------------------------------------------------------------

export interface HeartRateInfo {
  /** intervals：Intervals.icu 的跑步設定；profile：選手資料的實測最大心率；estimate：220－年齡 */
  source: "intervals" | "profile" | "estimate";
  maxHr: number | null;
  lthr: number | null;
  /** 各區的名稱與範圍；min 為 null 表示沒有下限 */
  zones: { name: string; min: number | null; max: number }[];
  /** 輕鬆跑的心率上限 */
  easyMax: number;
  easyMaxNote: string;
}

/** 純整數字串才視為數字 */
function intOf(value: string | undefined): number | null {
  return value !== undefined && /^\s*\d+\s*$/.test(value) ? Number(value) : null;
}

/** Intervals.icu 預設的跑步心率區間有 7 區（Friel） */
const SEVEN_ZONE_NAMES = ["Z1", "Z2", "Z3", "Z4", "Z5a", "Z5b", "Z5c"];

export function heartRateInfo(profile: Record<string, string>, settings: RunSettings | null, today: string): HeartRateInfo | null {
  const measuredMax = intOf(profile.max_hr);
  const zones = settings?.hr_zones?.filter((z) => Number.isFinite(z) && z > 0) ?? [];
  if (settings?.lthr && zones.length >= 3) {
    const lthr = settings.lthr;
    const names = zones.length === 7 ? SEVEN_ZONE_NAMES : zones.map((_, i) => `Z${i + 1}`);
    const lows = zones.filter((z) => z <= lthr * LOW_MAX_OF_LTHR);
    const lowTop = lows.length ? lows[lows.length - 1]! : Math.floor(lthr * LOW_MAX_OF_LTHR);
    return {
      source: "intervals",
      maxHr: measuredMax ?? settings.max_hr ?? zones[zones.length - 1]!,
      lthr,
      zones: zones.map((max, i) => ({ name: names[i]!, min: i === 0 ? null : zones[i - 1]! + 1, max })),
      easyMax: lowTop,
      easyMaxNote: lows.length
        ? `${names[lows.length - 1]} 的上限，約閾值心率的 ${Math.round((lowTop / lthr) * 100)}%`
        : "閾值心率的 90%",
    };
  }

  const birthYear = intOf(profile.birth_year);
  const age = birthYear !== null ? Number(today.slice(0, 4)) - birthYear : null;
  // 填了但不是數字時不推算，也不用推算值蓋掉使用者的輸入
  const maxHr = measuredMax ?? (profile.max_hr || age === null ? null : 220 - age);
  if (!maxHr) return null;
  // 最大心率的 60／70／80／90%，以整數百分比計算，與系統提示的區間相同
  const [z1, z2, z3, z4] = [60, 70, 80, 90].map((pct) => Math.floor((maxHr * pct) / 100)) as [number, number, number, number];
  return {
    source: measuredMax ? "profile" : "estimate",
    maxHr,
    lthr: null,
    zones: [
      { name: "Z1", min: null, max: z1 - 1 },
      { name: "Z2", min: z1, max: z2 },
      { name: "Z3", min: z2 + 1, max: z3 },
      { name: "Z4", min: z3 + 1, max: z4 },
      { name: "Z5", min: z4 + 1, max: maxHr },
    ],
    easyMax: Math.floor(maxHr * EASY_MAX_OF_HRMAX),
    easyMaxNote: "Daniels 的輕鬆跑上限，最大心率的 79%",
  };
}

export const HR_SOURCE_LABELS: Record<HeartRateInfo["source"], string> = {
  intervals: "Intervals.icu 的跑步設定",
  profile: "選手資料的實測最大心率",
  estimate: "以 220－年齡推算，個人差異常超過 10 bpm",
};

export function zonesText(hr: HeartRateInfo): string {
  return hr.zones.map((z) => `${z.name} ${z.min === null ? `≤${z.max}` : `${z.min}–${z.max}`}`).join("｜");
}

// ---------------------------------------------------------------------------
// 強度分配、每週的量、體能與疲勞
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>;

function parseRaw(json: string | null | undefined): Raw {
  if (!json) return {};
  try {
    const raw: unknown = JSON.parse(json);
    return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Raw) : {};
  } catch {
    return {};
  }
}

const numbers = (value: unknown): number[] | null =>
  Array.isArray(value) && value.every((x) => typeof x === "number" && Number.isFinite(x)) ? (value as number[]) : null;
const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export interface IntensityDistribution {
  runs: number;
  /** 有心率區間時間（與閾值心率）的次數 */
  withZones: number;
  lowSecs: number;
  moderateSecs: number;
  highSecs: number;
}

/**
 * 依各心率區間的時間分成低、中、高強度。用每筆活動自己記下的區間與閾值心率，
 * 和 Intervals.icu 算區間時間時用的一致；沒有閾值心率時退回 fallbackLthr。
 */
export function intensityDistribution(workouts: Workout[], fallbackLthr: number | null): IntensityDistribution {
  const out: IntensityDistribution = { runs: workouts.length, withZones: 0, lowSecs: 0, moderateSecs: 0, highSecs: 0 };
  for (const w of workouts) {
    const raw = parseRaw(w.raw_json);
    const times = numbers(raw.icu_hr_zone_times);
    const bounds = numbers(raw.icu_hr_zones);
    const lthr = num(raw.lthr) ?? fallbackLthr;
    if (!times?.length || !bounds?.length || !lthr) continue;
    out.withZones += 1;
    times.forEach((secs, i) => {
      // 時間比區間多一格時，最後一格在最高的上限之上
      const upper = bounds[i];
      if (upper === undefined || upper > lthr) out.highSecs += secs;
      else if (upper <= lthr * LOW_MAX_OF_LTHR) out.lowSecs += secs;
      else out.moderateSecs += secs;
    });
  }
  return out;
}

/** 沒有心率時，依體感（1–10）粗分：1–4 輕鬆、5–6 中等、7 以上高強度；以次數計 */
export function effortDistribution(workouts: Workout[]): { rated: number; low: number; moderate: number; high: number } {
  const out = { rated: 0, low: 0, moderate: 0, high: 0 };
  for (const w of workouts) {
    if (w.perceived_effort == null) continue;
    out.rated += 1;
    if (w.perceived_effort <= 4) out.low += 1;
    else if (w.perceived_effort <= 6) out.moderate += 1;
    else out.high += 1;
  }
  return out;
}

export interface WeekSummary {
  /** ISO 週，例：2026-W41 */
  label: string;
  /** 該週的星期一 */
  start: string;
  runs: number;
  km: number;
  minutes: number;
  /** 訓練負荷的合計；沒有一筆有負荷時為 null */
  load: number | null;
  /** session RPE（體感 × 分鐘）的合計；沒有一筆有體感時為 null */
  srpe: number | null;
  longestKm: number;
}

/** 最近 N 週（週一起算，含這週），舊的在前 */
export function weeklySummaries(workouts: Workout[], today: string, weeks: number): WeekSummary[] {
  const thisMonday = addDays(today, -weekdayIndex(today));
  const out: WeekSummary[] = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const start = addDays(thisMonday, -7 * i);
    const end = addDays(start, 6);
    const inWeek = workouts.filter((w) => w.date >= start && w.date <= end);
    const loads = inWeek.flatMap((w) => (w.training_load != null ? [w.training_load] : []));
    const srpes = inWeek.flatMap((w) =>
      w.perceived_effort != null && w.duration_min != null ? [w.perceived_effort * w.duration_min] : [],
    );
    out.push({
      label: isoWeekLabel(start),
      start,
      runs: inWeek.length,
      km: inWeek.reduce((sum, w) => sum + (w.distance_km ?? 0), 0),
      minutes: inWeek.reduce((sum, w) => sum + (w.duration_min ?? 0), 0),
      load: loads.length ? loads.reduce((a, b) => a + b, 0) : null,
      srpe: srpes.length ? Math.round(srpes.reduce((a, b) => a + b, 0)) : null,
      longestKm: Math.max(0, ...inWeek.map((w) => w.distance_km ?? 0)),
    });
  }
  return out;
}

export interface FitnessSnapshot {
  date: string;
  /** 體能（42 天的負荷平均） */
  ctl: number;
  /** 疲勞（7 天的負荷平均） */
  atl: number;
  /** 體能的每週變化 */
  rampRate: number | null;
  /** wellness：Intervals.icu 每天的值；activity：最近一筆跑步當時的值 */
  source: "wellness" | "activity";
}

/** 最新的體能與疲勞：優先用恢復資料（每天都有），沒有時用最近一筆跑步當時的值 */
export function latestFitness(wellness: { date: string; raw_json: string | null }[], workouts: Workout[]): FitnessSnapshot | null {
  for (const w of [...wellness].sort((a, b) => b.date.localeCompare(a.date))) {
    const raw = parseRaw(w.raw_json);
    const ctl = num(raw.ctl);
    const atl = num(raw.atl);
    if (ctl !== null && atl !== null) return { date: w.date, ctl, atl, rampRate: num(raw.rampRate), source: "wellness" };
  }
  for (const w of [...workouts].sort((a, b) => b.date.localeCompare(a.date))) {
    const raw = parseRaw(w.raw_json);
    const ctl = num(raw.icu_ctl);
    const atl = num(raw.icu_atl);
    if (ctl !== null && atl !== null) return { date: w.date, ctl, atl, rampRate: null, source: "activity" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 合起來：get_training_values 的內容
// ---------------------------------------------------------------------------

export interface TrainingValues {
  today: string;
  /** 最近 28 天的跑步中，各種資料有幾次：缺的不補、不估，只說明 */
  coverage: { runs: number; withHr: number; withZones: number; rated: number };
  hr: HeartRateInfo | null;
  vdot: VdotEstimate | null;
  paces: DanielsPaces | null;
  curve: PaceCurveSummary | null;
  /** Intervals.icu 設定的閾值配速，m/s */
  thresholdPace: number | null;
  weeks: WeekSummary[];
  distribution: IntensityDistribution;
  efforts: ReturnType<typeof effortDistribution>;
  fitness: FitnessSnapshot | null;
}

/** 同步時存下的 Intervals.icu 資料（Db 的 snapshot） */
export const SNAPSHOT_RUN_SETTINGS = "run_settings";
export const SNAPSHOT_PACE_CURVE = "pace_curve";

export async function computeTrainingValues(db: Db, today: string, weeks = 4): Promise<TrainingValues> {
  const [profile, settings, curve, races, workouts, wellness] = await Promise.all([
    db.getProfile(),
    db.getSnapshot<RunSettings>(SNAPSHOT_RUN_SETTINGS),
    db.getSnapshot<PaceCurveSummary>(SNAPSHOT_PACE_CURVE),
    db.getAllRaces(),
    db.getRecentWorkouts(Math.max(weeks * 7, DISTRIBUTION_DAYS)),
    db.getWellnessRaw(7),
  ]);
  const hr = heartRateInfo(profile, settings?.value ?? null, today);
  const vdot = estimateVdot(races, curve?.value ?? null, today);
  const recent = workouts.filter((w) => daysBetween(w.date, today) < DISTRIBUTION_DAYS);
  const distribution = intensityDistribution(recent, hr?.lthr ?? null);
  const efforts = effortDistribution(recent);
  return {
    today,
    coverage: {
      runs: recent.length,
      withHr: recent.filter((w) => w.avg_hr != null).length,
      withZones: distribution.withZones,
      rated: efforts.rated,
    },
    hr,
    vdot,
    paces: vdot ? danielsPaces(vdot.value) : null,
    curve: curve?.value ?? null,
    thresholdPace: settings?.value.threshold_pace ?? null,
    weeks: weeklySummaries(workouts, today, weeks),
    distribution,
    efforts,
    fitness: latestFitness(wellness, workouts),
  };
}

/** 秒 → 「22:30」或「1:43:20」 */
export function durationText(secs: number): string {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${rest}` : `${m}:${rest}`;
}

const DISTANCE_LABELS: [number, string][] = [
  [5000, "5 km"],
  [10_000, "10 km"],
  [21_097.5, "半馬"],
  [42_195, "全馬"],
];

/** 5000 → 「5 km」、21097.5 → 「半馬」 */
export function distanceText(m: number): string {
  const label = DISTANCE_LABELS.find(([d]) => Math.abs(d - m) / d < 0.01)?.[1];
  if (label) return label;
  return Math.abs(m - 1609.34) < 5 ? "1 英里" : `${Math.round(m / 100) / 10} km`;
}

const pct = (part: number, total: number) => Math.round((part / total) * 100);
const round1 = (n: number) => Math.round(n * 10) / 10;

function vdotSourceText(v: VdotEstimate): string {
  const what = `${distanceText(v.distanceM)} ${durationText(v.secs)}`;
  switch (v.kind) {
    case "race":
      return `${v.date} 的比賽「${v.name}」${what}`;
    case "race_effort":
      return `最近 ${VDOT_LOOKBACK_DAYS} 天的最佳 ${what}（${v.date ?? "日期不明"}，Intervals.icu 標為比賽）`;
    case "best_effort":
      return `最近 ${VDOT_LOOKBACK_DAYS} 天的最佳 ${what}（${v.date ?? "日期不明"}），來自訓練、不是比賽，可能低估`;
  }
}

export function formatTrainingValues(v: TrainingValues): string {
  const lines = [`訓練數值（${v.today}；由程式依資料計算，課表與建議請用這些數字）`];

  const c = v.coverage;
  lines.push("", `【資料】最近 ${DISTRIBUTION_DAYS} 天 ${c.runs} 次跑步`);
  if (c.runs) {
    lines.push(`有心率 ${c.withHr} 次｜有心率區間時間 ${c.withZones} 次｜有回報體感 ${c.rated} 次`);
    if (c.withHr < c.runs) lines.push("缺的不補也不估：沒有心率的跑步不算進心率的強度分配，負荷改看 sRPE（體感 × 分鐘）。");
  }

  lines.push("", "【心率】");
  if (v.hr) {
    lines.push(`來源：${HR_SOURCE_LABELS[v.hr.source]}`);
    const parts = [v.hr.lthr ? `閾值心率 ${v.hr.lthr} bpm` : null, v.hr.maxHr ? `最大心率 ${v.hr.maxHr} bpm` : null];
    lines.push(`・${parts.filter(Boolean).join("、")}`);
    lines.push(`・區間：${zonesText(v.hr)}`);
    lines.push(`・輕鬆跑的心率上限：${v.hr.easyMax} bpm（${v.hr.easyMaxNote}）`);
    if (v.coverage.runs && !v.coverage.withHr) lines.push("最近的跑步都沒有心率，這些區間暫時用不到，強度以配速與體感為主。");
  } else {
    lines.push("沒有心率的依據（沒有 Intervals.icu 的閾值心率，選手資料也沒有最大心率或出生年）：強度以配速與體感為主。");
  }

  lines.push("", "【配速】");
  if (v.vdot && v.paces) {
    const p = v.paces;
    lines.push(`Daniels 的 VDOT ${round1(v.vdot.value)}，依據：${vdotSourceText(v.vdot)}`);
    lines.push(`・E 輕鬆跑、長跑：${formatPace(p.easy[0]).replace("/km", "")}–${formatPace(p.easy[1])}（慢一點沒關係）`);
    lines.push(`・M 馬拉松配速：${formatPace(p.marathon)}`);
    lines.push(`・T 閾值配速：${formatPace(p.threshold)}`);
    lines.push(`・I 間歇配速：${formatPace(p.interval)}`);
    lines.push(`・R 反覆跑配速：${formatPace(p.repetition)}`);
    const predictions = DISTANCE_LABELS.map(([d, label]) => `${label} ${durationText(predictSecs(v.vdot!.value, d))}`);
    lines.push(`・以 VDOT 推算的完賽時間：${predictions.join("｜")}（要有對應距離的訓練才達得到）`);
  } else {
    lines.push(
      `最近 ${VDOT_LOOKBACK_DAYS} 天沒有可以推算的比賽成績或最佳表現（需要 1.5 km 以上、3.5 分鐘以上的全力跑）。` +
        "配速以體感與心率為主；需要配速時，可以請選手回報最近的比賽成績，或做一次 5 km 計時跑。",
    );
  }
  if (v.curve?.critical_speed) {
    const cs = v.curve.critical_speed;
    let line = `・臨界速度（Intervals.icu 以最近 ${v.curve.days} 天的最佳表現擬合，只供對照）：${formatPace(1000 / cs)}`;
    if (v.vdot) {
      // 交叉比對：以 VDOT 推算用臨界速度能跑多久。怎麼解讀（多長算一致）要查證後寫進教練方法（規格 12.8）
      const minutes = findDurationAtSpeed(v.vdot.value, cs) / 60;
      line += `；以 VDOT 推算，這個速度約可維持 ${Math.round(minutes)} 分鐘`;
    }
    lines.push(line);
  }
  lines.push(
    v.thresholdPace
      ? `・Intervals.icu 設定的閾值配速：${formatPace(1000 / v.thresholdPace)}`
      : "・Intervals.icu 沒有設定閾值配速（所以沒有配速區間；可以請選手在 Intervals.icu 的跑步設定填上 T 配速）",
  );

  lines.push("", `【最近 ${v.weeks.length} 週】（週一起算，最後一週是這週）`);
  for (const w of v.weeks) {
    const parts = [`${w.runs} 次`, `${round1(w.km)} km`, `${Math.round(w.minutes)} 分鐘`];
    if (w.load !== null) parts.push(`負荷 ${Math.round(w.load)}`);
    if (w.srpe !== null) parts.push(`sRPE ${w.srpe}`);
    if (w.runs) parts.push(`最長 ${round1(w.longestKm)} km`);
    lines.push(`・${w.label}（${w.start.slice(5)} 起）：${parts.join("｜")}`);
  }
  lines.push("（負荷是 Intervals.icu 的訓練負荷；sRPE 是體感 × 分鐘，只算有回報體感的）");

  lines.push("", `【強度分配】最近 ${DISTRIBUTION_DAYS} 天`);
  const d = v.distribution;
  const total = d.lowSecs + d.moderateSecs + d.highSecs;
  if (total > 0) {
    lines.push(
      `依心率區間的時間：低 ${pct(d.lowSecs, total)}%｜中 ${pct(d.moderateSecs, total)}%｜高 ${pct(d.highSecs, total)}%` +
        `（${d.runs} 次中 ${d.withZones} 次有區間資料；80/20 的目標是低強度約 80%）`,
    );
    lines.push("低：閾值心率的 90% 以下；中：90% 到閾值心率；高：超過閾值心率。天氣熱時心率偏高，低強度的比例會被低估。");
  } else if (v.efforts.rated >= 3) {
    const e = v.efforts;
    lines.push(
      `沒有心率區間的資料，依體感粗分（以次數計）：輕鬆 ${pct(e.low, e.rated)}%｜中等 ${pct(e.moderate, e.rated)}%｜` +
        `高強度 ${pct(e.high, e.rated)}%（${e.rated} 次有體感；1–4 輕鬆、5–6 中等、7 以上高強度）`,
    );
  } else {
    lines.push("沒有心率區間的資料，回報體感的次數也不夠，無法估計強度分配。");
  }

  if (v.fitness) {
    const f = v.fitness;
    const form = f.ctl - f.atl;
    const parts = [`體能（CTL）${round1(f.ctl)}`, `疲勞（ATL）${round1(f.atl)}`, `狀態（CTL−ATL）${round1(form)}`];
    if (f.rampRate !== null) parts.push(`體能每週變化 ${f.rampRate >= 0 ? "+" : ""}${round1(f.rampRate)}`);
    lines.push("", `【體能與疲勞】Intervals.icu（${f.date}${f.source === "activity" ? "，最近一筆跑步當時" : ""}）`);
    lines.push(parts.join("｜"));
  }
  return lines.join("\n");
}

/** 以 VDOT 推算，用 speed（m/s）能持續多少秒 */
function findDurationAtSpeed(vdot: number, speed: number): number {
  // 跑得越久能用的攝氧量比例越低：找出比例剛好等於這個速度所需攝氧量的時間
  const need = vo2AtVelocity(speed * 60) / vdot;
  let lo = 1;
  let hi = 600;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (sustainableFraction(mid) > need) lo = mid;
    else hi = mid;
  }
  return ((lo + hi) / 2) * 60;
}
