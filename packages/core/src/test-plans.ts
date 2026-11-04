/**
 * 測試模式：塞進過去幾週的課表（staging 試用的回饋，規格 12.38），讓「之前的週」與教練的最近 4 週摘要試得到.
 *
 * 課照測試資料庫裡那週實際的跑步排（每一趟一堂課），每週換一種情況：照課表、部分達成、跳過、改用替代、沒做、
 * 自己改短或換成輕鬆（附原因）. 結果和真的課表一樣由比對算，不另外寫.
 * 這些課表不啟用（不影響這週的課表），reason 是 TEST_PLAN_REASON，清掉時用它找；只寫進測試模式的資料庫.
 */
import { addDays, isoWeekLabel, weekdayIndex } from "./dates";
import type { Db } from "./db";
import { easyVersion, estimateSession, shortenSteps, type SelfChange, type SelfChangeReason, type SessionDraft } from "./plan";
import { ATHLETE_ADJUST_NOTE } from "./plan-history";
import { contextFor } from "./planning";
import type { Workout } from "./types";

/** 測試模式塞進的課表的標記（training_plans.reason） */
export const TEST_PLAN_REASON = "（測試模式塞進的過去課表）";

/** 可以選幾週 */
export const TEST_PLAN_WEEKS = { min: 2, max: 8 } as const;

type Draft = SessionDraft & { workout: Workout | null };

/** 每週的情況，依「幾週前」輪流 */
const VARIANTS = ["as_planned", "partial_skip", "fallback_tired", "easy_time", "unwell"] as const;
type Variant = (typeof VARIANTS)[number];

const easy = (date: string, minutes: number, workout: Workout | null): Draft => ({
  date,
  kind: "easy",
  title: "輕鬆跑",
  steps: [{ duration_min: Math.max(20, Math.round(minutes)), target: { hr: "easy" } }],
  purpose: "有氧基礎",
  success: "輕鬆到能說完整的句子",
  fallback: null,
  workout,
});

const threshold = (date: string, workout: Workout | null): Draft => ({
  date,
  kind: "threshold",
  title: "20 分鐘閾值",
  steps: [
    { duration_min: 15, target: { hr: "easy" } },
    { duration_min: 20, target: { pace: "T" } },
    { duration_min: 10, target: { hr: "easy" } },
  ],
  purpose: "提高閾值",
  success: "配速在範圍內",
  fallback: "改成 40 分鐘輕鬆跑",
  workout,
});

const long = (date: string, km: number, workout: Workout | null): Draft => ({
  date,
  kind: "long",
  title: "長跑",
  steps: [{ distance_km: Math.max(8, Math.round(km)), target: { pace: "E" } }],
  purpose: "耐力",
  success: "後半段配速不掉",
  fallback: null,
  workout,
});

/** 那週的課：每一趟跑步一堂（最長的是長跑、三趟以上時最快的那趟是閾值），沒有跑步時照週二、週四、週日排 */
function weekSessions(weekStart: string, runs: Workout[]): Draft[] {
  if (!runs.length) return [easy(addDays(weekStart, 1), 45, null), threshold(addDays(weekStart, 3), null), long(addDays(weekStart, 6), 16, null)];
  const longest = runs.length >= 2 ? runs.reduce((a, b) => ((b.distance_km ?? 0) > (a.distance_km ?? 0) ? b : a)) : null;
  const rest = runs.filter((w) => w !== longest);
  const pace = (w: Workout) => (w.duration_min ?? 0) / Math.max(0.1, w.distance_km ?? 0);
  const fastest = runs.length >= 3 ? rest.reduce((a, b) => (pace(b) < pace(a) ? b : a)) : null;
  return runs.map((w) => (w === longest ? long(w.date, w.distance_km ?? 16, w) : w === fastest ? threshold(w.date, w) : easy(w.date, w.duration_min ?? 45, w)));
}

/** 這週沒有排課的一天（加一堂會沒做或跳過的課）；每天都有課時是 null */
function freeDay(weekStart: string, sessions: Draft[]): string | null {
  for (const i of [2, 4, 0, 5, 1, 3, 6]) {
    const date = addDays(weekStart, i);
    if (!sessions.some((s) => s.date === date)) return date;
  }
  return null;
}

interface Plan {
  sessions: Draft[];
  status: Map<number, "skipped" | "fallback">;
  self: { index: number; action: "shorten" | "easy"; ratio: number | null; reason: SelfChangeReason } | null;
}

function planFor(weekStart: string, runs: Workout[], variant: Variant): Plan {
  const sessions = weekSessions(weekStart, runs);
  const status = new Map<number, "skipped" | "fallback">();
  let self: Plan["self"] = null;
  const longAt = sessions.findIndex((s) => s.kind === "long");
  const free = freeDay(weekStart, sessions);
  const addFree = () => (free ? sessions.push(easy(free, 40, null)) - 1 : -1);
  switch (variant) {
    case "as_planned":
      // 照課表跑，多一堂沒做的
      addFree();
      break;
    case "partial_skip": {
      // 長跑排得比實際長（部分達成），一堂跳過
      if (longAt >= 0) sessions[longAt] = long(sessions[longAt]!.date!, (sessions[longAt]!.workout?.distance_km ?? 16) * 1.4, sessions[longAt]!.workout);
      const i = addFree();
      if (i >= 0) status.set(i, "skipped");
      break;
    }
    case "fallback_tired": {
      // 強度課改用替代；長跑自己改短到約 3/4（太累）
      const q = sessions.findIndex((s) => s.kind === "threshold");
      if (q >= 0) status.set(q, "fallback");
      if (longAt >= 0) self = { index: longAt, action: "shorten", ratio: 0.75, reason: "tired" };
      break;
    }
    case "easy_time": {
      // 強度課（沒有時長跑）自己換成輕鬆（沒時間），多一堂沒做的
      const q = sessions.findIndex((s) => s.kind === "threshold");
      const at = q >= 0 ? q : longAt;
      if (at >= 0) self = { index: at, action: "easy", ratio: null, reason: "time" };
      addFree();
      break;
    }
    case "unwell": {
      // 長跑自己改一半（不舒服），一堂跳過
      if (longAt >= 0) self = { index: longAt, action: "shorten", ratio: 0.5, reason: "unwell" };
      const i = addFree();
      if (i >= 0) status.set(i, "skipped");
      break;
    }
  }
  return { sessions, status, self };
}

/**
 * 塞進今天以前 weeks 週的課表（先清掉之前塞的）；回傳塞了幾週、幾堂課.
 * 只在測試模式的資料庫用：呼叫的地方要確認是測試模式
 */
export async function seedPastPlans(db: Db, today: string, weeks: number): Promise<{ weeks: number; sessions: number }> {
  const n = Math.min(TEST_PLAN_WEEKS.max, Math.max(TEST_PLAN_WEEKS.min, Math.round(weeks)));
  await db.deletePlansByReason(TEST_PLAN_REASON);
  const monday = addDays(today, -weekdayIndex(today));
  const oldest = addDays(monday, -7 * n);
  const workouts = (await db.getRecentWorkouts(Math.max(1, Math.round((Date.parse(today) - Date.parse(oldest)) / 86_400_000) + 1))).filter((w) => w.date >= oldest && w.date < monday);
  let count = 0;
  for (let k = n; k >= 1; k--) {
    const weekStart = addDays(monday, -7 * k);
    const end = addDays(weekStart, 6);
    // 一天一趟（同一天有好幾趟時取最長的）
    const byDay = new Map<string, Workout>();
    for (const w of workouts.filter((x) => x.date >= weekStart && x.date <= end)) {
      const prev = byDay.get(w.date);
      if (!prev || (w.distance_km ?? 0) > (prev.distance_km ?? 0)) byDay.set(w.date, w);
    }
    const runs = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date));
    const variant = VARIANTS[(k - 1) % VARIANTS.length]!;
    const { sessions, status, self } = planFor(weekStart, runs, variant);
    // 自己改課：存的是原本的課（改短的原本是實際的 1/ratio，改完和實際差不多），之後換成改過的
    const ctx = self ? await contextFor(db, today, weekStart, "fixed") : null;
    if (self && self.action === "shorten") {
      const s = sessions[self.index]!;
      sessions[self.index] = long(s.date!, (s.workout?.distance_km ?? 12) / self.ratio!, s.workout);
    }
    const drafts: SessionDraft[] = sessions.map(({ workout: _w, ...d }) => d);
    const planId = await db.insertPastPlan(
      { weekLabel: isoWeekLabel(weekStart), weekStart, reason: TEST_PLAN_REASON, content: `${TEST_PLAN_REASON}${variantText(variant)}` },
      drafts,
    );
    const saved = await db.getPlannedSessions(planId);
    for (const [i, st] of status) await db.updatePlannedSession(saved[i]!.id, { status: st, note: ATHLETE_ADJUST_NOTE });
    if (self && ctx) {
      const { date, ...original } = drafts[self.index]!;
      const estimate = estimateSession({ ...original, date }, ctx);
      const draft = self.action === "shorten" ? { ...original, steps: shortenSteps(original, self.ratio!) } : easyVersion(original, Math.round(estimate.minutes));
      const change: SelfChange = {
        action: self.action,
        ratio: self.ratio,
        reason: self.reason,
        at: new Date().toISOString(),
        original,
        minutes: Math.round(estimate.minutes),
        km: Math.round(estimate.km * 10) / 10,
      };
      await db.applySelfChange(saved[self.index]!.id, draft, change);
    }
    count += drafts.length;
  }
  return { weeks: n, sessions: count };
}

function variantText(v: Variant): string {
  return {
    as_planned: "：照課表，一堂沒做",
    partial_skip: "：長跑部分達成，一堂跳過",
    fallback_tired: "：強度課改用替代，長跑自己改短（太累）",
    easy_time: "：自己換成輕鬆（沒時間），一堂沒做",
    unwell: "：長跑自己改一半（不舒服），一堂跳過",
  }[v];
}

/** 清掉測試模式塞進的課表；回傳清了幾週 */
export function clearPastPlans(db: Db): Promise<number> {
  return db.deletePlansByReason(TEST_PLAN_REASON);
}
