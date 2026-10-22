/**
 * 紀錄頁與跑後回報的「一趟跑步」卡片（規格 12.9）：數字、強度分配、體感與預期、和課表比的結果、
 * 分析摘要的第一句. 只整理既有的資料，不呼叫模型.
 */
import { addDays, weekdayIndex } from "./dates";
import type { Db } from "./db";
import { EXPECTED_RPE } from "./plan";
import { DIFFICULTY_LABELS, OUTCOME_LABELS, type Difficulty, type Outcome } from "./plan-match";
import { planResultsSince } from "./planning";
import { computeTrainingValues, intensityDistribution } from "./training-values";
import type { Workout } from "./types";

export interface RunCard {
  workout: Workout;
  /** 依心率區間的時間（秒）：低強度為閾值心率 90% 以下；沒有區間資料時為 null */
  intensity: { low: number; moderate: number; high: number } | null;
  /** 對應的課；沒有結構化課表的週為 null */
  plan: {
    kindLabel: string;
    title: string;
    outcome: Outcome;
    outcomeLabel: string;
    reasons: string[];
    difficulty: Difficulty | null;
    difficultyLabel: string | null;
  } | null;
  /** 有課表的週、但沒有配到課 */
  outsidePlan: boolean;
  /** 這種課預期的體感範圍（對應到課時才有） */
  expectedRpe: [number, number] | null;
  /** 分析摘要的第一段（結論），其餘收起 */
  headline: string | null;
  details: string | null;
}

/**
 * 舊的摘要第一行是數據（「10 公里｜配速 5:30/km｜心率 152」），卡片上已經有數字：
 * 有分隔符號、又有兩種以上的數據時當成數據行
 */
function isDataLine(line: string): boolean {
  const t = line.replace(/[*_`#>]/g, "");
  if (/數據摘要|數據：/.test(t)) return true;
  const separators = (t.match(/[｜|・]/g) ?? []).length;
  const kinds = [/\d+(?:\.\d+)?\s*(?:km|公里)/i, /\d+:\d{2}/, /心率|bpm/i, /\d+\s*分鐘/].filter((r) => r.test(t)).length;
  return separators >= 2 && kinds >= 2;
}

/** 「AI評估：」「**教練評估**：」這類標籤 */
const LABEL = /^\s*(?:[*_#>]|\p{Extended_Pictographic}|\s)*(?:AI\s*評估|教練評估|評估|分析)\s*[*_]*\s*[:：]\s*[*_]*\s*/u;
const LABEL_ONLY = /^(?:[*_#>\s:：]|\p{Extended_Pictographic})*(?:AI\s*評估|教練評估|評估|分析)(?:[*_\s:：])*$/u;
const isListItem = (line: string) => /^\s*(?:[-*+]|\d+[.)])\s/.test(line);

/** 摘要的第一段當結論，其餘是細節；舊格式的數據行與標籤略過，第一段是條列時沒有結論 */
export function splitSummary(summary: string | null | undefined): { headline: string | null; details: string | null } {
  const lines = (summary ?? "").trim().split("\n");
  let i = 0;
  const skipBlank = () => {
    while (i < lines.length && lines[i]!.trim() === "") i++;
  };
  skipBlank();
  if (i < lines.length && isDataLine(lines[i]!)) {
    i++;
    skipBlank();
  }
  // 只有標籤的一行（「**AI評估**」）
  if (i < lines.length && LABEL_ONLY.test(lines[i]!)) {
    i++;
    skipBlank();
  }
  if (i >= lines.length) return { headline: null, details: null };
  const rest = (from: number) => lines.slice(from).join("\n").trim() || null;
  if (isListItem(lines[i]!)) return { headline: null, details: rest(i) };
  const headline = lines[i]!.replace(LABEL, "").trim();
  return { headline: headline || null, details: rest(i + 1) };
}

export function runCardOf(
  workout: Workout,
  lthr: number | null,
  planned: Awaited<ReturnType<typeof planResultsSince>>,
): RunCard {
  const d = intensityDistribution([workout], lthr);
  const p = planned.byWorkout.get(workout.id);
  return {
    workout,
    intensity: d.withZones ? { low: d.lowSecs, moderate: d.moderateSecs, high: d.highSecs } : null,
    plan: p
      ? {
          kindLabel: p.kindLabel,
          title: p.title,
          outcome: p.result.outcome,
          outcomeLabel: OUTCOME_LABELS[p.result.outcome],
          reasons: p.result.reasons,
          difficulty: p.result.difficulty,
          difficultyLabel: p.result.difficulty ? DIFFICULTY_LABELS[p.result.difficulty] : null,
        }
      : null,
    outsidePlan: planned.inPlannedWeek.has(workout.id),
    expectedRpe: p && p.result.outcome !== "fallback" ? EXPECTED_RPE[p.kind] : p ? EXPECTED_RPE.easy : null,
    ...splitSummary(workout.summary),
  };
}

/** 最近 N 天的跑步卡片，新的在前 */
export async function runCards(db: Db, today: string, days: number): Promise<RunCard[]> {
  const [workouts, values, planned] = await Promise.all([
    db.getRecentWorkouts(days),
    computeTrainingValues(db, today),
    planResultsSince(db, today, addDays(today, -days)),
  ]);
  const lthr = values.hr?.lthr ?? null;
  return workouts.map((w) => runCardOf(w, lthr, planned));
}

/** 累積的里程碑：只說到過哪裡，不說還差多少以外的事（規格 12.5：休息不會失去任何東西） */
const PLACES: [string, number][] = [
  ["台北到桃園", 40],
  ["台北到新竹", 70],
  ["台北到台中", 160],
  ["台北到台南", 310],
  ["台北到高雄", 350],
  ["環島一圈", 1000],
  ["台北到東京", 2100],
  ["地球一圈", 40075],
];
const MARATHON_KM = 42.195;
const TAIPEI_101_M = 508;

/** 紀錄頁頁首的累積（只增不減）；這週、今年沒有跑步時是 null，不顯示 0 */
export interface Accumulation {
  runs: number;
  km: number;
  minutes: number;
  elevationM: number;
  /** 有跑步的週數 */
  weeks: number;
  /** 最早一筆紀錄的日期 */
  since: string | null;
  thisWeek: { runs: number; km: number; minutes: number } | null;
  /** 今年的跑量；和總量一樣時（紀錄都在今年）是 null */
  thisYearKm: number | null;
  longest: { km: number; date: string } | null;
  marathons: number;
  taipei101: number;
  /** 已經超過的最遠一站與下一站 */
  passed: { name: string; km: number } | null;
  next: { name: string; km: number } | null;
  /** 每一趟一格，由舊到新：依距離分級（0：5 km 以下、1：5–10、2：10–21、3：21 以上） */
  blocks: { id: number; date: string; size: 0 | 1 | 2 | 3 }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function accumulate(workouts: Workout[], today: string): Accumulation {
  const runs = [...workouts].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const km = runs.reduce((sum, w) => sum + (w.distance_km ?? 0), 0);
  const weekStart = addDays(today, -weekdayIndex(today));
  const week = runs.filter((w) => w.date >= weekStart && w.date <= today);
  const year = runs.filter((w) => w.date.slice(0, 4) === today.slice(0, 4));
  const yearKm = year.reduce((sum, w) => sum + (w.distance_km ?? 0), 0);
  const longest = runs.reduce<Workout | null>((best, w) => ((w.distance_km ?? 0) > (best?.distance_km ?? 0) ? w : best), null);
  const passedIndex = PLACES.filter(([, d]) => km >= d).length - 1;
  const place = (i: number) => (PLACES[i] ? { name: PLACES[i]![0], km: PLACES[i]![1] } : null);
  return {
    runs: runs.length,
    km: round1(km),
    minutes: Math.round(runs.reduce((sum, w) => sum + (w.duration_min ?? 0), 0)),
    elevationM: Math.round(runs.reduce((sum, w) => sum + (w.elevation_m ?? 0), 0)),
    weeks: new Set(runs.map((w) => addDays(w.date, -weekdayIndex(w.date)))).size,
    since: runs[0]?.date ?? null,
    thisWeek: week.length
      ? {
          runs: week.length,
          km: round1(week.reduce((sum, w) => sum + (w.distance_km ?? 0), 0)),
          minutes: Math.round(week.reduce((sum, w) => sum + (w.duration_min ?? 0), 0)),
        }
      : null,
    thisYearKm: year.length && year.length < runs.length ? round1(yearKm) : null,
    longest: longest?.distance_km ? { km: longest.distance_km, date: longest.date } : null,
    marathons: round1(km / MARATHON_KM),
    taipei101: round1(runs.reduce((sum, w) => sum + (w.elevation_m ?? 0), 0) / TAIPEI_101_M),
    passed: place(passedIndex),
    next: place(passedIndex + 1),
    blocks: runs.map((w) => {
      const d = w.distance_km ?? 0;
      return { id: w.id, date: w.date, size: d >= 21 ? 3 : d >= 10 ? 2 : d >= 5 ? 1 : 0 };
    }),
  };
}

/** 資料庫裡所有的跑步（不含重複與已刪除的）的累積 */
export async function accumulation(db: Db, today: string): Promise<Accumulation> {
  return accumulate(await db.getRecentWorkouts(365 * 100), today);
}
