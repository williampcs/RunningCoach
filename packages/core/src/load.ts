/**
 * 負荷與體能、疲勞：我們自己從原始數字算（規格 12.37「不分來源的核心」）.
 *
 * 尺度和 Intervals.icu、TrainingPeaks 的 TSS 一樣：在閾值強度做 1 小時 = 100. 同一個尺度才能把
 * 有心率、只有配速、只有體感的紀錄，以及 Intervals.icu 算好的負荷加在一起算體能與疲勞.
 *
 * 每一趟的負荷（`loadOf`），依序：
 * 1. Intervals.icu 算好的（`icu_training_load`）：有就用它，正式版的使用者看到的數字不變.
 * 2. 心率（hrSS）：Banister 的 TRIMP，再以「閾值心率做 60 分鐘」的 TRIMP 為 100 換算.
 *    HRr =（平均心率 − 靜止心率）／（最大心率 − 靜止心率），夾在 0–1；TRIMP = 分鐘 × HRr × 0.64 × e^(1.92 × HRr).
 *    最大心率與閾值心率只用量到的（Intervals.icu 的設定、選手填的實測最大心率），不用 220 − 年齡；
 *    只有其中一個時，閾值心率當成最大心率的 89%. 靜止心率用最近恢復資料的中位數，沒有時 60.
 *    只有平均心率（沒有每秒的心率）時，間歇課會被低估.
 * 3. 配速（只有跑步，rTSS）：IF = 閾值配速 ÷ 這趟的配速（Intervals.icu 設定的閾值配速，沒有時用 Daniels 的 T 配速），
 *    負荷 = 小時 × IF² × 100. 沒有坡度修正；IF 最多算到 1.3（GPS 飄掉或打錯的）.
 * 4. 體感（1–10）：依下面的對照表換成 IF，負荷 = 小時 × IF² × 100. 閾值大約在 CR-10 量表的 7–8（「很吃力」），
 *    所以體感 7–8 的 IF 接近 0.9–1.0（協調 session 的建議，2026-11-02）. 和 Foster 的 sRPE（體感 × 分鐘）同方向，
 *    換成 TSS 的尺度才能和其他的混在一起. 之後用比對腳本（tools/compare-load.ts）以真實資料調整.
 *
 * 體能（CTL）與疲勞（ATL）：每天的總負荷（所有運動，不含重複與移除的）的指數平均，
 * CTL_t = CTL_{t−1} + (負荷_t − CTL_{t−1}) × (1 − e^(−1/42))，ATL 用 7 天；從 FITNESS_DAYS 天前以 0 起算，
 * 所以紀錄不到 6 週時體能會偏低. 和 plan.ts 的檢查器用的 1 − e^(−7/42) 是同一個模型.
 */

/** 這趟的負荷是怎麼來的 */
export type LoadSource = "intervals" | "hr" | "pace" | "rpe";

export const LOAD_SOURCE_LABELS: Record<LoadSource, string> = {
  intervals: "Intervals.icu",
  hr: "依心率估",
  pace: "依配速估",
  rpe: "依體感估",
};

/** 體感 1–10 → 強度係數（IF），索引就是體感 */
export const RPE_INTENSITY: readonly number[] = [0, 0.5, 0.6, 0.65, 0.7, 0.75, 0.82, 0.9, 0.97, 1.03, 1.1];

/** 沒有恢復資料時的靜止心率 */
export const DEFAULT_REST_HR = 60;
/** 只知道最大心率或閾值心率其中一個時，閾值心率 = 最大心率 × 這個比例 */
export const LTHR_OF_MAX = 0.89;
/** 算體能疲勞往回看幾天（CTL 的時間常數 42 天的 4 倍多，起點的 0 幾乎不影響） */
export const FITNESS_DAYS = 180;
const CTL_DAYS = 42;
const ATL_DAYS = 7;
const MAX_PACE_IF = 1.3;

/** 一項運動的心率依據（只有量到的） */
export interface HrBasis {
  maxHr: number | null;
  lthr: number | null;
}

export interface LoadContext {
  /** 各運動的心率依據：run、ride、swim……；沒有那項運動的時候用跑步的 */
  hr: Record<string, HrBasis>;
  restHr: number;
  /** 跑步的閾值配速（秒／公里）；沒有時為 null */
  thresholdPaceSec: number | null;
}

/** 算負荷用得到的欄位（Workout、OtherActivity、ActivityRecord 都有） */
export interface LoadInput {
  duration_min: number | null;
  distance_km?: number | null;
  avg_hr: number | null;
  perceived_effort?: number | null;
  /** 來源算好的負荷 */
  training_load: number | null;
}

export interface Load {
  value: number;
  source: LoadSource;
}

const round = (v: number) => Math.round(v);

function trimp(minutes: number, hrr: number): number {
  return minutes * hrr * 0.64 * Math.exp(1.92 * hrr);
}

/** 心率的負荷（hrSS）；依據不夠時為 null */
export function hrLoad(minutes: number, avgHr: number, basis: HrBasis, restHr: number): number | null {
  let { maxHr, lthr } = basis;
  if (!maxHr && lthr) maxHr = Math.round(lthr / LTHR_OF_MAX);
  if (maxHr && !lthr) lthr = Math.round(maxHr * LTHR_OF_MAX);
  if (!maxHr || !lthr || maxHr - restHr < 20 || lthr <= restHr || lthr > maxHr) return null;
  const hrrOf = (hr: number) => Math.min(1, Math.max(0, (hr - restHr) / (maxHr! - restHr)));
  return round((100 * trimp(minutes, hrrOf(avgHr))) / trimp(60, hrrOf(lthr)));
}

/** 跑步配速的負荷（rTSS）；不合理的配速（快過 2:00/km、慢過 20:00/km）為 null */
export function paceLoad(minutes: number, distanceKm: number, thresholdPaceSec: number): number | null {
  if (distanceKm <= 0 || minutes <= 0 || thresholdPaceSec <= 0) return null;
  const paceSec = (minutes * 60) / distanceKm;
  if (paceSec < 120 || paceSec > 1200) return null;
  const intensity = Math.min(MAX_PACE_IF, thresholdPaceSec / paceSec);
  return round((minutes / 60) * intensity * intensity * 100);
}

/** 體感的負荷；體感不在 1–10 時為 null */
export function rpeLoad(minutes: number, rpe: number): number | null {
  const intensity = RPE_INTENSITY[Math.round(rpe)];
  if (!intensity || rpe < 1 || rpe > 10) return null;
  return round((minutes / 60) * intensity * intensity * 100);
}

/** 我們自己估的負荷（不看來源算好的）：依序心率、配速（只有跑步）、體感 */
export function estimateLoad(a: LoadInput, sport: string, ctx: LoadContext): Load | null {
  const minutes = a.duration_min ?? 0;
  if (minutes <= 0) return null;
  if (a.avg_hr != null && a.avg_hr > 0) {
    const value = hrLoad(minutes, a.avg_hr, ctx.hr[sport] ?? ctx.hr.run ?? { maxHr: null, lthr: null }, ctx.restHr);
    if (value !== null) return { value, source: "hr" };
  }
  if (sport === "run" && a.distance_km && ctx.thresholdPaceSec) {
    const value = paceLoad(minutes, a.distance_km, ctx.thresholdPaceSec);
    if (value !== null) return { value, source: "pace" };
  }
  if (a.perceived_effort != null) {
    const value = rpeLoad(minutes, a.perceived_effort);
    if (value !== null) return { value, source: "rpe" };
  }
  return null;
}

/** 這趟用的負荷：有 Intervals.icu 算好的就用它，沒有時用我們估的 */
export function loadOf(a: LoadInput, sport: string, ctx: LoadContext): Load | null {
  if (a.training_load != null) return { value: a.training_load, source: "intervals" };
  return estimateLoad(a, sport, ctx);
}

/** 「45（依體感估）」；來源是 Intervals.icu 時只寫數字（和原本一樣） */
export function loadText(load: Load): string {
  return load.source === "intervals" ? String(load.value) : `${load.value}（${LOAD_SOURCE_LABELS[load.source]}）`;
}

export interface FitnessPoint {
  date: string;
  ctl: number;
  atl: number;
}

/** 每天的總負荷 → 從 from 到 to（含）每天的體能與疲勞 */
export function fitnessSeries(daily: Map<string, number>, from: string, to: string): FitnessPoint[] {
  const kCtl = 1 - Math.exp(-1 / CTL_DAYS);
  const kAtl = 1 - Math.exp(-1 / ATL_DAYS);
  const out: FitnessPoint[] = [];
  let ctl = 0;
  let atl = 0;
  for (let d = from; d <= to; d = nextDay(d)) {
    const load = daily.get(d) ?? 0;
    ctl += (load - ctl) * kCtl;
    atl += (load - atl) * kAtl;
    out.push({ date: d, ctl, atl });
  }
  return out;
}

function nextDay(date: string): string {
  const t = new Date(`${date}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10);
}

/** 各來源的筆數，例：{ intervals: 3, rpe: 5 }；none 是沒有負荷的 */
export type LoadCounts = Partial<Record<LoadSource | "none", number>>;

/** 每天的總負荷與各來源的筆數 */
export function dailyLoads(items: (LoadInput & { date: string; sport: string })[], ctx: LoadContext): { daily: Map<string, number>; counts: LoadCounts } {
  const daily = new Map<string, number>();
  const counts: LoadCounts = {};
  for (const a of items) {
    const load = loadOf(a, a.sport, ctx);
    const key = load?.source ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
    if (load) daily.set(a.date, (daily.get(a.date) ?? 0) + load.value);
  }
  return { daily, counts };
}

/** 「依體感估 5 筆、Intervals.icu 2 筆、沒有負荷 1 筆」 */
export function loadCountsText(counts: LoadCounts): string {
  const order: (LoadSource | "none")[] = ["intervals", "hr", "pace", "rpe", "none"];
  return order
    .filter((k) => counts[k])
    .map((k) => `${k === "none" ? "沒有負荷" : LOAD_SOURCE_LABELS[k]} ${counts[k]} 筆`)
    .join("、");
}
