/**
 * 多運動（規格 12.24）：選手練哪些運動、各運動的設定換算成目標（心率區間、功率區間）.
 *
 * - 每種運動用自己的設定：騎車的心率通常比跑步低，也有自己的 FTP 與功率區間（Intervals.icu 各運動分開設定）。
 * - 那項運動沒有設定時，不拿跑步的區間硬套：目標改用體感，並提示到 Intervals.icu 設定。
 * - 心率這條先做好（使用者沒有功率計）；功率只在有 FTP 時換算。
 */
import { heartRateInfo, type HeartRateInfo } from "./training-values";
import type { Sport, SportSettings } from "./types";

export const SPORT_LABELS: Record<Sport, string> = {
  run: "跑步",
  ride: "騎車",
  swim: "游泳",
  strength: "肌力訓練",
  other: "其他運動",
};

/** 選手資料「練哪些運動」可以選的（依序顯示） */
export const SPORT_CHOICES: Sport[] = ["run", "ride", "swim", "strength", "other"];

/** 交叉訓練的課可以寫的運動（肌力有自己的課 kind=strength） */
export const CROSS_SPORTS: readonly Sport[] = ["ride", "swim", "other"];

/** 各運動對應的 Intervals.icu 活動類型：找那項運動的設定、判斷一筆活動是哪項運動 */
const SPORT_TYPES: Record<Exclude<Sport, "other">, readonly string[]> = {
  run: ["Run", "VirtualRun", "TrailRun"],
  ride: ["Ride", "VirtualRide", "EBikeRide", "GravelRide", "MountainBikeRide", "EMountainBikeRide", "Velomobile", "TrackRide"],
  swim: ["Swim", "OpenWaterSwim"],
  strength: ["WeightTraining", "Workout", "Pilates", "Yoga"],
};

/** Intervals.icu 的活動類型 → 運動的代號；不認得的是 other */
export function sportOfType(type: string): Sport {
  for (const [sport, types] of Object.entries(SPORT_TYPES) as [Sport, readonly string[]][]) {
    if (types.includes(type)) return sport;
  }
  return /run/i.test(type) ? "run" : /ride|bike|cycl/i.test(type) ? "ride" : /swim/i.test(type) ? "swim" : "other";
}

/** 選手資料的 pref_sports（逗號分隔的代號）→ 練哪些運動；沒填時當成只跑步（舊的資料） */
export function athleteSports(profile: Record<string, string>): Sport[] {
  const picked = (profile.pref_sports ?? "")
    .split(/[\s,，、]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s): s is Sport => (SPORT_CHOICES as string[]).includes(s));
  return picked.length ? SPORT_CHOICES.filter((s) => picked.includes(s)) : ["run"];
}

/** 各運動的目標存在 pref_goal_<運動>；跑步沿用原本的 pref_goal（選項） */
export const sportGoalKey = (sport: Sport) => `pref_goal_${sport}`;

/** 一項運動的目標換算依據 */
export interface SportTargets {
  sport: Sport;
  /** 那項運動自己的心率區間（以那項運動的閾值心率切）；沒有設定時為 null */
  hr: HeartRateInfo | null;
  /** FTP（瓦）；沒有時為 null */
  ftp: number | null;
  /** 功率區間（瓦）；min 為 null 表示沒有下限，max 為 null 表示沒有上限 */
  power: { name: string; min: number | null; max: number | null }[] | null;
}

/** 那項運動的設定（第一組包含它的活動類型的） */
export function settingsFor(all: SportSettings[] | null | undefined, sport: Sport): SportSettings | null {
  if (!all || sport === "other") return null;
  const types = SPORT_TYPES[sport];
  return all.find((s) => s.types.some((t) => types.includes(t))) ?? null;
}

export function sportTargets(all: SportSettings[] | null | undefined, sport: Sport, today: string): SportTargets {
  const s = settingsFor(all, sport);
  // 只用那項運動自己的閾值與區間；選手資料的最大心率與 220－年齡是跑步的推算，不套用
  const hr = s ? heartRateInfo({}, { lthr: s.lthr, max_hr: s.max_hr, hr_zones: s.hr_zones, threshold_pace: null }, today) : null;
  const ftp = s?.ftp ?? null;
  const pcts = s?.power_zones ?? null;
  const power =
    ftp && pcts && pcts.length >= 3
      ? pcts.map((pct, i) => ({
          name: `Z${i + 1}`,
          min: i === 0 ? null : Math.round((ftp * pcts[i - 1]!) / 100) + 1,
          // Intervals.icu 預設 7 區（Coggan），最上面一區設成 999%：沒有上限
          max: pct >= 300 ? null : Math.round((ftp * pct) / 100),
        }))
      : null;
  return { sport, hr: hr?.source === "intervals" ? hr : null, ftp, power };
}

/** 區間代號的數字，例：Z5b → 5 */
export const zoneNumber = (zone: string) => Number(/^Z(\d)/i.exec(zone)?.[1] ?? 0);

/** 沒有那項運動的區間時，區間代號改成體感（我們的對照，大致等於跑步的 E、M–T、I）；甜蜜點是 6–7 */
export function zoneRpe(zone: string): [number, number] {
  if (zone.toUpperCase() === "SS") return [6, 7];
  const n = zoneNumber(zone);
  return n <= 1 ? [1, 2] : n === 2 ? [2, 4] : n === 3 ? [5, 6] : n === 4 ? [6, 7] : [8, 9];
}

/** 沒有設定時的提示，例：「騎車的心率區間還沒在 Intervals.icu 設定」 */
export function missingSettingsHint(sport: Sport, what: "hr" | "power"): string {
  if (sport === "other") return "這項運動沒有區間的設定";
  return what === "power" ? `還沒有${SPORT_LABELS[sport]}的 FTP` : `${SPORT_LABELS[sport]}的心率區間還沒在 Intervals.icu 設定`;
}

/** 給教練看的一行，例：「騎車：閾值心率 158｜Z1 ≤128｜…；FTP 230 W｜功率 Z1 ≤127｜…」 */
export function sportTargetsText(t: SportTargets): string {
  const parts: string[] = [];
  if (t.hr) parts.push(`閾值心率 ${t.hr.lthr}｜心率區間 ${t.hr.zones.map((z) => `${z.name} ${z.min === null ? `≤${z.max}` : `${z.min}–${z.max}`}`).join("｜")}`);
  else parts.push(`沒有${SPORT_LABELS[t.sport]}的心率區間（Intervals.icu 沒有設定閾值心率與區間）：目標用體感，不要拿跑步的區間套用`);
  if (t.power) parts.push(`FTP ${t.ftp} W｜功率區間 ${t.power.map((z) => `${z.name} ${powerRange(z)}`).join("｜")}`);
  else if (t.sport === "ride") parts.push("沒有 FTP 與功率區間（沒有功率計時用心率）");
  return `${SPORT_LABELS[t.sport]}：${parts.join("；")}`;
}

export function powerRange(z: { min: number | null; max: number | null }): string {
  if (z.min === null) return `≤${z.max} W`;
  if (z.max === null) return `≥${z.min} W`;
  return `${z.min}–${z.max} W`;
}

// ---------------------------------------------------------------------------
// 單車的課（規格 12.24 的第 3 階段、doc/coaching-method-cycling.md）
// ---------------------------------------------------------------------------

/** 甜蜜點的代號（{"power":"SS"}、{"zone":"SS"}）：FTP 的 88–94%；沒有功率時用騎車閾值心率的 91–96%（我們的對照） */
export const SWEET_SPOT = "SS";
export const SWEET_SPOT_POWER: [number, number] = [88, 94];
export const SWEET_SPOT_HR: [number, number] = [91, 96];

/** 沒有功率資料時，心率跟不上的短間歇：每段這麼多分鐘以內、Z5 以上的，目標改看體感 */
export const SHORT_INTERVAL_MIN = 5;

/** 估算騎車距離與時間用的均速（km/h）：最近沒有騎車紀錄時用 */
export const DEFAULT_RIDE_KMH = 25;

/** 區間代號的強度等級（1–7）；甜蜜點算 3.5（中強度的上段） */
export function zoneLevel(zone: string): number {
  return zone.toUpperCase() === SWEET_SPOT ? 3.5 : zoneNumber(zone);
}

/** 甜蜜點的心率範圍（騎車的閾值心率的 91–96%）；沒有閾值心率時為 null */
export function sweetSpotHr(t: SportTargets | undefined): [number, number] | null {
  const lthr = t?.hr?.lthr;
  return lthr ? [Math.round((lthr * SWEET_SPOT_HR[0]) / 100), Math.round((lthr * SWEET_SPOT_HR[1]) / 100)] : null;
}

/** 甜蜜點的功率範圍（FTP 的 88–94%）；沒有 FTP 時為 null */
export function sweetSpotPower(t: SportTargets | undefined): [number, number] | null {
  return t?.ftp ? [Math.round((t.ftp * SWEET_SPOT_POWER[0]) / 100), Math.round((t.ftp * SWEET_SPOT_POWER[1]) / 100)] : null;
}
