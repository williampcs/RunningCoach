/**
 * 課表頁的時間軸（規格 12.22 的 B 版）：從今天往後排到課表的最後一天（含先排好的下週），
 * 這週今天以前的收成「這週稍早」，快到的賽事排在它的日期或接在最後面.
 */
import { addDays, daysBetween, weekdayIndex } from "./dates";
import type { ActivePlan } from "./planning";
import { raceOutcome } from "./races";
import type { Race } from "./types";

export type TimelineSession = ActivePlan["sessions"][number] & {
  /** 這堂課所在那週的星期一：移到別天只能在同一週 */
  weekStart: string;
  /** 固定的課表（照星期排）才能移到別天 */
  fixed: boolean;
};

export interface TimelineWeek {
  /** 例：10/26 – 11/1 */
  range: string;
  km: number;
  runs: number;
}

export interface TimelineDay {
  date: string;
  /** 今天、明天，其他寫 m/d */
  label: string;
  /** 星期幾的一個字，例：四 */
  weekday: string;
  sessions: TimelineSession[];
  races: Race[];
  /** 下一份課表從這天開始：前面加一條分隔（下週的範圍與總量） */
  nextWeek: TimelineWeek | null;
}

export interface PlanTimeline {
  week: TimelineWeek;
  /** 今天在這份課表的那週裡（課表的週已經過了就是 false） */
  thisWeek: boolean;
  /** 這週今天以前的課（有比對的結果） */
  earlier: TimelineSession[];
  /** 彈性的課表（菜單）沒有日期的課 */
  undated: TimelineSession[];
  days: TimelineDay[];
  /** 放大的那一堂：今天的課，今天沒課時是下一堂 */
  focus: TimelineSession | null;
  /** 課表範圍外、最近的一兩場賽事 */
  laterRaces: Race[];
}

const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];
/** 課表範圍外的賽事：只放這幾天內的（最多兩場）；一場都沒有時放最近的一場 */
export const LATER_RACE_DAYS = 60;

/** 月/日，不補零（例：10/27、11/1） */
export const monthDay = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;
export const weekRange = (weekStart: string) => `${monthDay(weekStart)} – ${monthDay(addDays(weekStart, 6))}`;

function dayLabel(date: string, today: string): string {
  const diff = daysBetween(today, date);
  return diff === 0 ? "今天" : diff === 1 ? "明天" : monthDay(date);
}

const isRest = (s: TimelineSession) => s.kind === "rest";

export function planTimeline(current: ActivePlan, next: ActivePlan | null, races: Race[], today: string): PlanTimeline | null {
  const start = current.plan.week_start;
  if (!start) return null;
  const tag = (plan: ActivePlan) =>
    plan.sessions.map((s): TimelineSession => ({ ...s, weekStart: plan.plan.week_start!, fixed: plan.plan.style !== "flexible" }));
  const plans = [current, ...(next?.plan.week_start ? [next] : [])];
  const sessions = plans.flatMap(tag);
  const end = addDays(plans.at(-1)!.plan.week_start!, 6);
  const first = today > start ? today : start;

  const upcoming = races.filter((r) => raceOutcome(r) === null && r.date >= first).sort((a, b) => a.date.localeCompare(b.date));
  const flexibleWeeks = new Set(plans.filter((p) => p.plan.style === "flexible").map((p) => p.plan.week_start!));
  const weekOf = (date: string) => addDays(date, -weekdayIndex(date));

  const days: TimelineDay[] = [];
  for (let date = first; date <= end; date = addDays(date, 1)) {
    const day: TimelineDay = {
      date,
      label: dayLabel(date, today),
      weekday: WEEKDAY_SHORT[weekdayIndex(date)]!,
      sessions: sessions.filter((s) => s.date === date),
      races: upcoming.filter((r) => r.date === date),
      nextWeek:
        next?.plan.week_start === date && date !== first ? { range: weekRange(date), km: next.totalKm, runs: next.runCount } : null,
    };
    // 彈性的課表沒有日期：空的日子不是休息日，不列出來
    if (!day.sessions.length && !day.races.length && flexibleWeeks.has(weekOf(date)) && !day.nextWeek) continue;
    days.push(day);
  }

  const earlier = sessions.filter((s) => s.date !== null && s.date < first);
  const undated = sessions.filter((s) => s.date === null);
  const todays = days[0]?.date === today ? days[0].sessions.filter((s) => !isRest(s)) : [];
  const focus =
    todays[0] ??
    sessions.find((s) => s.date !== null && s.date > today && !isRest(s) && s.status === "planned") ??
    undated.find((s) => s.status === "planned" && !s.result?.workoutId) ??
    null;

  const later = upcoming.filter((r) => r.date > end);
  const soon = later.filter((r) => daysBetween(today, r.date) <= LATER_RACE_DAYS).slice(0, 2);
  return {
    week: { range: weekRange(start), km: current.totalKm, runs: current.runCount },
    thisWeek: today >= start && today <= addDays(start, 6),
    earlier,
    undated,
    days,
    focus,
    laterRaces: soon.length ? soon : later.slice(0, 1),
  };
}
