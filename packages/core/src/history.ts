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
import { rideMetrics } from "./ride-analysis";

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
  /** 標準化功率（瓦）與平均踏頻（rpm）；沒有時為 null（規格 12.31：有資料才顯示） */
  normalizedWatts: number | null;
  cadence: number | null;
  /** 教練的分析：第一段是結論，其餘是細節（和跑步一樣） */
  headline: string | null;
  details: string | null;
  plan: RunCard["plan"];
  outsidePlan: boolean;
  expectedRpe: [number, number] | null;
}

export function rideCardOf(activity: OtherActivity, planned: Awaited<ReturnType<typeof planResultsSince>>): RideCard {
  const m = rideMetrics(activity);
  const p = planned.byOther.get(activity.intervals_id);
  const result: SessionResult | undefined = p?.result;
  return {
    activity,
    intensity: m.intensity,
    watts: m.watts,
    normalizedWatts: m.normalizedWatts,
    cadence: m.cadence,
    ...splitSummary(activity.summary),
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
 * （距離都從那個地區的大城市算）. 名稱本身要說得出距離（「從台灣飛到東京」而不是「東京」），畫面上再附上公里數
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

/** 一站：名稱說得出距離（「從台灣飛到東京」）；short 是手機上軌道寫的短名稱；approx 是用座標算的（畫面標「約」） */
export interface Landmark {
  name: string;
  short: string;
  km: number;
  approx: boolean;
}

interface Landmarks {
  places: Landmark[];
  /** 從哪裡出發（軌道上方寫一次）：到 untilKm 為止用這一段的說法；通用的沒有 */
  legs: { label: string; untilKm: number }[];
  /** 爬升的比較對象 */
  climb: { name: string; meters: number; kind: "mountain" | "tower" };
}

/** 城市的座標（緯度、經度）：站與站的距離用大圓距離算，不手填（規格 12.29） */
const CITIES: Record<string, [number, number]> = {
  台北: [25.033, 121.5654],
  桃園機場: [25.0797, 121.2342],
  香港: [22.3193, 114.1694],
  馬尼拉: [14.5995, 120.9842],
  首爾: [37.5665, 126.978],
  北京: [39.9042, 116.4074],
  東京: [35.6762, 139.6503],
  曼谷: [13.7563, 100.5018],
  新加坡: [1.3521, 103.8198],
  雅加達: [-6.2088, 106.8456],
  德里: [28.6139, 77.209],
  孟買: [19.076, 72.8777],
  杜拜: [25.2048, 55.2708],
  雪梨: [-33.8688, 151.2093],
  倫敦: [51.5074, -0.1278],
  紐約: [40.7128, -74.006],
  邁阿密: [25.7617, -80.1918],
  利馬: [-12.0464, -77.0428],
  巴黎: [48.8566, 2.3522],
  阿姆斯特丹: [52.3676, 4.9041],
  洛杉磯: [34.0522, -118.2437],
  舊金山: [37.7749, -122.4194],
  墨爾本: [-37.8136, 144.9631],
  羅馬: [41.9028, 12.4964],
  雅典: [37.9838, 23.7275],
  丹佛: [39.7392, -104.9903],
};

const EARTH_RADIUS_KM = 6371.0088;

/** 兩個城市的大圓距離（公里，四捨五入到整數） */
export function cityDistanceKm(from: string, to: string): number {
  const [a, b] = [CITIES[from]!, CITIES[to]!];
  const rad = (x: number) => (x * Math.PI) / 180;
  const h = Math.sin(rad(b[0] - a[0]) / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(rad(b[1] - a[1]) / 2) ** 2;
  return Math.round(2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h)));
}

/** 公認距離的路線（全馬、環島、朝聖之路…） */
const route = (name: string, short: string, km: number): Landmark => ({ name, short, km, approx: false });
/** 兩個城市之間（用座標算，標「約」）；short 沒給時是目的地 */
const between = (from: string, to: string, short = to): Landmark => ({ name: `${from}到${to}`, short, km: cityDistanceKm(from, to), approx: true });
/** 環島之旅的一站：沿國道一號從基隆南下、經墾丁沿東部回到基隆，km 是沿路累積的公路里程（各段加總，標「約」） */
const aroundIsland = (city: string, km: number): Landmark => ({ name: `環島到${city}`, short: city, km, approx: true });
/** 環島之後：從台灣飛出去（桃園機場的座標算大圓距離） */
const flyFromTaiwan = (to: string): Landmark => ({ name: `從台灣飛到${to}`, short: to, km: cityDistanceKm("桃園機場", to), approx: true });
const ISLAND_KM = 1000;
const EARTH_KM = 40075;

/**
 * 每一組相鄰兩站的比例不超過約 1.4 倍（下一站最多遠四成，規格 12.29）；前段比較密.
 * 地球一圈之後（通用的到月球）照舊
 */
const LANDMARKS: Record<Region, Landmarks> = {
  "": {
    legs: [],
    places: [
      route("一場全馬", "全馬", 42.195),
      route("雙洋超馬（南非）", "雙洋超馬", 56),
      route("瑞士 K78 山地超馬", "K78", 78),
      route("康瑞德超馬（南非）", "康瑞德", 90),
      route("拉瓦雷多越野（義大利）", "拉瓦雷多", 120),
      route("西部百英里（美國）", "西部百英里", 161),
      route("惡水超馬（美國死亡谷）", "惡水超馬", 217),
      route("斯巴達松（雅典到斯巴達）", "斯巴達松", 246),
      between("倫敦", "巴黎", "倫敦–巴黎"),
      between("巴黎", "阿姆斯特丹", "巴黎–阿姆斯特丹"),
      between("洛杉磯", "舊金山", "洛杉磯–舊金山"),
      between("雪梨", "墨爾本", "雪梨–墨爾本"),
      route("聖雅各朝聖之路（法國之路）", "朝聖之路", 800),
      between("巴黎", "羅馬", "巴黎–羅馬"),
      route("英國縱走（最南到最北）", "英國縱走", 1400),
      between("紐約", "邁阿密", "紐約–邁阿密"),
      between("倫敦", "雅典", "倫敦–雅典"),
      between("紐約", "丹佛", "紐約–丹佛"),
      route("阿帕拉契山徑（美國）", "阿帕拉契山徑", 3500),
      between("紐約", "洛杉磯", "紐約–洛杉磯"),
      between("倫敦", "杜拜", "倫敦–杜拜"),
      route("尼羅河全長", "尼羅河", 6650),
      route("萬里長城（明長城）", "萬里長城", 8850),
      between("倫敦", "東京", "倫敦–東京"),
      between("紐約", "香港", "紐約–香港"),
      between("倫敦", "雪梨", "倫敦–雪梨"),
      route("地球半圈", "地球半圈", EARTH_KM / 2),
      { name: "紐約到香港來回", short: "紐約–香港來回", km: cityDistanceKm("紐約", "香港") * 2, approx: true },
      route("地球四分之三圈", "四分之三圈", (EARTH_KM * 3) / 4),
      route("地球一圈", "地球一圈", EARTH_KM),
      route("地球到月球", "月球", 384400),
    ],
    climb: { name: "聖母峰", meters: 8849, kind: "mountain" },
  },
  TW: {
    legs: [
      { label: "環島：從基隆出發", untilKm: ISLAND_KM },
      { label: "從台灣（桃園機場）出發", untilKm: Infinity },
    ],
    places: [
      aroundIsland("台北", 25),
      aroundIsland("五股", 33),
      aroundIsland("林口", 41),
      aroundIsland("桃園", 49),
      aroundIsland("中壢", 62),
      aroundIsland("楊梅", 69),
      aroundIsland("湖口", 83),
      aroundIsland("新竹", 95),
      aroundIsland("頭份", 110),
      aroundIsland("苗栗", 132),
      aroundIsland("三義", 150),
      aroundIsland("台中", 178),
      aroundIsland("彰化", 198),
      aroundIsland("斗南", 240),
      aroundIsland("嘉義", 264),
      aroundIsland("台南", 327),
      aroundIsland("高雄", 370),
      aroundIsland("枋寮", 430),
      aroundIsland("墾丁", 480),
      aroundIsland("台東", 620),
      aroundIsland("花蓮", 785),
      aroundIsland("宜蘭", 900),
      route("環島一圈（回到基隆）", "環島一圈", ISLAND_KM),
      flyFromTaiwan("馬尼拉"),
      flyFromTaiwan("首爾"),
      flyFromTaiwan("北京"),
      flyFromTaiwan("東京"),
      flyFromTaiwan("曼谷"),
      flyFromTaiwan("新加坡"),
      flyFromTaiwan("雅加達"),
      flyFromTaiwan("德里"),
      flyFromTaiwan("孟買"),
      flyFromTaiwan("杜拜"),
      flyFromTaiwan("雪梨"),
      flyFromTaiwan("倫敦"),
      flyFromTaiwan("紐約"),
      flyFromTaiwan("邁阿密"),
      flyFromTaiwan("利馬"),
      route("地球半圈", "地球半圈", EARTH_KM / 2),
      { name: "從台灣飛到紐約再飛回來", short: "紐約來回", km: cityDistanceKm("桃園機場", "紐約") * 2, approx: true },
      route("地球四分之三圈", "四分之三圈", (EARTH_KM * 3) / 4),
      route("地球一圈", "地球一圈", EARTH_KM),
    ],
    climb: { name: "台北 101", meters: 508, kind: "tower" },
  },
};

/** 一組里程碑（測試用：相鄰兩站的比例） */
export function landmarks(region: Region): Landmark[] {
  return LANDMARKS[region].places;
}

/** 軌道上的一站 */
export interface TrackStation extends Landmark {
  passed: boolean;
}

/**
 * 紀錄頁的軌道（規格 12.29）：一次四站、等距排；起點是第一站。走完軌道的最後一站，整組往前移兩站
 * （起點 A B C → 過了 C 是 B C D E → 過了 E 是 D E F G），所以除了一開始，選手都在軌道的中段或後段.
 * at 是最後一個過了的站在 stations 裡的位置，fraction 是往下一站的這一段跑了幾成；origin 是軌道上方的說法（「環島：從基隆出發」）
 */
export interface Track {
  origin: string | null;
  stations: TrackStation[];
  at: number;
  fraction: number;
}

export function landmarkTrack(km: number, region: Region): Track {
  const { places, legs } = LANDMARKS[region];
  const all: Landmark[] = [{ name: "起點", short: "起點", km: 0, approx: false }, ...places];
  const last = all.filter((p) => km >= p.km).length - 1;
  // 視窗的起點：偶數、而且視窗的最後一站還沒過（p ≤ 2 時從起點開始）
  let start = last <= 2 ? 0 : last - 2 + ((last - 2) % 2);
  start = Math.max(0, Math.min(start, all.length - 4));
  const stations = all.slice(start, start + 4).map((p) => ({ ...p, passed: km >= p.km }));
  const next = all[last + 1];
  const fraction = next ? Math.min(1, Math.max(0, (km - all[last]!.km) / (next.km - all[last]!.km))) : 1;
  // 軌道上方的說法：選手正在跑的這一段屬於哪一段旅程（環島，或從台灣飛出去）
  const origin = legs.find((l) => (next ?? all[last]!).km <= l.untilKm)?.label ?? null;
  return { origin, stations, at: last - start, fraction: next ? fraction : 0 };
}

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
  /** 紀錄頁的軌道：四站（規格 12.29） */
  track: Track;
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
  const passedIndex = places.filter((p) => km >= p.km).length - 1;
  const place = (i: number) => (places[i] ? { name: places[i]!.name, km: places[i]!.km } : null);
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
    track: landmarkTrack(km, region),
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
