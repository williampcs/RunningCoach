/**
 * 紀錄頁與跑後回報的「一趟跑步」卡片（規格 12.9）：數字、強度分配、體感與預期、和課表比的結果、
 * 分析摘要的第一句. 只整理既有的資料，不呼叫模型.
 */
import { addDays, weekdayIndex } from "./dates";
import type { Db } from "./db";
import { EXPECTED_RPE } from "./plan";
import { DIFFICULTY_LABELS, OUTCOME_LABELS, type Difficulty, type Outcome, type SessionResult } from "./plan-match";
import { planResultsSince, type RunPlanResult } from "./planning";
import { sportOfType } from "./sports";
import { computeTrainingValues, intensityDistribution } from "./training-values";
import type { OtherActivity, Workout } from "./types";

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

function planOf(p: RunPlanResult | undefined): RunCard["plan"] {
  return p
    ? {
        kindLabel: p.kindLabel,
        title: p.title,
        outcome: p.result.outcome,
        outcomeLabel: OUTCOME_LABELS[p.result.outcome],
        reasons: p.result.reasons,
        difficulty: p.result.difficulty,
        difficultyLabel: p.result.difficulty ? DIFFICULTY_LABELS[p.result.difficulty] : null,
      }
    : null;
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
    plan: planOf(p),
    outsidePlan: planned.inPlannedWeek.has(workout.id),
    expectedRpe: p && p.result.outcome !== "fallback" ? EXPECTED_RPE[p.kind] : p ? EXPECTED_RPE.easy : null,
    ...splitSummary(workout.summary),
  };
}

/** 紀錄頁的一趟騎車（多運動的第 3 階段）：和跑步的卡片同一種樣式，數字換成騎車用的 */
export interface RideCard {
  activity: OtherActivity;
  /** 依那趟自己的心率區間（騎車的閾值心率）的時間（秒）；沒有區間資料時為 null */
  intensity: { low: number; moderate: number; high: number } | null;
  /** 平均功率（瓦）；沒有功率計時為 null */
  watts: number | null;
  plan: RunCard["plan"];
  outsidePlan: boolean;
  expectedRpe: [number, number] | null;
}

function rawNumber(json: string | null | undefined, key: string): number | null {
  try {
    const v = json ? (JSON.parse(json) as Record<string, unknown>)[key] : null;
    return typeof v === "number" && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export function rideCardOf(activity: OtherActivity, planned: Awaited<ReturnType<typeof planResultsSince>>): RideCard {
  const d = intensityDistribution([activity], null);
  const p = planned.byOther.get(activity.intervals_id);
  const result: SessionResult | undefined = p?.result;
  const watts = rawNumber(activity.raw_json, "icu_average_watts") ?? rawNumber(activity.raw_json, "average_watts");
  return {
    activity,
    intensity: d.withZones ? { low: d.lowSecs, moderate: d.moderateSecs, high: d.highSecs } : null,
    watts: watts ? Math.round(watts) : null,
    plan: planOf(p),
    outsidePlan: planned.othersInPlannedWeek.has(activity.intervals_id),
    expectedRpe: p && result?.outcome !== "fallback" ? EXPECTED_RPE[p.kind] : p ? EXPECTED_RPE.ride_endurance : null,
  };
}

/** 最近 N 天的騎車卡片，新的在前 */
export async function rideCards(db: Db, today: string, days: number): Promise<RideCard[]> {
  const [others, planned] = await Promise.all([db.getOtherActivities(days), planResultsSince(db, today, addDays(today, -days))]);
  return others.filter((a) => sportOfType(a.type) === "ride").map((a) => rideCardOf(a, planned));
}

/** 紀錄頁的騎車累積（簡單的：總次數、時間、距離、這週、最長的一趟） */
export interface RideAccumulation {
  rides: number;
  km: number;
  minutes: number;
  since: string | null;
  thisWeek: { rides: number; km: number; minutes: number } | null;
  longest: { minutes: number; km: number | null; date: string } | null;
}

export function accumulateRides(others: OtherActivity[], today: string): RideAccumulation {
  const rides = others.filter((a) => sportOfType(a.type) === "ride").sort((a, b) => a.date.localeCompare(b.date));
  const weekStart = addDays(today, -weekdayIndex(today));
  const week = rides.filter((a) => a.date >= weekStart && a.date <= today);
  const sum = (list: OtherActivity[], key: "distance_km" | "duration_min") => list.reduce((t, a) => t + (a[key] ?? 0), 0);
  const longest = rides.reduce<OtherActivity | null>((best, a) => ((a.duration_min ?? 0) > (best?.duration_min ?? 0) ? a : best), null);
  return {
    rides: rides.length,
    km: round1(sum(rides, "distance_km")),
    minutes: Math.round(sum(rides, "duration_min")),
    since: rides[0]?.date ?? null,
    thisWeek: week.length ? { rides: week.length, km: round1(sum(week, "distance_km")), minutes: Math.round(sum(week, "duration_min")) } : null,
    longest: longest?.duration_min ? { minutes: Math.round(longest.duration_min), km: longest.distance_km, date: longest.date } : null,
  };
}

/** 資料庫裡所有的騎車的累積（其他運動只保存同步過的期間） */
export async function rideAccumulation(db: Db, today: string): Promise<RideAccumulation> {
  return accumulateRides(await db.getOtherActivities(365 * 100), today);
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

/** 累積的里程碑（距離都是約略值；國外的是直線距離）：只說到過哪裡與下一站（規格 12.5：休息不會失去任何東西） */
/**
 * 紀錄頁的里程碑（12.5）. 預設是不依賴所在地的一組；選手在「選手資料」選了所在地區時，換成那個地區的
 * （距離都從那個地區的大城市算）. 名稱本身要說得出距離（「台北到東京」而不是「東京」），畫面上再附上公里數
 */
export const REGIONS = { TW: "台灣" } as const;
/** 空字串是通用（不依賴所在地） */
export type Region = "" | keyof typeof REGIONS;

/**
 * 選手資料的 region 可以選的值：不填是通用；auto 依時區判斷（時區對不到任何地區時用通用）；
 * 其他是手動選的地區
 */
export const REGION_CHOICES: Record<string, string> = { auto: "依時區自動判斷", ...REGIONS };

/** 時區對應的地區（依時區自動判斷時用） */
const TIME_ZONE_REGIONS: Record<string, Region> = { "Asia/Taipei": "TW" };

interface Landmarks {
  places: [string, number][];
  /** 爬升的比較對象 */
  climb: { name: string; meters: number; kind: "mountain" | "tower" };
}

const LANDMARKS: Record<Region, Landmarks> = {
  "": {
    places: [
      ["一場全馬", 42.195],
      ["康瑞德超馬（南非）", 90],
      ["斯巴達松（雅典到斯巴達）", 246],
      ["聖雅各朝聖之路（法國之路）", 800],
      ["英國縱走（最南到最北）", 1400],
      ["阿帕拉契山徑（美國）", 3500],
      ["尼羅河全長", 6650],
      ["萬里長城（明長城）", 8850],
      ["地球半圈", 20038],
      ["地球一圈", 40075],
      ["地球到月球", 384400],
    ],
    climb: { name: "聖母峰", meters: 8849, kind: "mountain" },
  },
  TW: {
    places: [
      ["台北到桃園", 40],
      ["台北到新竹", 70],
      ["台北到台中", 160],
      ["台北到台南", 310],
      ["台北到高雄", 350],
      ["環島一圈", 1000],
      ["台北到東京", 2100],
      ["台北到新加坡", 3200],
      ["台北到雪梨", 7300],
      ["台北到倫敦", 9800],
      ["台北到紐約", 12500],
      ["地球半圈", 20000],
      ["地球一圈", 40075],
    ],
    climb: { name: "台北 101", meters: 508, kind: "tower" },
  },
};

/** 選手資料的 region 對應的地區；沒填或不認得的是通用 */
export function regionOf(value: string | undefined, timeZone: string): Region {
  if (value === "auto") return TIME_ZONE_REGIONS[timeZone] ?? "";
  return value && value in REGIONS ? (value as Region) : "";
}

const MARATHON_KM = 42.195;

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
  /** 累積爬升相當於幾座（依所在地區：聖母峰或台北 101） */
  climb: { name: string; meters: number; kind: "mountain" | "tower"; count: number };
  /** 里程碑依哪個地區（選手資料的 region，依時區判斷時是判斷的結果） */
  region: Region;
  /** 已經超過的最遠一站與下一站 */
  passed: { name: string; km: number } | null;
  next: { name: string; km: number } | null;
  /** 每一趟一格，由舊到新：依距離分級（0：5 km 以下、1：5–10、2：10–21、3：21 以上） */
  blocks: { id: number; date: string; size: 0 | 1 | 2 | 3 }[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function accumulate(workouts: Workout[], today: string, region: Region = ""): Accumulation {
  const { places, climb } = LANDMARKS[region];
  const runs = [...workouts].sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
  const km = runs.reduce((sum, w) => sum + (w.distance_km ?? 0), 0);
  const weekStart = addDays(today, -weekdayIndex(today));
  const week = runs.filter((w) => w.date >= weekStart && w.date <= today);
  const year = runs.filter((w) => w.date.slice(0, 4) === today.slice(0, 4));
  const yearKm = year.reduce((sum, w) => sum + (w.distance_km ?? 0), 0);
  const longest = runs.reduce<Workout | null>((best, w) => ((w.distance_km ?? 0) > (best?.distance_km ?? 0) ? w : best), null);
  const passedIndex = places.filter(([, d]) => km >= d).length - 1;
  const place = (i: number) => (places[i] ? { name: places[i]![0], km: places[i]![1] } : null);
  const elevation = runs.reduce((sum, w) => sum + (w.elevation_m ?? 0), 0);
  return {
    runs: runs.length,
    km: round1(km),
    minutes: Math.round(runs.reduce((sum, w) => sum + (w.duration_min ?? 0), 0)),
    elevationM: Math.round(elevation),
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
    climb: { ...climb, count: Math.round((elevation / climb.meters) * 100) / 100 },
    region,
    passed: place(passedIndex),
    next: place(passedIndex + 1),
    blocks: runs.map((w) => {
      const d = w.distance_km ?? 0;
      return { id: w.id, date: w.date, size: d >= 21 ? 3 : d >= 10 ? 2 : d >= 5 ? 1 : 0 };
    }),
  };
}

/** 資料庫裡所有的跑步（不含重複與已刪除的）的累積 */
export async function accumulation(db: Db, today: string, timeZone: string): Promise<Accumulation> {
  const region = regionOf((await db.getProfile()).region, timeZone);
  return accumulate(await db.getRecentWorkouts(365 * 100), today, region);
}
