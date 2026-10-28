import { describe, expect, it } from "vitest";

import { danielsPaces, type Race, type TrainingPlan, type TrainingValues } from "../src";
import { sessionView, type SessionDraft } from "../src/plan";
import type { ActivePlan } from "../src/planning";
import { planTimeline } from "../src/plan-timeline";

const t = { values: { paces: danielsPaces(50), hr: null } as unknown as TrainingValues, challenge: false, fallbackPaceSec: 360 };

let nextId = 1;
const session = (date: string | null, kind: SessionDraft["kind"], title: string): ActivePlan["sessions"][number] => ({
  ...sessionView({ id: nextId++, date, kind, title, steps: kind === "rest" ? [] : [{ duration_min: 30 }], purpose: "", success: "", fallback: null }, t),
  result: null,
});

const plan = (weekStart: string, sessions: ActivePlan["sessions"], style = "fixed"): ActivePlan => ({
  plan: { id: nextId++, week_start: weekStart, week_label: "2026-W44", style, reason: "", notes: null, outline: null } as unknown as TrainingPlan,
  sessions,
  styleLabel: null,
  totalKm: 20,
  extraOthers: [],
  runCount: sessions.filter((s) => s.isRun).length,
  rideCount: 0,
  rideMinutes: 0,
  coachNote: null,
  extras: [],
});

const race = (id: number, date: string, partial: Partial<Race> = {}): Race =>
  ({ id, name: `賽事 ${id}`, date, distance_km: 21.0975, target_time: null, confirmed: 1, result_time: null, notes: null, cancelled: 0, ...partial }) as Race;

// 2026-10-26 是星期一；今天是星期二
const TODAY = "2026-10-27";
const week = () =>
  plan("2026-10-26", [
    session("2026-10-26", "easy", "輕鬆跑"),
    session("2026-10-27", "easy", "輕鬆跑 + 加速跑"),
    session("2026-10-27", "strength", "肌力"),
    session("2026-10-29", "threshold", "閾值"),
    session("2026-10-31", "rest", "休息"),
    session("2026-11-01", "long", "長跑"),
  ]);

describe("課表頁的時間軸（12.22）", () => {
  it("從今天排到課表的最後一天；今天以前的收進「這週稍早」；空的日子是休息", () => {
    const tl = planTimeline(week(), null, [], TODAY)!;
    expect(tl.week.range).toBe("10/26 – 11/1");
    expect(tl.thisWeek).toBe(true);
    expect(tl.earlier.map((s) => s.date)).toEqual(["2026-10-26"]);
    expect(tl.days.map((d) => d.date)).toEqual(["2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(tl.days.map((d) => d.label)).toEqual(["今天", "明天", "10/29", "10/30", "10/31", "11/1"]);
    expect(tl.days[0]!.weekday).toBe("二");
    // 同一天兩堂課放在同一個日期下
    expect(tl.days[0]!.sessions.map((s) => s.title)).toEqual(["輕鬆跑 + 加速跑", "肌力"]);
    expect(tl.days[1]!.sessions).toEqual([]);
    expect(tl.focus?.title).toBe("輕鬆跑 + 加速跑");
  });

  it("今天沒課時放大下一堂（休息不算）", () => {
    expect(planTimeline(week(), null, [], "2026-10-28")!.focus?.title).toBe("閾值");
    expect(planTimeline(week(), null, [], "2026-10-30")!.focus?.title).toBe("長跑");
  });

  it("先排好的下週接在後面，第一天標出下週的範圍", () => {
    const next = plan("2026-11-02", [session("2026-11-03", "easy", "下週的輕鬆跑")]);
    const tl = planTimeline(week(), next, [], TODAY)!;
    expect(tl.days.at(-1)!.date).toBe("2026-11-08");
    const first = tl.days.find((d) => d.date === "2026-11-02")!;
    expect(first.nextWeek).toEqual({ range: "11/2 – 11/8", km: 20, runs: 1, rides: 0, rideMinutes: 0 });
    expect(tl.days.find((d) => d.date === "2026-11-03")!.sessions[0]!.weekStart).toBe("2026-11-02");
  });

  it("賽事：範圍內的排在它的日期；範圍外的只放 60 天內最近的兩場，沒有時放最近的一場；比完、取消的不放", () => {
    const races = [
      race(1, "2026-10-31"),
      race(2, "2026-11-15"),
      race(3, "2026-11-29"),
      race(4, "2026-12-06"),
      race(5, "2026-10-30", { result_time: "1:50:00" }),
      race(6, "2026-10-29", { cancelled: 1 }),
      race(7, "2026-10-20"),
    ];
    const tl = planTimeline(week(), null, races, TODAY)!;
    expect(tl.days.flatMap((d) => d.races.map((r) => r.id))).toEqual([1]);
    expect(tl.laterRaces.map((r) => r.id)).toEqual([2, 3]);
    expect(planTimeline(week(), null, [race(8, "2027-03-01"), race(9, "2027-04-01")], TODAY)!.laterRaces.map((r) => r.id)).toEqual([8]);
  });

  it("彈性的課表：沒有日期的課另外列，空的日子不列", () => {
    const flex = plan("2026-10-26", [session(null, "easy", "輕鬆跑"), session(null, "long", "長跑")], "flexible");
    const tl = planTimeline(flex, null, [race(1, "2026-10-31")], TODAY)!;
    expect(tl.undated).toHaveLength(2);
    expect(tl.days.map((d) => d.date)).toEqual(["2026-10-31"]);
    expect(tl.focus?.title).toBe("輕鬆跑");
  });

  it("先排好、還沒開始的課表：不是「這週」，從它的星期一開始", () => {
    const tl = planTimeline(week(), null, [], "2026-10-24")!;
    expect(tl.thisWeek).toBe(false);
    expect(tl.days[0]!.date).toBe("2026-10-26");
    expect(tl.earlier).toEqual([]);
  });

  it("課表的週已經過了：全部收進稍早，沒有時間軸", () => {
    const tl = planTimeline(week(), null, [], "2026-11-03")!;
    expect(tl.thisWeek).toBe(false);
    expect(tl.days).toEqual([]);
    expect(tl.earlier).toHaveLength(6);
  });
  it("多運動：課表外的其他運動排進那天（今天以前的放在稍早）；開關關著時不放", () => {
    const ride = (date: string, id: string) => ({ intervals_id: id, date, type: "Ride", duration_min: 60, distance_km: 25, avg_hr: 128, training_load: 38 });
    const current = { ...week(), extraOthers: [ride("2026-10-26", "past"), ride("2026-10-27", "today")] };
    const tl = planTimeline(current, null, [], TODAY, { others: true })!;
    expect(tl.days[0]!.others.map((a) => a.intervals_id)).toEqual(["today"]);
    expect(tl.earlierOthers.map((a) => a.intervals_id)).toEqual(["past"]);
    const off = planTimeline(current, null, [], TODAY)!;
    expect(off.days[0]!.others).toEqual([]);
    expect(off.earlierOthers).toEqual([]);
  });
});
