import { describe, expect, it } from "vitest";

import { danielsPaces, heartRateInfo, type TrainingValues, type Workout } from "../src";
import { checkPlan, type PlannedSession, type SessionDraft } from "../src/plan";
import { difficultyOf, matchWeek, paceAdjustment, type SessionResult } from "../src/plan-match";
import { makeCoach, toolTurn, turn } from "./helpers";

const WEEK = "2026-10-05"; // 星期一；makeCoach 的今天是 2026-10-10（星期六）
const TODAY = "2026-10-10";
const ZONES = [145, 153, 161, 170, 175, 182, 190];
const ctx = {
  values: {
    paces: danielsPaces(45),
    hr: heartRateInfo({}, { lthr: 172, max_hr: 190, hr_zones: ZONES, threshold_pace: null }, TODAY),
  } as TrainingValues,
  challenge: false,
  fallbackPaceSec: 360,
};

let nextId = 1;
const run = (date: string, km: number, minutes: number, zoneMin: number[], partial: Partial<Workout> = {}): Workout => ({
  id: nextId++,
  intervals_id: null,
  strava_id: null,
  date,
  type: "run",
  distance_km: km,
  duration_min: minutes,
  avg_hr: 150,
  max_hr: 170,
  avg_pace: "6:00/km",
  elevation_m: 0,
  calories: 0,
  training_load: 50,
  perceived_effort: null,
  subjective_notes: null,
  source: "intervals",
  synced_at: "",
  raw_json: JSON.stringify({ icu_hr_zone_times: zoneMin.map((m) => m * 60), icu_hr_zones: ZONES, lthr: 172 }),
  ...partial,
});
const session = (id: number, draft: Partial<SessionDraft> & Pick<SessionDraft, "kind">): PlannedSession => ({
  id,
  plan_id: 1,
  status: "planned",
  note: null,
  date: null,
  title: draft.kind,
  steps: [{ duration_min: 40, target: { hr: "easy" } }],
  purpose: "",
  success: "",
  fallback: null,
  ...draft,
});
const tempo = (id: number, date: string | null) =>
  session(id, {
    kind: "threshold",
    date,
    title: "4×1 km 閾值",
    steps: [{ duration_min: 15, target: { hr: "easy" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] }, { duration_min: 10, target: { hr: "easy" } }],
    fallback: "改成 40 分鐘輕鬆跑",
  });
const outcome = (r: SessionResult | undefined) => r?.outcome;

describe("配對與判斷", () => {
  it("同一天配對；跑成輕鬆跑的強度課是「跑了不一樣的課」；沒跑的過去的課提醒不要補", () => {
    const sessions = [session(1, { kind: "easy", date: "2026-10-06" }), tempo(2, "2026-10-08"), session(3, { kind: "long", date: "2026-10-11", steps: [{ distance_km: 12, target: { pace: "E" } }] })];
    const runs = [run("2026-10-06", 6.5, 41, [30, 11, 0, 0, 0, 0, 0]), run("2026-10-08", 8.5, 52, [45, 7, 0, 0, 0, 0, 0])];
    const m = matchWeek(sessions, runs, [], WEEK, TODAY, ctx);
    expect(outcome(m.results.get(1))).toBe("achieved");
    expect(m.results.get(2)).toMatchObject({ outcome: "different", reasons: ["強度比計畫低，比較像輕鬆跑"] });
    expect(outcome(m.results.get(3))).toBe("pending");

    const missed = matchWeek(sessions, [runs[0]!], [], WEEK, TODAY, ctx);
    expect(missed.results.get(2)).toMatchObject({ outcome: "missed", reasons: ["跳過即可，不要補"] });
  });

  it("輕鬆跑跑得太硬、跑得比計畫短、體感偏難", () => {
    const easy = session(1, { kind: "easy", date: "2026-10-06" });
    const hard = matchWeek([easy], [run("2026-10-06", 7, 40, [10, 5, 15, 10, 0, 0, 0])], [], WEEK, TODAY, ctx);
    expect(hard.results.get(1)!.outcome).toBe("different");
    expect(hard.results.get(1)!.reasons[0]).toMatch(/^強度比計畫高/);
    const short = matchWeek([easy], [run("2026-10-06", 3, 20, [20, 0, 0, 0, 0, 0, 0], { perceived_effort: 6 })], [], WEEK, TODAY, ctx);
    expect(short.results.get(1)).toMatchObject({ outcome: "partial", difficulty: "hard" });
    expect(short.results.get(1)!.reasons).toEqual(["比計畫短（約 50%）", "體感比預期累"]);
    expect(difficultyOf("threshold", 7)).toBe("right");
    expect(difficultyOf("easy", 1)).toBe("easy");
    expect(difficultyOf("rest", 5)).toBeNull();
  });

  it("先跑後排：這週已經跑過、那天沒有課的列為課表外的跑步；跳過的課不配對", () => {
    const sessions = [tempo(1, "2026-10-08"), { ...session(2, { kind: "easy", date: "2026-10-09" }), status: "skipped" as const }];
    const runs = [run("2026-10-05", 8, 48, [48, 0, 0, 0, 0, 0, 0]), run("2026-10-08", 9, 55, [20, 10, 10, 15, 0, 0, 0]), run("2026-10-09", 5, 30, [30, 0, 0, 0, 0, 0, 0])];
    const m = matchWeek(sessions, runs, [], WEEK, TODAY, ctx);
    expect(outcome(m.results.get(1))).toBe("achieved");
    expect(outcome(m.results.get(2))).toBe("skipped");
    expect(m.extraRuns.map((w) => w.date)).toEqual(["2026-10-05", "2026-10-09"]);
  });

  it("彈性的菜單：硬的那趟配給強度課，其餘配給輕鬆的；肌力課配肌力訓練", () => {
    const sessions = [session(1, { kind: "easy" }), tempo(2, null), session(3, { kind: "strength", steps: [{ duration_min: 25 }] })];
    const runs = [run("2026-10-06", 9, 55, [20, 10, 10, 15, 0, 0, 0]), run("2026-10-08", 6.5, 40, [40, 0, 0, 0, 0, 0, 0])];
    const lift = { intervals_id: "w1", date: "2026-10-07", type: "WeightTraining", duration_min: 30, distance_km: null, avg_hr: null, training_load: 20 };
    const m = matchWeek(sessions, runs, [lift], WEEK, TODAY, ctx);
    expect(m.results.get(2)!.workoutId).toBe(runs[0]!.id);
    expect(m.results.get(1)!.workoutId).toBe(runs[1]!.id);
    expect(outcome(m.results.get(3))).toBe("achieved");
  });

  it("依結果調整配速：太難或沒做到退一級（最多兩級），達成就回升 0.5", () => {
    const r = (outcomeValue: SessionResult["outcome"], difficulty: SessionResult["difficulty"] = null) => ({
      outcome: outcomeValue,
      reasons: [],
      difficulty,
      actual: null,
      workoutId: 1,
    });
    expect(paceAdjustment([{ kind: "threshold", date: "2026-10-01", result: r("partial") }])).toEqual({ penalty: 1, reason: "10-01 的強度課部分達成" });
    expect(paceAdjustment([{ kind: "interval", date: "2026-10-01", result: r("achieved", "hard") }]).penalty).toBe(1);
    expect(
      paceAdjustment([
        { kind: "threshold", date: "2026-10-01", result: r("partial") },
        { kind: "threshold", date: "2026-10-04", result: r("achieved", "right") },
        { kind: "threshold", date: "2026-10-08", result: r("achieved") },
      ]),
    ).toEqual({ penalty: 0, reason: null });
    // 輕鬆跑的結果、強度課跑成輕鬆跑（可能是自己決定的）不影響
    expect(paceAdjustment([{ kind: "easy", date: "2026-10-01", result: r("different") }]).penalty).toBe(0);
    expect(paceAdjustment([{ kind: "threshold", date: "2026-10-01", result: r("different") }]).penalty).toBe(0);
  });

  it("檢查器把這週已經跑的算進跑量", () => {
    const base = {
      ...ctx,
      weekStart: WEEK,
      style: "fixed" as const,
      today: TODAY,
      profile: {},
      races: [],
      recovery: null,
      others: [],
      workouts: [1, 2, 3, 4].flatMap((n) => [run(`2026-09-${String(30 - 7 * n + 7).padStart(2, "0")}`, 10, 60, [60, 0, 0, 0, 0, 0, 0])]),
    };
    const rest = [session(1, { kind: "easy", date: "2026-10-11", steps: [{ distance_km: 8 }] })];
    expect(checkPlan(rest, base).map((w) => w.rule)).not.toContain("weekly_volume");
    const done = [run("2026-10-06", 10, 60, [60, 0, 0, 0, 0, 0, 0]), run("2026-10-08", 10, 60, [60, 0, 0, 0, 0, 0, 0])];
    expect(checkPlan(rest, { ...base, workouts: [...base.workouts, ...done] }).map((w) => w.rule)).toContain("weekly_volume");
  });
});

describe("課表與實際進到教練", () => {
  const plan = {
    week_start: "2026-10-05",
    style: "fixed",
    reason: "這週",
    sessions: [
      { date: "2026-10-08", kind: "threshold", title: "4×1 km 閾值", steps: [{ distance_km: 2, target: { hr: "easy" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }] }], purpose: "閾值", success: "每趟在範圍內", fallback: "改成輕鬆跑" },
      { date: "2026-10-10", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "恢復", success: "心率不超過上限" },
    ],
    accept_warnings: true,
    warning_notes: "測試",
  };

  it("課表列出判斷；排在今天以前的課提醒；教練動態列出今天的課與昨天沒跑的課；跑後分析帶入課表", async () => {
    const { coach, provider } = await makeCoach([toolTurn("save_training_plan", plan), toolTurn("get_training_plan"), turn({ text: "好" })]);
    await coach.chat("排課表");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toMatch(/^課表已儲存/);
    expect(results[1]).toContain("→ 沒跑：跳過即可，不要補");
    expect(results[1]).toContain("跑了不一樣的課、沒跑的課都不是失敗");

    const feed = await coach.feed();
    // 看板只放摘要：時間與目標，步驟留在課表頁（規格 12.28）
    const today = feed.find((i) => i.kind === "plan" && i.title.startsWith("今天："));
    expect(today?.title).toBe("今天：輕鬆跑 40 分鐘");
    expect(today?.detail).toBe("能聊天的強度（體感 2–4/10）");
    expect(today?.actions.map((a) => (a.type === "ask" ? a.label : a.type))).toEqual(["plan", "想改輕鬆一點"]);

    // 排在今天以前的課：先退回
    const again = await makeCoach([toolTurn("save_training_plan", { ...plan, accept_warnings: false }), turn({ text: "好" })]);
    await again.coach.chat("排課表");
    expect(again.provider.calls[1]!.toolResults![0]!.content).toContain("10-08 的課排在今天以前");
  });

  it("同一天的課合成一列；肌力沒有「想改輕鬆一點」", async () => {
    const both = {
      ...plan,
      sessions: [
        plan.sessions[1],
        { date: "2026-10-10", kind: "strength", title: "肌力", steps: [{ duration_min: 20 }], purpose: "預防受傷", success: "做完" },
      ],
    };
    const { coach } = await makeCoach([toolTurn("save_training_plan", both), turn({ text: "好" })]);
    await coach.chat("排課表");
    const today = (await coach.feed()).filter((i) => i.kind === "plan" && i.title.startsWith("今天："));
    expect(today).toHaveLength(1);
    expect(today[0]!.title).toBe("今天：輕鬆跑 40 分鐘 · 肌力 20 分鐘");
    expect(today[0]!.actions.filter((a) => a.type === "ask")).toHaveLength(1);

    const strengthOnly = { ...plan, sessions: [both.sessions[1]] };
    const other = await makeCoach([toolTurn("save_training_plan", strengthOnly), turn({ text: "好" })]);
    await other.coach.chat("排課表");
    const item = (await other.coach.feed()).find((i) => i.kind === "plan" && i.title.startsWith("今天："));
    expect(item?.title).toBe("今天：肌力 20 分鐘");
    expect(item?.actions).toEqual([{ type: "plan" }]);
  });
});
