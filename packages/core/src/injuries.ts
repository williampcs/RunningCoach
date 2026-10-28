/**
 * 傷病紀錄（規格 12.33 第 2 點）：部位、側別、開始日期、狀態、會痛的運動、每次回報的疼痛分數.
 *
 * 目的是安全：檢查器靠這份紀錄知道哪些運動會痛，擋掉會痛的運動的強度課與長課（plan.ts 的 injuryWarnings）.
 * 不做診斷：紀錄只有選手說的部位與分數，不寫病名.
 */
import { addDays, daysBetween } from "./dates";
import { SPORT_LABELS } from "./sports";
import type { Sport } from "./types";

export type InjuryStatus = "active" | "improving" | "resolved";
export type InjurySide = "left" | "right" | "both" | "none";
/** 這次的分數是什麼時候：運動中、運動後、隔天早上、休息或夜裡、每日自評 */
export type PainWhen = "during" | "after" | "morning" | "rest" | "checkin";

export const INJURY_STATUS_LABELS: Record<InjuryStatus, string> = { active: "進行中", improving: "好轉中", resolved: "好了" };
export const INJURY_SIDE_LABELS: Record<InjurySide, string> = { left: "左", right: "右", both: "兩側", none: "" };
export const PAIN_WHEN_LABELS: Record<PainWhen, string> = { during: "運動中", after: "運動後", morning: "隔天早上", rest: "休息或夜裡", checkin: "每日自評" };

export interface PainScore {
  date: string;
  /** 0–10 */
  score: number;
  when: PainWhen;
}

export interface Injury {
  id: number;
  /** 部位，選手的說法：膝蓋、小腿、足底… */
  area: string;
  side: InjurySide;
  started_on: string | null;
  status: InjuryStatus;
  /** 會痛的運動；空的是不知道，當成全部的運動都會痛 */
  sports: Sport[];
  /** 有紅旗（例：骨頭壓痛、腫脹、夜間痛、無法正常走路）、還沒經醫師排除：所有運動都不排 */
  red_flag: boolean;
  notes: string | null;
  /** 依日期排序，舊的在前 */
  scores: PainScore[];
  created_at: string;
  updated_at: string;
}

/** 疼痛超過這個分數時，會痛的運動的強度課與長課不能排（教練方法的疼痛規則：不超過 3/10） */
export const PAIN_LIMIT = 3;
/** 超過這麼多天沒有回報分數，也當成不能排強度課與長課（不知道現在怎麼樣時偏向保守） */
export const SCORE_STALE_DAYS = 3;

const SPORTS: Sport[] = ["run", "ride", "swim", "strength", "other"];
const WHENS = Object.keys(PAIN_WHEN_LABELS) as PainWhen[];

/** 資料庫的 sports 欄位（逗號分隔）→ 運動；認不得的略過 */
export const parseInjurySports = (text: string | null | undefined): Sport[] =>
  (text ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Sport => (SPORTS as string[]).includes(s));

export function parsePainScores(json: string | null | undefined): PainScore[] {
  try {
    const value = JSON.parse(json || "[]") as unknown;
    if (!Array.isArray(value)) return [];
    return value
      .filter((s): s is PainScore => !!s && typeof s.date === "string" && Number.isFinite(s.score))
      .map((s) => ({ date: s.date, score: Math.max(0, Math.min(10, Math.round(s.score))), when: WHENS.includes(s.when) ? s.when : "checkin" }))
      .sort((a, b) => a.date.localeCompare(b.date));
  } catch {
    return [];
  }
}

/** 加一次分數：同一天、同一個時間點的蓋掉舊的 */
export function withScore(scores: PainScore[], score: PainScore): PainScore[] {
  const rest = scores.filter((s) => !(s.date === score.date && s.when === score.when));
  return [...rest, score].sort((a, b) => a.date.localeCompare(b.date));
}

/** 「左膝」「下背」 */
export const injuryName = (i: Pick<Injury, "area" | "side">) => `${INJURY_SIDE_LABELS[i.side] ?? ""}${i.area}`;

export const isOpen = (i: Pick<Injury, "status">) => i.status !== "resolved";

/** 最近一天的分數（那天有好幾個時取最高的，偏保守）；沒有分數時是 null */
export function latestPain(i: Pick<Injury, "scores">): { date: string; score: number } | null {
  const last = i.scores.at(-1);
  if (!last) return null;
  const sameDay = i.scores.filter((s) => s.date === last.date);
  return { date: last.date, score: Math.max(...sameDay.map((s) => s.score)) };
}

/** 這個傷會不會影響這項運動：不知道會痛的運動、或課沒寫運動（舊的交叉訓練）時當成會 */
export const injuryAffects = (i: Pick<Injury, "sports">, sport: Sport | null) => !i.sports.length || sport === null || i.sports.includes(sport);

/**
 * 會痛的運動的強度課與長課為什麼不能排；可以排（照疼痛規則警告）時是 null.
 * 疼痛超過 3/10，或超過 3 天沒有回報分數（不知道現在怎麼樣）
 */
export function hardBlockReason(i: Injury, today: string): string | null {
  const latest = latestPain(i);
  if (!latest) return `${injuryName(i)}還沒有回報疼痛的分數`;
  if (latest.score > PAIN_LIMIT) return `${injuryName(i)}最近的疼痛是 ${latest.score}/10（超過 ${PAIN_LIMIT}/10）`;
  if (daysBetween(latest.date, today) > SCORE_STALE_DAYS) return `${injuryName(i)}超過 ${SCORE_STALE_DAYS} 天沒有回報疼痛的分數（最近一次 ${latest.date.slice(5)}）`;
  return null;
}

/** 會痛的運動的說法：「跑步、騎車」，不知道時「全部的運動（還不知道哪些會痛）」 */
export const injurySportsText = (i: Pick<Injury, "sports">) => (i.sports.length ? i.sports.map((s) => SPORT_LABELS[s]).join("、") : "全部的運動（還不知道哪些會痛）");

/** 教練看到的一行，例：「[id=3] 左膝（進行中，10/20 起）：會痛的運動 跑步；最近 4/10（10/27 運動後）；有紅旗」 */
export function injuryLine(i: Injury, today: string): string {
  const latest = i.scores.at(-1);
  const scores = i.scores
    .filter((s) => s.date >= addDays(today, -14))
    .slice(-6)
    .map((s) => `${s.date.slice(5)} ${PAIN_WHEN_LABELS[s.when]} ${s.score}/10`);
  return (
    `[id=${i.id}] ${injuryName(i)}（${INJURY_STATUS_LABELS[i.status]}${i.started_on ? `，${i.started_on} 起` : ""}）：會痛的運動 ${injurySportsText(i)}；` +
    (latest ? `最近兩週的疼痛 ${scores.join("、") || "（兩週內沒有）"}` : "還沒有疼痛的分數") +
    (i.red_flag ? "；有紅旗、還沒經醫師排除（所有運動都不排）" : "") +
    (i.notes ? `；備註：${i.notes}` : "")
  );
}
