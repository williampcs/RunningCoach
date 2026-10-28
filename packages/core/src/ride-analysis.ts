/**
 * 騎車的分析（規格 12.31 的騎車分析，多運動）：每趟騎完的 AI 分析、騎車與跑步每週的量.
 *
 * 只用 Intervals.icu 的活動摘要（時間、距離、心率、心率區間的時間、負荷、爬升，有就有的踏頻與功率），
 * 不抓每秒的串流；心率漂移、FTP 與功率曲線不在這裡.
 */
import { addDays, daysBetween, weekdayIndex } from "./dates";
import type { Db } from "./db";
import type { Llm } from "./llm";
import { DIFFICULTY_LABELS, OUTCOME_LABELS } from "./plan-match";
import { planResultsSince } from "./planning";
import { sportOfType } from "./sports";
import { intensityDistribution } from "./training-values";
import type { OtherActivity, Workout } from "./types";
import { runWeatherNote, type WeatherSource } from "./weather";

function rawOf(json: string | null | undefined): Record<string, unknown> {
  try {
    const value: unknown = json ? JSON.parse(json) : null;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);

/** 騎車卡與分析用的數字；沒有的是 null（沒有功率計、沒有踏頻感測器時不出現） */
export interface RideMetrics {
  maxHr: number | null;
  elevationM: number | null;
  /** 平均踏頻（rpm） */
  cadence: number | null;
  /** 平均功率與標準化功率（瓦） */
  watts: number | null;
  normalizedWatts: number | null;
  /** 依那趟自己的心率區間（騎車的閾值心率）的時間（秒）；沒有區間資料時為 null */
  intensity: { low: number; moderate: number; high: number } | null;
}

/** Intervals.icu 的欄位：icu_ 開頭的是 Intervals.icu 算的，沒有時用裝置的 */
export function rideMetrics(a: Pick<OtherActivity, "raw_json">): RideMetrics {
  const raw = rawOf(a.raw_json);
  const round = (v: number | null) => (v === null ? null : Math.round(v));
  const d = intensityDistribution([a], null);
  return {
    maxHr: round(positive(raw.max_heartrate)),
    elevationM: round(positive(raw.total_elevation_gain)),
    cadence: round(positive(raw.average_cadence)),
    watts: round(positive(raw.icu_average_watts) ?? positive(raw.average_watts)),
    normalizedWatts: round(positive(raw.icu_weighted_avg_watts) ?? positive(raw.weighted_average_watts)),
    intensity: d.withZones ? { low: d.lowSecs, moderate: d.moderateSecs, high: d.highSecs } : null,
  };
}

const pct = (part: number, total: number) => Math.round((part / total) * 100);

/** 這趟在課表上的位置與程式的判斷；不在課表上時說是課表外，這週沒有課表時是 null */
async function ridePlanNote(db: Db, today: string, a: OtherActivity): Promise<string | null> {
  const planned = await planResultsSince(db, today, addDays(a.date, -6));
  const p = planned.byOther.get(a.intervals_id);
  if (p) {
    const r = p.result;
    return (
      `${p.kindLabel}「${p.title}」；程式的判斷：${OUTCOME_LABELS[r.outcome]}${r.reasons.length ? `（${r.reasons.join("、")}）` : ""}` +
      (r.difficulty ? `；${DIFFICULTY_LABELS[r.difficulty]}` : "")
    );
  }
  return planned.othersInPlannedWeek.has(a.intervals_id) ? "這趟不在課表上（課表外的騎車）" : null;
}

/** 最近 7 天（含這趟那天）的總負荷，和前三週的每週平均比 */
async function recentLoadNote(db: Db, date: string): Promise<string | null> {
  const days = daysBetween(addDays(date, -27), db.today()) + 1;
  const [runs, others] = await Promise.all([db.getRecentWorkouts(days), db.getOtherActivities(days)]);
  const items = [...runs.map((w) => ({ date: w.date, load: w.training_load })), ...others.map((o) => ({ date: o.date, load: o.training_load }))].filter(
    (x) => x.load != null && x.date <= date,
  );
  if (!items.length) return null;
  const ago = (d: string) => daysBetween(d, date);
  const recent = items.filter((x) => ago(x.date) < 7).reduce((s, x) => s + x.load!, 0);
  const prior = items.filter((x) => ago(x.date) >= 7 && ago(x.date) < 28).reduce((s, x) => s + x.load!, 0) / 3;
  return `最近 7 天跑步＋其他運動的負荷 ${Math.round(recent)}` + (prior > 0 ? `（前三週平均每週 ${Math.round(prior)}）` : "");
}

export interface RideSummaryInput {
  date: string;
  type: string;
  durationMin: number | null;
  distanceKm: number | null;
  avgHr: number | null;
  load: number | null;
  metrics: RideMetrics;
  perceivedEffort: number | null;
  notes: string | null;
  plan: string | null;
  recentLoad: string | null;
  weather: string | null;
}

/** 分析的提示（格式照跑後分析的規則：第一行一句結論，之後 2–4 點） */
export function rideSummaryPrompt(r: RideSummaryInput): string {
  const m = r.metrics;
  const total = m.intensity ? m.intensity.low + m.intensity.moderate + m.intensity.high : 0;
  const lines = [
    `日期：${r.date}`,
    `時長：${r.durationMin != null ? `${Math.round(r.durationMin)} 分鐘` : "未知"}`,
    `距離：${r.distanceKm ? `${r.distanceKm} km` : "未知"}`,
    r.avgHr != null || m.maxHr != null
      ? `心率：平均 ${r.avgHr ?? "未記錄"}、最高 ${m.maxHr ?? "未記錄"}`
      : "心率：沒有資料（沒有配戴心率裝置）",
    total > 0 ? `強度分配（依騎車的心率區間）：低 ${pct(m.intensity!.low, total)}%、中 ${pct(m.intensity!.moderate, total)}%、高 ${pct(m.intensity!.high, total)}%` : null,
    r.load != null ? `負荷：${r.load}` : null,
    m.elevationM ? `爬升：${m.elevationM} m` : null,
    m.cadence ? `平均踏頻：${m.cadence} rpm` : null,
    m.watts ? `平均功率：${m.watts} W${m.normalizedWatts ? `、標準化功率：${m.normalizedWatts} W` : ""}` : null,
    r.perceivedEffort != null ? `體感強度：${r.perceivedEffort}/10\n主觀感受：${r.notes || "未記錄"}` : "體感資料：未記錄",
    r.plan ? `課表：${r.plan}` : null,
    r.recentLoad ? `最近的負荷：${r.recentLoad}` : null,
    r.weather ? `當時天氣（模型估計，約略）：${r.weather}` : null,
  ].filter(Boolean);
  return (
    `請為以下騎車訓練生成一段簡潔分析摘要（150字以內，繁體中文）：\n\n${lines.join("\n")}\n\n` +
    `格式：第一行是一句話的結論（例如「穩定的耐力騎，強度控制得很好」），不加標題、粗體，也不重複列出數據；之後用 2–4 個條列說明：強度分配、和課表的對照、恢復建議。` +
    (r.perceivedEffort != null ? "客觀數據與體感對比分析。" : "僅客觀數據，給出客觀評估。") +
    (r.avgHr == null ? "沒有心率資料：依時間、距離、負荷與體感評估，不要推測心率。" : "") +
    (m.watts ? "有功率資料：一併說明功率（平均與標準化功率的差距表示出力的起伏）。" : "") +
    (r.plan ? "對照課表說明這趟和計畫的差異；騎了不一樣的課或沒做完時，用「這次偏難／不一樣，下次怎麼調整」的說法，不要寫失敗。" : "") +
    "騎車的心率通常比跑步低，不要用跑步的心率標準評估。" +
    (r.weather ? "天氣只是約略的估計：濕熱、大風或下雨會讓心率偏高，解讀時考慮進去；天氣普通時不必提。" : "")
  );
}

/** 產生並存下這趟的分析；回傳分析的文字 */
export async function analyzeRide(
  deps: { db: Db; llm: Llm; weather?: WeatherSource | null; today: string },
  intervalsId: string,
): Promise<string> {
  const { db, llm, today } = deps;
  const a = await db.getOtherActivity(intervalsId);
  if (!a) throw new Error("找不到這筆活動，可能已在 Intervals.icu 刪除。");
  const input: RideSummaryInput = {
    date: a.date,
    type: a.type,
    durationMin: a.duration_min,
    distanceKm: a.distance_km,
    avgHr: a.avg_hr,
    load: a.training_load,
    metrics: rideMetrics(a),
    perceivedEffort: a.perceived_effort ?? null,
    notes: a.subjective_notes ?? null,
    plan: await ridePlanNote(db, today, a),
    recentLoad: await recentLoadNote(db, a.date),
    weather: await runWeatherNote(deps.weather, { date: a.date, raw_json: a.raw_json, duration_min: a.duration_min }),
  };
  const summary = (await llm.complete("summary", rideSummaryPrompt(input), 2000)).text.trim();
  if (!summary) throw new Error("模型沒有回傳分析");
  await db.setActivitySummary(intervalsId, summary);
  return summary;
}

// ---------------------------------------------------------------------------
// 每週的量
// ---------------------------------------------------------------------------

export interface WeekVolume {
  /** 那週的星期一 */
  weekStart: string;
  run: { count: number; minutes: number; load: number };
  ride: {
    count: number;
    minutes: number;
    km: number;
    load: number;
    /** 依心率區間的分鐘：低、中、高；沒有區間資料的騎車算在 unknown */
    intensity: { low: number; moderate: number; high: number; unknown: number };
  };
}

const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

/** 最近 weeks 週（含這週，舊的在前）每週跑步與騎車的時間、負荷；騎車另外有強度分配 */
export function weeklyVolume(workouts: Pick<Workout, "date" | "duration_min" | "training_load">[], others: OtherActivity[], today: string, weeks: number): WeekVolume[] {
  const first = addDays(mondayOf(today), -7 * (weeks - 1));
  const out: WeekVolume[] = Array.from({ length: weeks }, (_, i) => ({
    weekStart: addDays(first, 7 * i),
    run: { count: 0, minutes: 0, load: 0 },
    ride: { count: 0, minutes: 0, km: 0, load: 0, intensity: { low: 0, moderate: 0, high: 0, unknown: 0 } },
  }));
  const weekOf = (date: string) => (date < first || date > today ? null : out[Math.floor(daysBetween(first, date) / 7)] ?? null);
  for (const w of workouts) {
    const week = weekOf(w.date);
    if (!week) continue;
    week.run.count += 1;
    week.run.minutes += w.duration_min ?? 0;
    week.run.load += w.training_load ?? 0;
  }
  for (const a of others) {
    const week = weekOf(a.date);
    if (!week || sportOfType(a.type) !== "ride") continue;
    const minutes = a.duration_min ?? 0;
    week.ride.count += 1;
    week.ride.minutes += minutes;
    week.ride.km += a.distance_km ?? 0;
    week.ride.load += a.training_load ?? 0;
    const zones = rideMetrics(a).intensity;
    const zoned = zones ? (zones.low + zones.moderate + zones.high) / 60 : 0;
    if (zones && zoned > 0) {
      // 區間的時間是移動時間：依比例分到這趟的總時間
      const scale = minutes > 0 ? minutes / zoned : 1 / 60;
      week.ride.intensity.low += (zones.low / 60) * scale;
      week.ride.intensity.moderate += (zones.moderate / 60) * scale;
      week.ride.intensity.high += (zones.high / 60) * scale;
    } else {
      week.ride.intensity.unknown += minutes;
    }
  }
  const r = (v: number) => Math.round(v * 10) / 10;
  for (const w of out) {
    w.run.minutes = Math.round(w.run.minutes);
    w.run.load = Math.round(w.run.load);
    w.ride.minutes = Math.round(w.ride.minutes);
    w.ride.km = r(w.ride.km);
    w.ride.load = Math.round(w.ride.load);
    for (const k of ["low", "moderate", "high", "unknown"] as const) w.ride.intensity[k] = Math.round(w.ride.intensity[k]);
  }
  return out;
}

export async function weeklyVolumeOf(db: Db, today: string, weeks: number): Promise<WeekVolume[]> {
  const days = daysBetween(addDays(mondayOf(today), -7 * (weeks - 1)), today) + 1;
  const [workouts, others] = await Promise.all([db.getRecentWorkouts(days), db.getOtherActivities(days)]);
  return weeklyVolume(workouts, others, today, weeks);
}

const hoursText = (m: number) => (m >= 60 ? `${Math.round((m / 60) * 10) / 10} 小時` : `${m} 分鐘`);

/**
 * 教練看的騎車趨勢（get_training_values）：最近幾週每週騎車的次數、時間、負荷、強度分配，跑步＋騎車的總時間與負荷，
 * 加上一句話的趨勢（最近 4 週和前 4 週比）
 */
export function weeklyVolumeText(weeks: WeekVolume[], today: string): string {
  if (!weeks.some((w) => w.ride.count)) return "【騎車】最近沒有騎車。";
  const lines = ["【騎車】每週的量（週一起算，最後一週是這週）："];
  for (const w of weeks.slice(-4)) {
    const z = w.ride.intensity;
    const zoned = z.low + z.moderate + z.high;
    lines.push(
      `・${w.weekStart.slice(5)} 起：騎車 ${w.ride.count} 次｜${hoursText(w.ride.minutes)}｜${w.ride.km} km｜負荷 ${w.ride.load}` +
        (zoned > 0 ? `｜低 ${pct(z.low, zoned)}% 中 ${pct(z.moderate, zoned)}% 高 ${pct(z.high, zoned)}%` : "") +
        `；跑步＋騎車 ${hoursText(w.run.minutes + w.ride.minutes)}、負荷 ${w.run.load + w.ride.load}`,
    );
  }
  // 趨勢只比完整的週：不含這週
  const full = weeks.filter((w) => addDays(w.weekStart, 6) < today);
  const avg = (list: WeekVolume[]) => list.reduce((s, w) => s + w.ride.minutes, 0) / Math.max(1, list.length);
  const recent = full.slice(-4);
  const before = full.slice(-8, -4);
  if (recent.length === 4 && before.length === 4 && avg(before) > 0) {
    const change = Math.round((avg(recent) / avg(before) - 1) * 100);
    const word = Math.abs(change) < 10 ? "差不多" : change > 0 ? `多 ${change}%` : `少 ${-change}%`;
    lines.push(`趨勢：最近 4 週平均每週騎 ${hoursText(Math.round(avg(recent)))}，和前 4 週比${word}。`);
  } else if (recent.length) {
    lines.push(`趨勢：最近 ${recent.length} 週平均每週騎 ${hoursText(Math.round(avg(recent)))}（資料還不夠比較前後）。`);
  }
  return lines.join("\n");
}
