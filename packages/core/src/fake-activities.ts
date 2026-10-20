/**
 * 假的跑步活動：測試模式與單元測試用，不連任何外部服務.
 *
 * 同一組設定（含亂數種子）每次產生相同的活動，方便重現同一個情況。
 * 活動以 `fake-` 開頭的 intervals_id 標示，source 為 "fake"。
 */
import { addDays, daysBetween, weekdayIndex } from "./dates";
import { EFFORT_DISTANCES } from "./intervals";
import type { Activity, ActivitySource, BestEffort, PaceCurveSummary, RunSettings, WellnessDay } from "./types";

export const FAKE_SCENARIOS = {
  steady: { label: "穩定訓練", description: "每週固定的次數與距離，週日長跑" },
  build: { label: "逐步加量", description: "每週里程增加約 8%" },
  overreach: { label: "過度訓練跡象", description: "最近兩週量暴增，同樣配速心率明顯變高" },
  injury_break: { label: "受傷中斷後復出", description: "中間停跑約 10 天，最近一週只有幾次短距離慢跑" },
  taper: { label: "賽前減量", description: "最後兩週量大幅減少，保留少量強度" },
  irregular: { label: "不規律、資料缺漏", description: "常缺課，部分紀錄沒有心率" },
} as const;

export type FakeScenario = keyof typeof FAKE_SCENARIOS;

/** 記錄跑步的裝置：決定有沒有心率、恢復資料是哪一種 */
export const FAKE_DEVICES = {
  garmin: { label: "Garmin 等手錶", description: "有心率；恢復資料的 HRV 是 rMSSD" },
  apple_watch: { label: "Apple Watch", description: "有心率；HRV 是 SDNN，沒有睡眠分數（經 Intervals.icu Companion）" },
  iphone: { label: "只有 iPhone", description: "沒有心率、沒有訓練負荷，也沒有恢復資料" },
} as const;

export type FakeDevice = keyof typeof FAKE_DEVICES;

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
  /** 預設 garmin；舊的設定沒有這一欄 */
  device?: FakeDevice;
  /** 最近 14 天的每一趟也從另一個來源傳一次（模擬手錶與手機都上傳），用來測試去重 */
  duplicates?: boolean;
}

/** 開始時間依課表類型固定，不用亂數，同一組設定的其他數值才不會變 */
const START_TIME: Record<Kind, string> = { easy: "06:30", quality: "19:00", long: "07:00" };
/** 去重：與 Intervals.icu 的同步範圍相同 */
const DUPLICATE_WINDOW_DAYS = 14;

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

/** 假的閾值心率：最大心率的 90% */
function fakeLthr(maxHr: number): number {
  return Math.round(maxHr * 0.9);
}

/** Intervals.icu 預設的 7 區心率（Friel，依閾值心率），各區的上限 */
function fakeHrZones(maxHr: number): number[] {
  const lthr = fakeLthr(maxHr);
  return [...[0.845, 0.89, 0.94, 0.99, 1.02, 1.06].map((f) => Math.round(lthr * f)), maxHr];
}

/** 各心率區間的秒數：平均心率所在的區佔 70%，前後兩區各 15%（沒有前後區時併入該區） */
function zoneTimes(avgHr: number, secs: number, zones: number[]): number[] {
  const found = zones.findIndex((z) => avgHr <= z);
  const at = found < 0 ? zones.length - 1 : found;
  const times = zones.map(() => 0);
  times[at] = Math.round(secs * 0.7);
  for (const side of [at - 1, at + 1]) {
    times[side >= 0 && side < zones.length ? side : at]! += Math.round(secs * 0.15);
  }
  return times;
}

/** 測試模式的跑步設定：只有 iPhone 時沒有心率，也就沒有閾值心率與區間 */
export function fakeRunSettings(spec: FakeSpec): RunSettings {
  if (spec.device === "iphone") return { lthr: null, max_hr: null, hr_zones: null, threshold_pace: null };
  return { lthr: fakeLthr(spec.maxHr), max_hr: spec.maxHr, hr_zones: fakeHrZones(spec.maxHr), threshold_pace: null };
}

function build(
  id: string,
  date: string,
  distanceKm: number,
  paceSec: number,
  avgHr: number | null,
  maxHr: number,
  elevationM: number,
  startTime: string | null = null,
): Activity {
  const distance = Math.round(distanceKm * 100) / 100;
  const durationMin = Math.round((distance * paceSec) / 6) / 10;
  const peakHr = avgHr === null ? null : Math.min(maxHr, avgHr + 12 + Math.round(distance / 2));
  const load = estimateLoad(durationMin, avgHr, maxHr);
  // 開始時間與經過時間（含停下來的時間）：去重靠時間重疊判斷
  const timing = startTime ? { start_date_local: `${date}T${startTime}:00`, elapsed_time: Math.round(durationMin * 60) + 90 } : {};
  // 有心率時，Intervals.icu 依當時的閾值心率與區間算出各區的時間
  const zones = fakeHrZones(maxHr);
  const hrZones =
    avgHr === null ? {} : { lthr: fakeLthr(maxHr), icu_hr_zones: zones, icu_hr_zone_times: zoneTimes(avgHr, durationMin * 60, zones) };
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
    raw_json: JSON.stringify({ fake: true, icu_training_load: load, ...timing, ...hrZones }),
  };
}

/** 同一趟從手機（經「健康」與 Intervals.icu Companion）再上傳一次：沒有心率與負荷，開始晚 40 秒、距離與時間略有差異 */
function phoneCopy(run: Activity): Activity {
  const raw = JSON.parse(run.raw_json ?? "{}") as { start_date_local?: string; elapsed_time?: number };
  return {
    ...run,
    intervals_id: `${run.intervals_id}-phone`,
    avg_hr: null,
    max_hr: null,
    training_load: null,
    distance_km: Math.round((run.distance_km ?? 0) * 101) / 100,
    duration_min: Math.round(((run.duration_min ?? 0) + 0.4) * 10) / 10,
    raw_json: JSON.stringify({
      fake: true,
      start_date_local: raw.start_date_local?.replace(/:00$/, ":40"),
      elapsed_time: (raw.elapsed_time ?? 0) + 50,
    }),
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
    const iphone = spec.device === "iphone";
    const built = build(
      `fake-${spec.seed}-${date}`,
      date,
      distance,
      pace,
      iphone ? null : avgHr,
      spec.maxHr,
      20 + rand() * 60 + distance * 2,
      START_TIME[kind],
    );
    // 只有 iPhone：沒有心率，Intervals.icu 也算不出訓練負荷
    const run = iphone
      ? { ...built, training_load: null, raw_json: JSON.stringify({ ...JSON.parse(built.raw_json!), icu_training_load: undefined }) }
      : built;
    out.push(run);
    // 手機的那份放在後面：同一天後進清單的會先同步，先存下沒有心率的這筆，再由有心率的取代
    if (spec.duplicates && !iphone && daysLeft < DUPLICATE_WINDOW_DAYS) out.push(phoneCopy(run));
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

  // 體能與疲勞：每天負荷的指數平均（42 天與 7 天），和 Intervals.icu 的算法相同；從整段期間的每日平均開始
  const loads = new Map<string, number>();
  for (const run of generateActivities(spec)) loads.set(run.date, (loads.get(run.date) ?? 0) + (run.training_load ?? 0));
  let ctl = [...loads.values()].reduce((a, b) => a + b, 0) / days;
  let atl = ctl;
  const ctlHistory: number[] = [];

  for (let d = 0; d < days; d++) {
    const date = addDays(start, d);
    const load = loads.get(date) ?? 0;
    ctl += (load - ctl) / 42;
    atl += (load - atl) / 7;
    ctlHistory.push(ctl);
    const weekAgo = ctlHistory[d - 7];
    const fitness = {
      ctl: Math.round(ctl * 10) / 10,
      atl: Math.round(atl * 10) / 10,
      rampRate: weekAgo === undefined ? null : Math.round((ctl - weekAgo) * 10) / 10,
    };
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
    const dayHrv = Math.round(hrv + jitter(4));
    const sleepScore = Math.round(Math.min(100, Math.max(40, 55 + (sleepSecs / 3600 - 6) * 15 + jitter(5))));
    const apple = spec.device === "apple_watch";
    out.push({
      date,
      resting_hr: Math.round(restingHr + jitter(1.5)),
      // Apple「健康」只有 SDNN，數值和 rMSSD 不同；也沒有睡眠分數
      hrv: apple ? null : dayHrv,
      hrv_sdnn: apple ? Math.round(dayHrv * 0.85) : null,
      sleep_secs: sleepSecs,
      sleep_score: apple ? null : sleepScore,
      readiness: null,
      raw_json: JSON.stringify({ fake: true, ...fitness }),
    });
  }
  // 只有 iPhone：沒有手錶量測的恢復資料
  return spec.device === "iphone" ? [] : out;
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
    private readonly runSettings: RunSettings | null = null,
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

  async fetchRunSettings(): Promise<RunSettings | null> {
    return this.runSettings;
  }

  /**
   * 最佳配速曲線：假資料沒有逐秒的速度，當成每一趟都是平均配速，
   * 各標準距離的最佳成績取「夠長的那幾趟」用平均配速跑完這段距離的最短時間。
   * 臨界速度由 3 km 與 10 km 的最佳成績兩點推算（Intervals.icu 用更多點擬合）。
   */
  async fetchPaceCurve(days = 90): Promise<PaceCurveSummary | null> {
    const runs = this.within(days).filter((a) => a.distance_km && a.duration_min);
    if (!runs.length) return null;
    const efforts: BestEffort[] = [];
    for (const target of EFFORT_DISTANCES) {
      let best: BestEffort | null = null;
      for (const a of runs) {
        const meters = a.distance_km! * 1000;
        if (meters < target * 0.99) continue;
        const secs = Math.round((a.duration_min! * 60 * target) / meters);
        if (!best || secs < best.secs) best = { distance_m: target, secs, race: false, date: a.date };
      }
      if (best) efforts.push(best);
    }
    const three = efforts.find((e) => e.distance_m === 3000);
    const ten = efforts.find((e) => e.distance_m === 10_000);
    const cs = three && ten && ten.secs > three.secs ? (10_000 - 3000) / (ten.secs - three.secs) : null;
    return { days, critical_speed: cs, d_prime: null, efforts };
  }
}
