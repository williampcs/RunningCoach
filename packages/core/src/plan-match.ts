/**
 * 計畫與實際的對照（規格 12.8 的 3b）：把這週的跑步與其他運動配到課表的課，判斷完成度與難度.
 *
 * 原則：課表是建議，不是考核。配對依資料計算（日期與課的種類），不依建立的先後；
 * 跑了別的課不算未達成，而是「跑了不一樣的課」；沒跑的課跳過即可，不要補。
 * 難度不另外問：用跑後回報的體感和這種課預期的體感比較（EXPECTED_RPE）。
 */
import { STRENGTH_TYPES } from "./activity-labels";
import { addDays } from "./dates";
import { sportOfType } from "./sports";
import {
  estimateSession,
  EXPECTED_RPE,
  intensityMinutes,
  isHardCross,
  isHardOther,
  isRepeat,
  isQualityKind,
  NON_RUN_KINDS,
  QUALITY_KINDS,
  RIDE_KINDS,
  RIDE_QUALITY_KINDS,
  stepIntensity,
  type PlannedSession,
  type SessionKind,
  type Step,
  type TargetContext,
} from "./plan";
import type { Db } from "./db";
import type { OtherActivity, Workout } from "./types";

export { intensityMinutes };

export type Outcome = "achieved" | "partial" | "different" | "missed" | "pending" | "skipped" | "fallback" | "rested" | "not_rested";
export type Difficulty = "hard" | "right" | "easy";

export const OUTCOME_LABELS: Record<Outcome, string> = {
  achieved: "達成",
  partial: "部分達成",
  different: "跑了不一樣的課",
  missed: "沒跑",
  pending: "",
  skipped: "已跳過",
  fallback: "改用替代",
  rested: "有休息",
  not_rested: "休息日有運動",
};
export const DIFFICULTY_LABELS: Record<Difficulty, string> = { hard: "體感偏難", right: "體感剛好", easy: "體感偏輕鬆" };

export interface SessionResult {
  outcome: Outcome;
  reasons: string[];
  difficulty: Difficulty | null;
  /** 配到的實際紀錄，例：「10.2 km、58 分鐘、心率 150、體感 6」 */
  actual: string | null;
  workoutId: number | null;
  /** 配到的其他運動（騎車等）的 intervals_id；跑步與沒配到的沒有 */
  activityId?: string | null;
}

export interface WeekMatch {
  results: Map<number, SessionResult>;
  /** 這週沒有配到課的跑步（例如排課前已跑、課表外多跑的） */
  extraRuns: Workout[];
  /** 這週沒有配到課的其他運動（課表外的騎車等；規格 12.24 的主動建議調整用） */
  extraOthers: OtherActivity[];
}

/** 強度課在主課配速上的分鐘（M、T、I、R 的步驟） */
function qualityMinutes(session: PlannedSession, ctx: TargetContext): number {
  let minutes = 0;
  const add = (step: Step, times: number) => {
    if (!step.target || !("pace" in step.target) || step.target.pace === "E") return;
    minutes += estimateSession({ ...session, steps: [step] }, ctx).minutes * times;
  };
  for (const step of session.steps) {
    if (isRepeat(step)) for (const inner of step.steps) add(inner, step.repeat);
    else add(step, 1);
  }
  return minutes;
}

export function difficultyOf(kind: SessionKind, effort: number | null): Difficulty | null {
  const range = EXPECTED_RPE[kind];
  if (!range || effort == null) return null;
  if (effort > range[1]) return "hard";
  if (effort < range[0]) return "easy";
  return "right";
}

function actualText(w: Workout): string {
  const parts = [`${w.distance_km ?? "?"} km`, `${Math.round(w.duration_min ?? 0)} 分鐘`];
  if (w.avg_hr != null) parts.push(`心率 ${w.avg_hr}`);
  if (w.perceived_effort != null) parts.push(`體感 ${w.perceived_effort}`);
  return parts.join("、");
}

/** 一堂跑步課與實際的一趟：完成度、原因與難度 */
export function judgeRun(session: PlannedSession, w: Workout, ctx: TargetContext): SessionResult {
  const planned = estimateSession(session, ctx);
  // 改用替代時，當成一堂輕鬆跑來看
  const kind: SessionKind = session.status === "fallback" ? "easy" : session.kind;
  const reasons: string[] = [];
  const minutes = w.duration_min ?? 0;
  const km = w.distance_km ?? 0;
  const ratio = Math.max(planned.minutes ? minutes / planned.minutes : 0, planned.km ? km / planned.km : 0);
  const shortRun = session.status !== "fallback" && ratio < 0.85;
  if (shortRun) reasons.push(`比計畫短（約 ${Math.round(ratio * 100)}%）`);

  const intensity = intensityMinutes(w, ctx.values.hr?.lthr ?? null);
  const difficulty = difficultyOf(kind, w.perceived_effort);
  let different = false;
  let weak = false;
  if (QUALITY_KINDS.has(kind)) {
    const needed = qualityMinutes(session, ctx);
    if (intensity && needed > 0) {
      if (intensity.above < needed * 0.3) {
        different = true;
        reasons.push("強度比計畫低，比較像輕鬆跑");
      } else if (intensity.above < needed * 0.6) {
        weak = true;
        reasons.push("強度課的時間比計畫少");
      }
    } else if (w.perceived_effort != null && w.perceived_effort <= 4) {
      different = true;
      reasons.push("體感很輕鬆，比較像輕鬆跑");
    }
  } else if (kind === "easy" || kind === "long") {
    const total = intensity ? intensity.low + intensity.above : 0;
    if (intensity && total > 0 && intensity.low / total < 0.7) {
      different = true;
      reasons.push(`強度比計畫高（低強度只有 ${Math.round((intensity.low / total) * 100)}%）`);
    } else if (!intensity && w.avg_hr != null && ctx.values.hr && w.avg_hr > ctx.values.hr.easyMax + 5) {
      different = true;
      reasons.push(`平均心率 ${w.avg_hr} 高於輕鬆跑上限 ${ctx.values.hr.easyMax}`);
    } else if (!intensity && difficulty === "hard" && (w.perceived_effort ?? 0) >= 7) {
      different = true;
      reasons.push("體感比輕鬆跑硬很多");
    }
  }
  if (difficulty === "hard" && !different) reasons.push("體感比預期累");

  const outcome: Outcome =
    session.status === "fallback" ? "fallback" : different ? "different" : shortRun || weak ? "partial" : "achieved";
  return { outcome, reasons, difficulty, actual: actualText(w), workoutId: w.id };
}

/** 熱天：活動的平均氣溫（裝置量的）在這個溫度以上時，心率漂移要放寬 */
const HOT_C = 28;
/** 長時間：這麼多分鐘以上的騎乘，心率漂移要放寬 */
const LONG_RIDE_DRIFT_MIN = 90;

/** 功率區間的時間：Z1–Z2 為低，其他為中、高（甜蜜點的時間和其他區間重疊，不算）；沒有功率資料時為 null */
export function powerMinutes(a: { raw_json?: string | null }): { low: number; above: number } | null {
  let raw: Record<string, unknown> = {};
  try {
    raw = a.raw_json ? (JSON.parse(a.raw_json) as Record<string, unknown>) : {};
  } catch {
    return null;
  }
  const times = Array.isArray(raw.icu_zone_times) ? (raw.icu_zone_times as { id?: unknown; secs?: unknown }[]) : null;
  if (!times?.length) return null;
  let low = 0;
  let above = 0;
  for (const z of times) {
    const id = String(z.id ?? "");
    const secs = typeof z.secs === "number" ? z.secs : 0;
    if (!/^Z\d$/.test(id)) continue;
    if (Number(id.slice(1)) <= 2) low += secs;
    else above += secs;
  }
  return low + above > 0 ? { low: low / 60, above: above / 60 } : null;
}

function rawNumber(a: { raw_json?: string | null }, key: string): number | null {
  try {
    const v = a.raw_json ? (JSON.parse(a.raw_json) as Record<string, unknown>)[key] : null;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

/** 其他運動的實際紀錄，例：「62 分鐘、24.1 km、心率 132、負荷 55、功率 165 W、體感 4」 */
export function otherActualText(a: OtherActivity): string {
  const parts = [`${Math.round(a.duration_min ?? 0)} 分鐘`];
  if (a.distance_km) parts.push(`${a.distance_km} km`);
  if (a.avg_hr != null) parts.push(`心率 ${a.avg_hr}`);
  if (a.training_load != null) parts.push(`負荷 ${a.training_load}`);
  const watts = rawNumber(a, "icu_average_watts") ?? rawNumber(a, "average_watts");
  if (watts) parts.push(`功率 ${Math.round(watts)} W`);
  if (a.perceived_effort != null) parts.push(`體感 ${a.perceived_effort}`);
  return parts.join("、");
}

/** 計畫裡中、高強度的分鐘（單車的課與交叉訓練）；每段都很短（2 分鐘以內，衝刺）時 sprintOnly */
function plannedHardMinutes(session: PlannedSession, ctx: TargetContext): { minutes: number; sprintOnly: boolean } {
  let minutes = 0;
  let longest = 0;
  const add = (step: Step, times: number) => {
    const level = stepIntensity(step.target, session.kind);
    if (level !== "moderate" && level !== "high") return;
    const m = estimateSession({ ...session, steps: [step] }, ctx).minutes;
    minutes += m * times;
    longest = Math.max(longest, m);
  };
  for (const step of session.steps) {
    if (isRepeat(step)) for (const inner of step.steps) add(inner, step.repeat);
    else add(step, 1);
  }
  return { minutes, sprintOnly: minutes > 0 && longest <= 2 };
}

/**
 * 單車的課與交叉訓練（跑步以外、有目標的課）與實際的一趟：時間、強度（有功率時看功率區間的時間，
 * 沒有時看那項運動自己的心率區間的時間）與體感. 熱天與長時間騎乘的心率漂移放寬；肌力只看時間
 */
export function judgeOther(session: PlannedSession, a: OtherActivity, ctx: TargetContext): SessionResult {
  const planned = estimateSession(session, ctx).minutes;
  const minutes = a.duration_min ?? 0;
  const reasons: string[] = [];
  const ride = RIDE_KINDS.has(session.kind);
  const shortLimit = ride ? 0.8 : 0.7;
  const short = session.status !== "fallback" && planned > 0 && minutes < planned * shortLimit;
  if (short) reasons.push(`比計畫短（約 ${Math.round((minutes / planned) * 100)}%）`);
  if (session.kind === "strength") {
    return { outcome: short ? "partial" : "achieved", reasons, difficulty: null, actual: `${Math.round(minutes)} 分鐘`, workoutId: null, activityId: a.intervals_id };
  }

  // 改用替代時當成耐力騎（輕鬆）來看
  const kind: SessionKind = session.status === "fallback" ? (ride ? "ride_endurance" : "cross") : session.kind;
  const power = powerMinutes(a);
  const intensity = power ?? intensityMinutes(a, null);
  const difficulty = difficultyOf(kind, a.perceived_effort ?? null);
  const hardPlan = RIDE_QUALITY_KINDS.has(kind) || (kind === "cross" && isHardCross(session, ctx));
  const label = ride ? "耐力騎" : "輕鬆的有氧";
  let different = false;
  let weak = false;
  if (hardPlan) {
    const needed = plannedHardMinutes(session, ctx);
    // 衝刺這類很短的間歇心率跟不上：沒有功率時看體感
    if (intensity && needed.minutes > 0 && (power || !needed.sprintOnly)) {
      if (intensity.above < needed.minutes * 0.3) {
        different = true;
        reasons.push(`強度比計畫低，比較像${label}`);
      } else if (intensity.above < needed.minutes * 0.6) {
        weak = true;
        reasons.push("強度的時間比計畫少");
      }
    } else if (a.perceived_effort != null && a.perceived_effort <= 4) {
      different = true;
      reasons.push(`體感很輕鬆，比較像${label}`);
    }
  } else {
    // 熱天與長時間騎乘：心率會漂移，低強度的比例放寬到 60%（功率不受影響）
    const drift = !power && (minutes >= LONG_RIDE_DRIFT_MIN || (rawNumber(a, "average_temp") ?? 0) >= HOT_C);
    const need = drift ? 0.6 : 0.7;
    const total = intensity ? intensity.low + intensity.above : 0;
    const easyMax = ctx.sports?.[ride ? "ride" : (session.sport ?? "other")]?.hr?.easyMax ?? null;
    if (intensity && total > 0 && intensity.low / total < need) {
      different = true;
      reasons.push(`強度比計畫高（低強度只有 ${Math.round((intensity.low / total) * 100)}%${drift ? "，已放寬熱天或長時間的心率漂移" : ""}）`);
    } else if (!intensity && a.avg_hr != null && easyMax && a.avg_hr > easyMax + (drift ? 10 : 5)) {
      different = true;
      reasons.push(`平均心率 ${a.avg_hr} 高於輕鬆的上限 ${easyMax}`);
    } else if (!intensity && difficulty === "hard" && (a.perceived_effort ?? 0) >= 7) {
      different = true;
      reasons.push(`體感比${label}硬很多`);
    }
  }
  if (difficulty === "hard" && !different) reasons.push("體感比預期累");
  const outcome: Outcome = session.status === "fallback" ? "fallback" : different ? "different" : short || weak ? "partial" : "achieved";
  return { outcome, reasons, difficulty, actual: otherActualText(a), workoutId: null, activityId: a.intervals_id };
}

const isRunSession = (s: PlannedSession) => !NON_RUN_KINDS.has(s.kind);
/** 肌力的課配肌力訓練的類型；交叉訓練配其他的，寫了運動（sport）時只配那項運動 */
function fits(s: PlannedSession, o: OtherActivity): boolean {
  if (s.kind === "strength") return STRENGTH_TYPES.has(o.type);
  if (STRENGTH_TYPES.has(o.type)) return false;
  if (RIDE_KINDS.has(s.kind)) return sportOfType(o.type) === "ride";
  return !s.sport || s.sport === "other" || sportOfType(o.type) === s.sport;
}
/** 實際的一趟像不像強度課：中強度以上 15 分鐘以上，或體感 7 以上 */
function looksHard(w: Workout, ctx: TargetContext): boolean {
  const i = intensityMinutes(w, ctx.values.hr?.lthr ?? null);
  return i ? i.above >= 15 : (w.perceived_effort ?? 0) >= 7;
}

/**
 * 這週的配對：有日期的課配同一天的紀錄（一天兩堂時依時間最接近的），沒有日期的（彈性的菜單）
 * 依序配給剩下的紀錄中最合適的一項：強度相符優先，其次時間最接近。
 */
export function matchWeek(
  sessions: PlannedSession[],
  workouts: Workout[],
  others: OtherActivity[],
  weekStart: string,
  today: string,
  ctx: TargetContext,
): WeekMatch {
  const weekEnd = addDays(weekStart, 6);
  const runs = workouts.filter((w) => w.date >= weekStart && w.date <= weekEnd).sort((a, b) => a.date.localeCompare(b.date));
  const weekOthers = others.filter((a) => a.date >= weekStart && a.date <= weekEnd);
  const usedRuns = new Set<number>();
  const usedOthers = new Set<string>();
  const results = new Map<number, SessionResult>();
  const planned = (s: PlannedSession) => estimateSession(s, ctx).minutes;

  const closest = <T>(items: T[], minutes: (x: T) => number, target: number) =>
    [...items].sort((a, b) => Math.abs(minutes(a) - target) - Math.abs(minutes(b) - target))[0];

  // 有日期的課
  for (const s of sessions.filter((x) => x.date && x.status !== "skipped")) {
    if (s.kind === "rest") continue;
    if (isRunSession(s)) {
      const w = closest(runs.filter((r) => r.date === s.date && !usedRuns.has(r.id)), (r) => r.duration_min ?? 0, planned(s));
      if (w) {
        usedRuns.add(w.id);
        results.set(s.id, judgeRun(s, w, ctx));
      }
    } else {
      const a = closest(
        weekOthers.filter((o) => o.date === s.date && !usedOthers.has(o.intervals_id) && fits(s, o)),
        (o) => o.duration_min ?? 0,
        planned(s),
      );
      if (a) {
        usedOthers.add(a.intervals_id);
        results.set(s.id, judgeOther(s, a, ctx));
      }
    }
  }

  // 沒有日期的課（彈性的菜單）：依日期順序，每一趟配給最合適的一項
  const open = sessions.filter((x) => !x.date && x.status !== "skipped" && isRunSession(x));
  for (const w of runs) {
    if (usedRuns.has(w.id)) continue;
    const candidates = open.filter((s) => !results.has(s.id));
    if (!candidates.length) break;
    const hard = looksHard(w, ctx);
    const fitting = candidates.filter((s) => QUALITY_KINDS.has(s.kind) === hard);
    const s = closest(fitting.length ? fitting : candidates, planned, w.duration_min ?? 0)!;
    usedRuns.add(w.id);
    results.set(s.id, judgeRun(s, w, ctx));
  }
  // 彈性的騎車與交叉訓練：強度相符的優先，其次時間最接近
  for (const s of sessions.filter((x) => !x.date && x.status !== "skipped" && !isRunSession(x) && x.kind !== "rest")) {
    const candidates = weekOthers.filter((o) => !usedOthers.has(o.intervals_id) && fits(s, o));
    const hard = isQualityKind(s.kind) || isHardCross(s, ctx);
    const fitting = candidates.filter((o) => isHardOther(o) === hard);
    const a = closest(fitting.length ? fitting : candidates, (o) => o.duration_min ?? 0, planned(s));
    if (a) {
      usedOthers.add(a.intervals_id);
      results.set(s.id, judgeOther(s, a, ctx));
    }
  }

  // 沒配到的課
  for (const s of sessions) {
    if (results.has(s.id)) continue;
    if (s.status === "skipped") results.set(s.id, { outcome: "skipped", reasons: [], difficulty: null, actual: null, workoutId: null });
    // 選手在 App 裡回報做完了（肌力等沒有手錶紀錄的課，規格 12.24）
    else if (s.done_at) results.set(s.id, { outcome: "achieved", reasons: [], difficulty: null, actual: "選手回報做完了", workoutId: null });
    else if (s.kind === "rest") {
      const ran = s.date ? runs.find((r) => r.date === s.date && !usedRuns.has(r.id)) : undefined;
      if (s.date && s.date <= today) {
        results.set(s.id, ran ? { outcome: "not_rested", reasons: [], difficulty: null, actual: actualText(ran), workoutId: ran.id } : { outcome: "rested", reasons: [], difficulty: null, actual: null, workoutId: null });
        if (ran) usedRuns.add(ran.id);
      } else results.set(s.id, { outcome: "pending", reasons: [], difficulty: null, actual: null, workoutId: null });
    } else if (s.date && s.date < today) {
      results.set(s.id, { outcome: "missed", reasons: ["跳過即可，不要補"], difficulty: null, actual: null, workoutId: null });
    } else {
      results.set(s.id, { outcome: "pending", reasons: [], difficulty: null, actual: null, workoutId: null });
    }
  }

  return {
    results,
    extraRuns: runs.filter((w) => !usedRuns.has(w.id)),
    extraOthers: weekOthers.filter((o) => !usedOthers.has(o.intervals_id)),
  };
}

/**
 * 依最近強度課的結果調整配速（規格 12.8 的決定）：部分達成或體感太難，退一級（VDOT −1，最多 −2）；
 * 達成且不覺得難，回升 0.5。只會放慢，不會超過由成績推算的 VDOT：要變快，靠新的成績。
 * 跑成輕鬆跑（跑了不一樣的課）不算：可能是選手自己決定的，不是做不到。
 */
export function paceAdjustment(results: { kind: SessionKind; date: string; result: SessionResult }[]): { penalty: number; reason: string | null } {
  let penalty = 0;
  let reason: string | null = null;
  for (const { kind, date, result } of [...results].sort((a, b) => a.date.localeCompare(b.date))) {
    if (!QUALITY_KINDS.has(kind)) continue;
    const failed = result.outcome === "partial" || result.difficulty === "hard";
    if (failed) {
      penalty = Math.min(2, penalty + 1);
      reason = `${date.slice(5)} 的強度課${result.difficulty === "hard" ? "體感偏難" : OUTCOME_LABELS[result.outcome]}`;
    } else if (result.outcome === "achieved") {
      penalty = Math.max(0, penalty - 0.5);
    }
  }
  return { penalty, reason: penalty > 0 ? reason : null };
}

/** 依結果調整配速時看最近幾天的強度課 */
const ADJUST_LOOKBACK_DAYS = 21;

/** 最近三週課表上的強度課結果 → 配速的調整；沒有結構化課表時為 0 */
export async function recentAdjustment(
  db: Db,
  today: string,
  ctx: TargetContext,
  workouts: Workout[],
  others: OtherActivity[],
): Promise<{ penalty: number; reason: string | null }> {
  const since = addDays(today, -ADJUST_LOOKBACK_DAYS);
  const plans = await db.getWeeklyPlansSince(addDays(since, -6));
  const results: { kind: SessionKind; date: string; result: SessionResult }[] = [];
  for (const plan of plans) {
    const sessions = await db.getPlannedSessions(plan.id);
    const match = matchWeek(sessions, workouts, others, plan.week_start!, today, ctx);
    for (const s of sessions) {
      const result = match.results.get(s.id);
      const done = workouts.find((w) => w.id === result?.workoutId);
      const date = s.date ?? done?.date;
      if (result && date && date >= since && date <= today) results.push({ kind: s.kind, date, result });
    }
  }
  return paceAdjustment(results);
}
