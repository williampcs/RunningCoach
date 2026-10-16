/**
 * 假的跑步活動：測試模式與單元測試用，不連任何外部服務.
 *
 * 同一組設定（含亂數種子）每次產生相同的活動，方便重現同一個情況。
 * 活動以 `fake-` 開頭的 intervals_id 標示，source 為 "fake"。
 */
import { addDays, daysBetween, weekdayIndex } from "./dates";
import type { Activity, ActivitySource, WellnessDay } from "./types";

export const FAKE_SCENARIOS = {
  steady: { label: "穩定訓練", description: "每週固定的次數與距離，週日長跑" },
  build: { label: "逐步加量", description: "每週里程增加約 8%" },
  overreach: { label: "過度訓練跡象", description: "最近兩週量暴增，同樣配速心率明顯變高" },
  injury_break: { label: "受傷中斷後復出", description: "中間停跑約 10 天，最近一週只有幾次短距離慢跑" },
  taper: { label: "賽前減量", description: "最後兩週量大幅減少，保留少量強度" },
  irregular: { label: "不規律、資料缺漏", description: "常缺課，部分紀錄沒有心率" },
} as const;

export type FakeScenario = keyof typeof FAKE_SCENARIOS;

export interface FakeSpec {
  scenario: FakeScenario;
  /** 產生的最後一天（含）；之後模擬日期往後移，就像時間過去了 */
  endDate: string;
  weeks: number;
  runsPerWeek: number;
  /** 輕鬆跑配速，每公里秒數 */
  easyPaceSec: number;
  maxHr: number;
  seed: number;
}

/** 每週跑步的日子（星期一 = 0）；最後一天固定是長跑 */
const RUN_DAYS: Record<number, number[]> = {
  1: [6],
  2: [2, 6],
  3: [1, 3, 6],
  4: [1, 3, 5, 6],
  5: [0, 1, 3, 5, 6],
  6: [0, 1, 2, 3, 5, 6],
  7: [0, 1, 2, 3, 4, 5, 6],
};

type Kind = "easy" | "quality" | "long";

/** mulberry32：可重現的亂數 */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function formatPace(secPerKm: number): string {
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}/km`;
}

/** 「5:45」或「5:45/km」→ 345 秒；無法解讀時回傳 null */
export function parsePace(text: string): number | null {
  const m = /^\s*(\d{1,2}):([0-5]\d)\s*(\/km)?\s*$/.exec(text);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 訓練負荷的粗略估計：時間 × 強度（心率佔最大心率的比例）的平方，約略對應 Intervals.icu 的尺度 */
function estimateLoad(durationMin: number, avgHr: number | null, maxHr: number): number {
  const fraction = avgHr ? avgHr / maxHr : 0.72;
  return Math.round(durationMin * fraction * fraction * 1.6);
}

function build(
  id: string,
  date: string,
  distanceKm: number,
  paceSec: number,
  avgHr: number | null,
  maxHr: number,
  elevationM: number,
): Activity {
  const distance = Math.round(distanceKm * 100) / 100;
  const durationMin = Math.round((distance * paceSec) / 6) / 10;
  const peakHr = avgHr === null ? null : Math.min(maxHr, avgHr + 12 + Math.round(distance / 2));
  const load = estimateLoad(durationMin, avgHr, maxHr);
  return {
    intervals_id: id,
    source: "fake",
    date,
    type: "run",
    distance_km: distance,
    duration_min: durationMin,
    avg_hr: avgHr,
    max_hr: peakHr,
    avg_pace: formatPace(paceSec),
    elevation_m: Math.round(elevationM),
    calories: Math.round(distance * 62),
    training_load: load,
    raw_json: JSON.stringify({ fake: true, icu_training_load: load }),
  };
}

/** 依情境產生一段期間的跑步紀錄，舊的在前 */
export function generateActivities(spec: FakeSpec): Activity[] {
  const rand = random(spec.seed);
  const jitter = (range: number) => (rand() * 2 - 1) * range;
  const days = spec.weeks * 7;
  const start = addDays(spec.endDate, -(days - 1));
  const runDays = RUN_DAYS[Math.min(7, Math.max(1, Math.round(spec.runsPerWeek)))]!;
  const out: Activity[] = [];

  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const weekday = weekdayIndex(date);
    if (!runDays.includes(weekday)) continue;

    const week = Math.floor(d / 7); // 0 = 最早的一週
    const weeksLeft = spec.weeks - 1 - week; // 0 = 最近的一週
    const daysLeft = days - 1 - d;
    const kind: Kind =
      weekday === runDays[runDays.length - 1] ? "long" : runDays.length >= 3 && weekday === runDays[1] ? "quality" : "easy";

    let distance = kind === "long" ? 16 : kind === "quality" ? 10 : 8;
    let pace = kind === "long" ? spec.easyPaceSec + 15 : kind === "quality" ? spec.easyPaceSec - 50 : spec.easyPaceSec;
    let hrFraction = kind === "long" ? 0.75 : kind === "quality" ? 0.86 : 0.71;
    let hasHr = true;

    switch (spec.scenario) {
      case "build":
        distance *= 1 + 0.08 * week;
        break;
      case "overreach":
        if (weeksLeft <= 1) {
          distance *= 1.35;
          pace += 8;
          hrFraction += 0.05;
        }
        break;
      case "injury_break":
        // 最近第 17～8 天停跑，最近 7 天只有短距離慢跑，而且不跑強度與長跑
        if (daysLeft >= 7 && daysLeft <= 16) continue;
        if (daysLeft < 7) {
          if (kind !== "easy") continue;
          distance = 4;
          pace += 25;
          hrFraction -= 0.02;
        }
        break;
      case "taper":
        if (weeksLeft === 1) distance *= 0.65;
        if (weeksLeft === 0) {
          distance *= kind === "long" ? 0.4 : 0.6;
          if (kind === "quality") distance = 6;
        }
        break;
      case "irregular":
        if (rand() < 0.4) continue;
        hasHr = rand() > 0.3;
        if (rand() < 0.15) distance = 2 + rand() * 2;
        break;
      case "steady":
        break;
    }

    distance = Math.max(1, distance + jitter(distance * 0.08));
    pace += jitter(8);
    const avgHr = hasHr ? Math.round(spec.maxHr * hrFraction + jitter(3)) : null;
    out.push(build(`fake-${spec.seed}-${date}`, date, distance, pace, avgHr, spec.maxHr, 20 + rand() * 60 + distance * 2));
  }
  return out;
}

/** 單筆自訂的跑步，例如「今天跑了 10 公里、52 分鐘、平均心率 160」 */
export function fakeActivity(input: {
  date: string;
  distanceKm: number;
  durationMin: number;
  avgHr?: number | null;
  maxHr?: number | null;
  elevationM?: number | null;
  /** 估算負荷用；預設 190 */
  athleteMaxHr?: number;
  id?: string;
}): Activity {
  const paceSec = (input.durationMin * 60) / input.distanceKm;
  const athleteMax = input.athleteMaxHr ?? 190;
  const activity = build(
    input.id ?? `fake-custom-${input.date}-${Math.round(input.distanceKm * 100)}-${Math.round(input.durationMin * 10)}`,
    input.date,
    input.distanceKm,
    paceSec,
    input.avgHr ?? null,
    athleteMax,
    input.elevationM ?? 0,
  );
  return {
    ...activity,
    // 使用者輸入的時間優先，不用配速回推（避免四捨五入誤差）
    duration_min: Math.round(input.durationMin * 10) / 10,
    max_hr: input.maxHr ?? activity.max_hr,
    elevation_m: input.elevationM ?? null,
  };
}

/**
 * 同一段期間的恢復資料（靜息心率、HRV、睡眠），隨情境變化：
 * 過度訓練時最近 10 天靜息心率上升、HRV 下降、睡眠變少；賽前減量時恢復變好；資料缺漏時有些天沒有。
 * 用另一組亂數，不影響 generateActivities 的結果。
 */
export function generateWellness(spec: FakeSpec): WellnessDay[] {
  const rand = random(spec.seed + 1000);
  const jitter = (range: number) => (rand() * 2 - 1) * range;
  const days = spec.weeks * 7;
  const start = addDays(spec.endDate, -(days - 1));
  const out: WellnessDay[] = [];

  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const daysLeft = days - 1 - d;
    let restingHr = 52;
    let hrv = 62;
    let sleepHours = 7.2;

    switch (spec.scenario) {
      case "overreach":
        if (daysLeft < 10) {
          restingHr += 6;
          hrv *= 0.78;
          sleepHours -= 0.8;
        }
        break;
      case "build":
        if (daysLeft < 14) restingHr += 2;
        break;
      case "injury_break":
        if (daysLeft >= 7 && daysLeft <= 16) sleepHours += 0.4;
        break;
      case "taper":
        if (daysLeft < 7) {
          restingHr -= 2;
          hrv *= 1.08;
        }
        break;
      case "irregular":
        if (rand() < 0.3) continue;
        break;
      case "steady":
        break;
    }

    const sleepSecs = Math.round((sleepHours + jitter(0.5)) * 3600);
    out.push({
      date,
      resting_hr: Math.round(restingHr + jitter(1.5)),
      hrv: Math.round(hrv + jitter(4)),
      sleep_secs: sleepSecs,
      sleep_score: Math.round(Math.min(100, Math.max(40, 55 + (sleepSecs / 3600 - 6) * 15 + jitter(5)))),
      readiness: null,
      raw_json: JSON.stringify({ fake: true }),
    });
  }
  return out;
}

/**
 * 以假資料取代 Intervals.icu 的活動來源。
 * 日期範圍與 IntervalsClient 相同（今天往前 N 天，含當天）；日期在「今天」之後的活動看不到，
 * 所以把模擬日期往後移，就像時間過去、手錶陸續同步。
 */
export class FakeActivitySource implements ActivitySource {
  private readonly activities: Activity[];

  constructor(
    activities: Activity[],
    private readonly today: () => string,
    private readonly wellness: WellnessDay[] = [],
  ) {
    // 新的在前；同一天的，清單中較後面的（例如後來新增的自訂紀錄）視為較晚跑的
    this.activities = activities
      .map((activity, index) => ({ activity, index }))
      .sort((a, b) => b.activity.date.localeCompare(a.activity.date) || b.index - a.index)
      .map(({ activity }) => activity);
  }

  private within(days: number): Activity[] {
    const today = this.today();
    return this.activities.filter((a) => {
      const age = daysBetween(a.date, today);
      return age >= 0 && age <= days;
    });
  }

  async fetchLatestActivity(): Promise<Activity | null> {
    return this.within(7)[0] ?? null;
  }

  async fetchActivities(days = 14): Promise<Activity[]> {
    return this.within(days);
  }

  async fetchWellness(days = 14): Promise<WellnessDay[]> {
    const today = this.today();
    return this.wellness.filter((w) => {
      const age = daysBetween(w.date, today);
      return age >= 0 && age <= days;
    });
  }
}
