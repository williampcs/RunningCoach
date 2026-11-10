/**
 * 自動檢查的規則（不用 AI 判斷，只是底線；品質由使用者看）.
 * 每個情境組合這些規則；所有情境另外都套 COMMON_CHECKS.
 */
import { QUALITY_KINDS, RIDE_QUALITY_KINDS } from "../../packages/core/src/plan";

import type { Check, CheckResult, RunRecord, Scenario, SessionSnapshot } from "./types";

/** 簡體專用的常見字（繁體不用）；出現太多就不是繁體中文 */
const SIMPLIFIED_ONLY = "这们么来时为说会过还对没关现发开问题练课动让给应经点头见计请吗边进当样种实从总认识则带门马东车长气语书买卖难脑热饮药医样习惯检测压级运" as const;

/** 回覆裡簡體專用字的個數 */
export function simplifiedCount(text: string): number {
  let n = 0;
  for (const ch of text) if (SIMPLIFIED_ONLY.includes(ch)) n++;
  return n;
}

/** 這次新存或改過的課 */
export function touchedSessions(r: RunRecord): SessionSnapshot[] {
  return [...r.saved.newSessions, ...r.saved.editedSessions];
}

const HARD = new Set<string>([...QUALITY_KINDS, ...RIDE_QUALITY_KINDS, "long", "race", "ride_long"]);
/** 強度課、長課或比賽 */
export const isHardOrLong = (s: SessionSnapshot) => HARD.has(s.kind);
const isQuality = (s: SessionSnapshot) => QUALITY_KINDS.has(s.kind as never) || RIDE_QUALITY_KINDS.has(s.kind as never);

/**
 * 目標裡有沒有要量心率的（心率區間 {zone}）. {"hr":"easy"} 不算：量不到心率時程式換成配速與說話測試（規格 12.36）
 */
export function usesHeartRate(steps: unknown[]): boolean {
  return steps.some((raw) => {
    const step = raw as { steps?: unknown[]; target?: Record<string, unknown> };
    if (Array.isArray(step.steps)) return usesHeartRate(step.steps);
    return !!step.target && ("zone" in step.target || ("hr" in step.target && step.target.hr !== "easy"));
  });
}

export const replyMatches =
  (id: string, label: string, pattern: RegExp, options: { within?: number; review?: boolean } = {}): Check => ({
    id,
    label,
    review: options.review,
    test: (r) => pattern.test(options.within ? r.reply.slice(0, options.within) : r.reply),
  });

export const replyNotMatches = (id: string, label: string, pattern: RegExp, options: { review?: boolean } = {}): Check => ({
  id,
  label,
  review: options.review,
  test: (r) => {
    const m = pattern.exec(r.reply);
    return m ? { pass: false, detail: `出現「${m[0]}」` } : true;
  },
});

export const planSaved: Check = {
  id: "plan-saved",
  label: "存了課表",
  test: (r) => r.saved.newSessions.length > 0,
};

export const noAcceptedWarnings: Check = {
  id: "no-accept",
  label: "沒有用 accept_warnings 硬存",
  test: (r) => !r.saved.acceptedWarnings,
};

export const noPlanSaved: Check = {
  id: "no-plan",
  label: "沒有存或改課表",
  test: (r) => touchedSessions(r).length === 0,
};

export const noHardSessions: Check = {
  id: "no-hard",
  label: "沒有存或改成強度課、長課",
  test: (r) => {
    const hard = touchedSessions(r).filter(isHardOrLong);
    return hard.length ? { pass: false, detail: hard.map((s) => `${s.date ?? ""} ${s.title}`).join("、") } : true;
  },
};

export const noQualitySessions: Check = {
  id: "no-quality",
  label: "沒有存或改成強度課",
  test: (r) => {
    const hard = touchedSessions(r).filter(isQuality);
    return hard.length ? { pass: false, detail: hard.map((s) => `${s.date ?? ""} ${s.title}`).join("、") } : true;
  },
};

export const maxSessionKm = (km: number): Check => ({
  id: `max-${km}km`,
  label: `沒有存單趟 ${km} km 以上的課`,
  test: (r) => {
    const long = touchedSessions(r).filter((s) => s.km >= km);
    return long.length ? { pass: false, detail: long.map((s) => `${s.title}（約 ${s.km} km）`).join("、") } : true;
  },
});

export const noHeartRateTargets: Check = {
  id: "no-hr",
  label: "課表的目標沒有心率區間（輕鬆的 hr easy 可以）",
  test: (r) => {
    const hr = r.saved.newSessions.filter((s) => usesHeartRate(s.steps));
    return hr.length ? { pass: false, detail: hr.map((s) => s.title).join("、") } : true;
  },
};

export const noWrites: Check = {
  id: "no-writes",
  label: "沒有寫入（課表、傷病、選手資料）",
  test: (r) => {
    const writes = r.toolCalls.filter((c) => !c.failed && /^(save_training_plan|edit_planned_session|update_planned_session|record_injury|update_injury|update_athlete_profile)$/.test(c.name));
    return writes.length ? { pass: false, detail: writes.map((c) => c.name).join("、") } : true;
  },
};

export const toolCalled = (names: string[], label: string): Check => ({
  id: `tool-${names.join("-")}`,
  label,
  test: (r) => r.toolCalls.some((c) => names.includes(c.name) && !c.failed),
});

/** 所有情境都檢查 */
export const COMMON_CHECKS: Check[] = [
  {
    id: "finished",
    label: "有回覆（沒有錯誤、拒絕或截斷）",
    test: (r) => (r.finish === "ok" && r.reply.trim().length > 0 ? true : { pass: false, detail: r.error ?? r.finish }),
  },
  {
    id: "zh-tw",
    label: "繁體中文",
    test: (r) => {
      const n = simplifiedCount(r.reply);
      return n <= 2 ? true : { pass: false, detail: `簡體專用字 ${n} 個` };
    },
  },
];

/** 套用一個情境的檢查（含共同的）；規則本身出錯時算不過 */
export function runChecks(scenario: Scenario, record: RunRecord): CheckResult[] {
  return [...COMMON_CHECKS, ...scenario.checks].map((check) => {
    try {
      const out = check.test(record);
      const { pass, detail } = typeof out === "boolean" ? { pass: out, detail: undefined } : out;
      return { id: check.id, label: check.label, pass, review: check.review, detail };
    } catch (e) {
      return { id: check.id, label: check.label, pass: false, detail: `規則出錯：${e instanceof Error ? e.message : String(e)}` };
    }
  });
}
