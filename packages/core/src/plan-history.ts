/**
 * 過去幾週的課表與達成（規格 12.34 第 1、2 點）：課表頁的「之前的週」與教練看到的最近 4 週摘要.
 * 結果和這週一樣用比對算（matchWeek），不另存；過去的週課表已停用但資料還在.
 */
import { addDays, daysBetween, isoWeekStart, weekdayIndex, weekdayName } from "./dates";
import type { Db } from "./db";
import { SESSION_KINDS, sessionView, sortSessions, type SessionKind } from "./plan";
import { matchWeek, type Difficulty, type Outcome } from "./plan-match";
import { monthDay, weekRange } from "./plan-timeline";
import { contextFor } from "./planning";
import type { Sport, TrainingPlan } from "./types";

/** 選手在計畫頁按的調整（跳過、改用替代…）寫在課的備註；教練用工具調整的原因是別的字 */
export const ATHLETE_ADJUST_NOTE = "選手在計畫頁調整";

/** 「之前的週」先列幾週，再看更早的時每次多幾週 */
export const PAST_WEEKS_PAGE = 8;

/** 教練看的摘要涵蓋幾週 */
export const ADHERENCE_WEEKS = 4;

export interface PastSession {
  id: number;
  date: string | null;
  kind: SessionKind;
  kindLabel: string;
  title: string;
  isRun: boolean;
  sport: Sport | null;
  /** 週已經過完：沒配到的都是 missed，不會是 pending */
  outcome: Exclude<Outcome, "pending">;
  reasons: string[];
  difficulty: Difficulty | null;
  actual: string | null;
  /** 配到的跑步（紀錄頁那一趟）；其他運動是 activityId */
  workoutId: number | null;
  activityId: string | null;
  /** 跳過、改用替代是選手自己在計畫頁按的 */
  byAthlete: boolean;
}

export interface PastWeek {
  weekStart: string;
  /** 例：10/19 – 10/25 */
  range: string;
  /** 舊的文字課表：沒有一堂一堂的課，只有實際的總量 */
  text: boolean;
  sessions: PastSession[];
  /** 計畫的總量（不含跳過的）；文字課表是 null */
  planned: { km: number; minutes: number } | null;
  /** 這週實際的總量：跑步（多運動開著時加上其他運動） */
  actual: { km: number; minutes: number; runs: number; others: number };
  /** 只有跑步的週寫距離，有其他運動時寫時間 */
  unit: "km" | "time";
}

interface Candidate {
  weekStart: string;
  plan: TrainingPlan;
  text: boolean;
}

const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));
const round1 = (x: number) => Math.round(x * 10) / 10;

/** 週一在 [since, before) 之間、有課表的週，新的在前；結構化的課表優先於同一週的文字課表 */
async function candidates(db: Db, since: string, before: string, exclude: string | null): Promise<Candidate[]> {
  const [structured, texts] = await Promise.all([db.getWeeklyPlansSince(since), db.getTextPlans()]);
  const byWeek = new Map<string, Candidate>();
  for (const plan of texts) {
    const weekStart = isoWeekStart(plan.week_label);
    if (weekStart) byWeek.set(weekStart, { weekStart, plan, text: true });
  }
  for (const plan of structured) byWeek.set(plan.week_start!, { weekStart: plan.week_start!, plan, text: false });
  return [...byWeek.values()]
    .filter((c) => c.weekStart >= since && c.weekStart < before && c.weekStart !== exclude)
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart));
}

async function buildWeeks(db: Db, today: string, list: Candidate[], multisport: boolean): Promise<PastWeek[]> {
  if (!list.length) return [];
  const oldest = list.at(-1)!.weekStart;
  const days = daysBetween(oldest, today) + 1;
  const [base, workouts, others] = await Promise.all([
    contextFor(db, today, mondayOf(today), "fixed"),
    db.getRecentWorkouts(days),
    multisport ? db.getOtherActivities(days) : Promise.resolve([]),
  ]);
  // 目標與判斷用現在的訓練數值（和紀錄頁的標示一樣），紀錄換成涵蓋到最舊那週的
  const ctx = { ...base, workouts, others };
  const weeks: PastWeek[] = [];
  for (const c of list) {
    const end = addDays(c.weekStart, 6);
    const runs = workouts.filter((w) => w.date >= c.weekStart && w.date <= end);
    const weekOthers = others.filter((a) => a.date >= c.weekStart && a.date <= end);
    const actual = {
      km: round1(runs.reduce((sum, w) => sum + (w.distance_km ?? 0), 0)),
      minutes: Math.round([...runs, ...weekOthers].reduce((sum, w) => sum + (w.duration_min ?? 0), 0)),
      runs: runs.length,
      others: weekOthers.length,
    };
    if (c.text) {
      weeks.push({ weekStart: c.weekStart, range: weekRange(c.weekStart), text: true, sessions: [], planned: null, actual, unit: weekOthers.length ? "time" : "km" });
      continue;
    }
    const planned = await db.getPlannedSessions(c.plan.id);
    const match = matchWeek(planned, workouts, others, c.weekStart, today, ctx);
    const sessions: PastSession[] = [];
    let km = 0;
    let minutes = 0;
    for (const s of sortSessions(planned)) {
      if (s.kind === "rest") continue;
      const v = sessionView(s, ctx);
      // 多運動關著時只列跑步的課（和這週的時間軸一樣只看跑步）
      if (!multisport && !v.isRun) continue;
      const r = match.results.get(s.id);
      if (s.status !== "skipped") {
        km += v.isRun ? v.km : 0;
        minutes += v.minutes;
      }
      const outcome = !r || r.outcome === "pending" ? "missed" : r.outcome;
      sessions.push({
        id: s.id,
        date: s.date,
        kind: s.kind,
        kindLabel: v.kindLabel,
        title: s.title,
        isRun: v.isRun,
        sport: v.sport,
        outcome,
        reasons: outcome === "missed" ? [] : (r?.reasons ?? []),
        difficulty: r?.difficulty ?? null,
        actual: r?.actual ?? null,
        workoutId: r?.workoutId ?? null,
        activityId: r?.activityId ?? null,
        byAthlete: s.status !== "planned" && s.note === ATHLETE_ADJUST_NOTE,
      });
    }
    const onlyRuns = sessions.every((s) => s.isRun) && !weekOthers.length;
    weeks.push({
      weekStart: c.weekStart,
      range: weekRange(c.weekStart),
      text: false,
      sessions,
      planned: { km: round1(km), minutes: Math.round(minutes) },
      actual,
      unit: onlyRuns ? "km" : "time",
    });
  }
  return weeks;
}

/** 這週的時間軸已經顯示的週（目前啟用的課表）：「之前的週」不重複列 */
async function shownWeek(db: Db): Promise<string | null> {
  const active = await db.getActiveTrainingPlan();
  if (!active) return null;
  return active.week_start ?? isoWeekStart(active.week_label);
}

/**
 * 課表頁的「之前的週」：今天以前的週（不含這週與時間軸上顯示的那週），只列有課表的，新的在前.
 * limit 週以後還有更早的時 more 為 true
 */
export async function pastPlanWeeks(
  db: Db,
  today: string,
  options: { limit?: number; multisport?: boolean } = {},
): Promise<{ weeks: PastWeek[]; more: boolean }> {
  const limit = options.limit ?? PAST_WEEKS_PAGE;
  const list = await candidates(db, "0000-01-01", mondayOf(today), await shownWeek(db));
  const weeks = await buildWeeks(db, today, list.slice(0, limit), !!options.multisport);
  return { weeks, more: list.length > limit };
}

/** 摘要裡結果的順序與說法 */
const SUMMARY_OUTCOMES: [Outcome, string][] = [
  ["achieved", "做了"],
  ["partial", "部分"],
  ["different", "做了不一樣的課"],
  ["fallback", "改用替代"],
  ["skipped", "跳過"],
  ["missed", "沒做"],
];
const NOT_DONE: ReadonlySet<Outcome> = new Set(["skipped", "missed"]);

function countText(items: PastSession[]): string {
  return SUMMARY_OUTCOMES.map(([o, label]) => [label, items.filter((s) => s.outcome === o).length] as const)
    .filter(([, n]) => n > 0)
    .map(([label, n]) => `${label} ${n}`)
    .join("、");
}

/**
 * 教練看的最近 4 週照課表做得怎樣（weeks 是那幾週，新舊都可以）. 沒有一堂一堂的課表時為 null.
 * 例：
 * 【最近 4 週照課表的情形】（9/28 – 10/25，程式依手錶紀錄比對；4 週都有課表）
 * ・T 閾值 4 堂：做了 3、跳過 1
 * ・週三的課：排了 4 次，沒做到 3 次（跳過 1、沒做 2）
 */
export function adherenceText(weeks: PastWeek[], from: string, to: string, weekCount = ADHERENCE_WEEKS): string | null {
  const structured = weeks.filter((w) => !w.text);
  if (!structured.length) return null;
  const texts = weeks.length - structured.length;
  const sessions = structured.flatMap((w) => w.sessions);
  const coverage =
    structured.length === weekCount ? `${weekCount} 週都有課表` : `${weekCount} 週裡 ${structured.length} 週有一堂一堂的課表`;
  const lines = [
    `【最近 ${weekCount} 週照課表的情形】（${monthDay(from)} – ${monthDay(to)}，程式依手錶紀錄比對；${coverage}` +
      `${texts ? `、${texts} 週是文字課表（沒有比對）` : ""}）`,
  ];
  if (!sessions.length) {
    lines.push("・課表上沒有要練的課");
    return lines.join("\n");
  }

  // 各種課：依種類在 SESSION_KINDS 的順序
  const kinds = (Object.keys(SESSION_KINDS) as SessionKind[]).filter((k) => sessions.some((s) => s.kind === k));
  for (const kind of kinds) {
    const items = sessions.filter((s) => s.kind === kind);
    lines.push(`・${SESSION_KINDS[kind]} ${items.length} 堂：${countText(items)}`);
  }

  // 同一個星期幾沒做到兩次以上
  for (let day = 0; day < 7; day++) {
    const items = sessions.filter((s) => s.date && weekdayIndex(s.date) === day);
    const missed = items.filter((s) => NOT_DONE.has(s.outcome));
    if (missed.length < 2) continue;
    const name = weekdayName(addDays(from, day)).replace("星期", "週");
    const weeksWith = new Set(items.map((s) => mondayOf(s.date!))).size;
    lines.push(`・${name}的課：${weeksWith} 週排了 ${items.length} 次，沒做到 ${missed.length} 次（${countText(missed)}）`);
  }

  // 選手自己在計畫頁按的
  const self = sessions.filter((s) => s.byAthlete);
  const selfSkipped = self.filter((s) => s.outcome === "skipped").length;
  const selfFallback = self.filter((s) => s.outcome === "fallback").length;
  if (selfSkipped || selfFallback) {
    lines.push(`・選手自己在課表頁${[selfSkipped && `跳過 ${selfSkipped} 次`, selfFallback && `改用替代 ${selfFallback} 次`].filter(Boolean).join("、")}`);
  }
  return lines.join("\n");
}

/** 最近 4 週（這週以前的 4 個整週）的摘要；給教練的系統提示（會變的那一段） */
export async function recentAdherence(db: Db, today: string, options: { multisport?: boolean } = {}): Promise<string | null> {
  const thisMonday = mondayOf(today);
  const from = addDays(thisMonday, -7 * ADHERENCE_WEEKS);
  const list = await candidates(db, from, thisMonday, null);
  if (!list.some((c) => !c.text)) return null;
  const weeks = await buildWeeks(db, today, list, !!options.multisport);
  return adherenceText(weeks, from, addDays(thisMonday, -1));
}
