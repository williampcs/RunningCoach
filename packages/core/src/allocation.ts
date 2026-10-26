/**
 * 多運動的每週額度（規格 12.26 第 4 點）：程式先算這週每項運動的時間與強度課，教練只在額度裡排課，檢查器照額度檢查.
 *
 * - 每項運動的強度偏好決定它想要幾堂強度課（輕鬆就好 0、適度 1、想要挑戰 2），兩項合計不超過上限（3 堂；新手 2 堂）。
 * - 主要運動拿約六到七成的時間與至少一半的強度課；不選就依各項的設定。
 * - 賽事進入專項準備期時，那項暫時變主要（全馬賽前約 12 週、半馬約 8 週、10 km 以下約 6 週、單車的賽事約 8 週）；
 *   賽前減量那週兩項都降量；賽後恢復完（全馬 2 週、其他 1 週）回到原本的主要運動。
 * 門檻是我們的做法（doc/coaching-method.md、doc/coaching-method-cycling.md 的「依額度」），沒有研究依據。
 */
import { addDays, daysBetween, weekdayIndex } from "./dates";
import { raceOutcome } from "./races";
import { athleteSports, sportOfType, SPORT_LABELS } from "./sports";
import type { OtherActivity, Race, Workout } from "./types";

/** 有額度的運動（先做跑步與騎車；肌力、游泳等照原本的做法） */
export type AllocSport = "run" | "ride";
export const ALLOC_SPORTS: readonly AllocSport[] = ["run", "ride"];

export const ALLOCATION_RULES = {
  /** 兩項合計一週最多幾堂強度課；新手（最近 8 週有練的週數不到 4 週）2 堂 */
  qualityCap: 3,
  beginnerQualityCap: 2,
  /** 主要運動拿的時間比例 */
  primaryShare: 0.65,
  /** 專項準備期（週）：全馬、半馬、10 km 以下、單車的賽事 */
  prepWeeks: { full: 12, half: 8, short: 6, ride: 8 },
  /** 賽前減量的天數：全馬、半馬、10 km 以下、單車 */
  taperDays: { full: 14, half: 10, short: 7, ride: 10 },
  /** 減量週的時間比例 */
  taperFactor: 0.6,
  /** 賽後恢復的天數：全馬、其他 */
  recoveryDays: { full: 14, other: 7 },
  /** 沒填時的預設：一趟跑步的分鐘、每週騎車的分鐘 */
  defaultRunMinutes: 45,
  defaultRideMinutes: 120,
};

const QUALITY_BY_INTENSITY: Record<string, number> = { easy: 0, moderate: 1, challenge: 2 };

export interface SportAllocation {
  sport: AllocSport;
  /** 跑步的次數（跑步才有；騎車用時間） */
  count: number | null;
  /** 這週的時間（分鐘） */
  minutes: number;
  /** 強度課的堂數 */
  quality: number;
  /** 這項想要的（沒有被主要運動或上限調整前）：強度課與時間 */
  wanted: { quality: number; minutes: number };
}

export interface WeekAllocation {
  weekStart: string;
  /** 這週的主要運動（選手選的，或賽事準備期暫時的）；沒有時 null */
  primary: AllocSport | null;
  /** 選手自己選的主要運動 */
  chosenPrimary: AllocSport | null;
  /** 兩項合計的強度課上限 */
  qualityCap: number;
  beginner: boolean;
  sports: SportAllocation[];
  /** 給教練與選手看的原因，例：「離 11/15 半馬剩 6 週，以跑步為主」 */
  reasons: string[];
  /** 賽前減量週 */
  taper: boolean;
  /** 賽後恢復中（那項沒有強度課） */
  recovering: AllocSport | null;
}

type RaceKind = "full" | "half" | "short" | "ride";
const raceKind = (r: Race): RaceKind => (r.sport === "ride" ? "ride" : r.distance_km >= 40 ? "full" : r.distance_km >= 20 ? "half" : "short");
const raceSport = (r: Race): AllocSport => (r.sport === "ride" ? "ride" : "run");
const monthDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
const intOf = (v: string | undefined) => (v && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : null);

/** 選手選的主要運動（pref_primary_sport）；沒選或沒練那項時為 null */
export function chosenPrimary(profile: Record<string, string>): AllocSport | null {
  const v = profile.pref_primary_sport as AllocSport | undefined;
  return v && ALLOC_SPORTS.includes(v) && athleteSports(profile).includes(v) ? v : null;
}

/**
 * 這週的額度. 練騎車的人才有（只跑步的人照跑步原本的規則）；workouts、others 是最近 8 週以上的跑步與其他運動
 */
export function weekAllocation(
  profile: Record<string, string>,
  races: Race[],
  weekStart: string,
  today: string,
  workouts: Pick<Workout, "date" | "duration_min">[],
  others: Pick<OtherActivity, "date" | "type" | "duration_min">[],
): WeekAllocation | null {
  const sports = ALLOC_SPORTS.filter((s) => athleteSports(profile).includes(s));
  if (!sports.includes("ride")) return null;
  const weekEnd = addDays(weekStart, 6);
  const rides = others.filter((a) => sportOfType(a.type) === "ride");
  const reasons: string[] = [];

  // 新手：最近 8 週有練（跑步或騎車）的週數不到 4 週
  const activeWeeks = new Set(
    [...workouts, ...rides]
      .filter((a) => a.date < weekStart && daysBetween(a.date, weekStart) <= 56)
      .map((a) => addDays(a.date, -weekdayIndex(a.date))),
  ).size;
  const beginner = activeWeeks < 4;
  const qualityCap = beginner ? ALLOCATION_RULES.beginnerQualityCap : ALLOCATION_RULES.qualityCap;

  // 賽事：專項準備期的那項暫時變主要；減量週；賽後恢復
  const relevant = races.filter((r) => r.confirmed && sports.includes(raceSport(r)));
  const upcoming = relevant.filter((r) => raceOutcome(r) === null && r.date >= weekStart).sort((a, b) => a.date.localeCompare(b.date));
  const chosen = chosenPrimary(profile);
  let primary: AllocSport | null = chosen;
  const prep = upcoming.find((r) => daysBetween(weekStart, r.date) <= ALLOCATION_RULES.prepWeeks[raceKind(r)] * 7);
  if (prep) {
    primary = raceSport(prep);
    const weeks = Math.max(1, Math.ceil(daysBetween(weekStart, prep.date) / 7));
    reasons.push(`離 ${monthDay(prep.date)}「${prep.name}」剩 ${weeks} 週，以${SPORT_LABELS[primary]}為主${chosen && chosen !== primary ? `（平常的主要運動是${SPORT_LABELS[chosen]}，賽後回到${SPORT_LABELS[chosen]}）` : ""}`);
  } else if (chosen) {
    reasons.push(`主要運動是${SPORT_LABELS[chosen]}`);
  } else {
    reasons.push("沒有選主要運動，依各項的設定");
  }
  const taperRace = upcoming.find((r) => r.date <= addDays(weekEnd, 0) || daysBetween(weekStart, r.date) <= ALLOCATION_RULES.taperDays[raceKind(r)]);
  const taper = !!taperRace;
  if (taperRace) reasons.push(`${monthDay(taperRace.date)}「${taperRace.name}」前的減量週：兩項都降量（約 ${Math.round(ALLOCATION_RULES.taperFactor * 100)}%），保留少量強度`);
  // 賽後恢復：最近完賽（或沒完賽）的那項，恢復期間沒有強度課
  const finished = relevant
    .filter((r) => (raceOutcome(r) === "finished" || raceOutcome(r) === "dnf") && r.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  const recovering =
    finished && daysBetween(finished.date, weekStart) < (raceKind(finished) === "full" ? ALLOCATION_RULES.recoveryDays.full : ALLOCATION_RULES.recoveryDays.other)
      ? raceSport(finished)
      : null;
  if (recovering) reasons.push(`${monthDay(finished!.date)}「${finished!.name}」賽後恢復：這週${SPORT_LABELS[recovering]}不排強度課，恢復完回到原本的安排`);

  // 各項想要的：強度課依那項的強度偏好；時間依每週的量（跑步：次數 × 平常一趟的時間；騎車：時數）
  const recentRuns = workouts.filter((w) => w.date < weekStart && daysBetween(w.date, weekStart) <= 28);
  const runMinutesEach = recentRuns.length
    ? recentRuns.reduce((s, w) => s + (w.duration_min ?? 0), 0) / recentRuns.length
    : ALLOCATION_RULES.defaultRunMinutes;
  const runCount = intOf(profile.pref_runs_per_week) ?? (recentRuns.length ? Math.max(1, Math.round(recentRuns.length / 4)) : 3);
  const recentRideMinutes = rides.filter((a) => a.date < weekStart && daysBetween(a.date, weekStart) <= 28).reduce((s, a) => s + (a.duration_min ?? 0), 0) / 4;
  const rideHours = intOf(profile.pref_ride_hours);
  const rideMinutes = rideHours !== null ? rideHours * 60 : recentRideMinutes >= 30 ? Math.round(recentRideMinutes) : ALLOCATION_RULES.defaultRideMinutes;
  // 騎車沒有自己的強度偏好時沿用跑步的（多運動的卡之前只有一個強度）
  const intensity = (s: AllocSport) => (s === "run" ? profile.pref_intensity : profile.pref_intensity_ride || profile.pref_intensity) || "moderate";
  const wanted: Record<AllocSport, { quality: number; minutes: number }> = {
    run: { quality: QUALITY_BY_INTENSITY[intensity("run")] ?? 1, minutes: Math.round(runCount * runMinutesEach) },
    ride: { quality: QUALITY_BY_INTENSITY[intensity("ride")] ?? 1, minutes: rideMinutes },
  };

  const quality: Record<AllocSport, number> = { run: 0, ride: 0 };
  const minutes: Record<AllocSport, number> = { run: 0, ride: 0 };
  for (const s of sports) {
    quality[s] = wanted[s].quality;
    minutes[s] = wanted[s].minutes;
  }
  // 主要運動：至少一半的強度課（輔助的那項不比主要的多），約六到七成的時間
  const other = (s: AllocSport): AllocSport => (s === "run" ? "ride" : "run");
  if (primary && sports.length === 2) {
    const secondary = other(primary);
    // 準備期的那項至少一堂（選手設「輕鬆就好」時尊重設定）
    if (prep && quality[primary] === 0 && intensity(primary) !== "easy") quality[primary] = 1;
    quality[secondary] = Math.min(quality[secondary], quality[primary]);
    const share = minutes[primary] / Math.max(1, minutes[primary] + minutes[secondary]);
    if (share < ALLOCATION_RULES.primaryShare - 0.05) {
      minutes[secondary] = Math.round((minutes[primary] * (1 - ALLOCATION_RULES.primaryShare)) / ALLOCATION_RULES.primaryShare);
    }
  }
  // 兩項合計的上限：先減輔助的（沒有主要運動時減比較多的那項，一樣多時減騎車）
  while (quality.run + quality.ride > qualityCap) {
    const cut = primary && sports.length === 2 && quality[other(primary)] > 0 ? other(primary) : quality.run > quality.ride ? "run" : quality.ride > 0 ? "ride" : "run";
    quality[cut] -= 1;
  }
  if (recovering) quality[recovering] = 0;
  if (taper) for (const s of sports) minutes[s] = Math.round(minutes[s] * ALLOCATION_RULES.taperFactor);
  if (beginner) reasons.push(`最近 8 週有練的只有 ${activeWeeks} 週：兩項合計的強度課最多 ${qualityCap} 堂`);

  return {
    weekStart,
    primary,
    chosenPrimary: chosen,
    qualityCap,
    beginner,
    taper,
    recovering,
    reasons,
    sports: sports.map((s) => ({
      sport: s,
      count: s === "run" ? (taper ? Math.max(1, runCount) : runCount) : null,
      minutes: minutes[s],
      quality: quality[s],
      wanted: wanted[s],
    })),
  };
}

const hoursText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分鐘`);

/** 一行的額度，例：「跑步 3 次（約 2 小時 15 分）、強度課 1；騎車 2 小時、強度課 1」 */
export function allocationLine(a: WeekAllocation): string {
  return a.sports
    .map((s) =>
      s.sport === "run"
        ? `跑步 ${s.count} 次（約 ${hoursText(s.minutes)}）、強度課 ${s.quality}`
        : `騎車 ${hoursText(s.minutes)}、強度課 ${s.quality}`,
    )
    .join("；");
}

/** get_training_values 的【這週的額度】 */
export function allocationText(a: WeekAllocation): string[] {
  return [
    `【這週的額度】（${a.weekStart} 起；由程式依訓練偏好、主要運動與賽程算的，排課只在額度內，檢查器照額度檢查）`,
    `・${allocationLine(a)}；兩項合計的強度課最多 ${a.qualityCap} 堂`,
    ...a.reasons.map((r) => `・${r}`),
    "・主要運動因為賽事改變（或賽後回到原本的）時，在課表的 reason 用一句話告訴選手（例如「離 11/15 半馬剩 6 週，這幾週以跑步為主」）。",
  ];
}
