import { describe, expect, it } from "vitest";

import { danielsPaces, heartRateInfo, type Race, type TrainingValues, type Workout } from "../src";
import {
  checkPlan,
  estimateSession,
  parseSessions,
  parseWeekdays,
  planMarkdown,
  targetText,
  type CheckContext,
  type SessionDraft,
} from "../src/plan";
import { makeCoach, toolTurn, turn } from "./helpers";

const WEEK = "2026-10-12"; // 星期一
const TODAY = "2026-10-10";

const values = (withPaces = true): TrainingValues =>
  ({
    paces: withPaces ? danielsPaces(50) : null,
    hr: heartRateInfo({}, { lthr: 172, max_hr: 190, hr_zones: [145, 153, 161, 170, 175, 182, 190], threshold_pace: null }, TODAY),
  }) as TrainingValues;

const run = (date: string, km: number, partial: Partial<Workout> = {}): Workout => ({
  id: 1,
  intervals_id: null,
  strava_id: null,
  date,
  type: "run",
  distance_km: km,
  duration_min: km * 6,
  avg_hr: 140,
  max_hr: 150,
  avg_pace: "6:00/km",
  elevation_m: 0,
  calories: 0,
  training_load: 40,
  perceived_effort: null,
  subjective_notes: null,
  source: "intervals",
  synced_at: "",
  ...partial,
});

/** 最近四週每週約 30 km（週二 8、週四 8、週日 14），最長 14 km */
const history = (): Workout[] =>
  [1, 2, 3, 4].flatMap((n) => {
    const monday = new Date(Date.parse(`${WEEK}T00:00:00Z`) - 7 * n * 86_400_000).toISOString().slice(0, 10);
    const day = (d: number) => new Date(Date.parse(`${monday}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    return [run(day(1), 8), run(day(3), 8), run(day(6), 14)];
  });

const ctx = (partial: Partial<CheckContext> = {}): CheckContext => ({
  values: values(),
  challenge: false,
  fallbackPaceSec: 360,
  weekStart: WEEK,
  style: "fixed",
  today: TODAY,
  profile: {},
  workouts: history(),
  races: [],
  recovery: null,
  others: [],
  ...partial,
});

const easy = (date: string, km = 8): SessionDraft => ({
  date,
  kind: "easy",
  title: "輕鬆跑",
  steps: [{ distance_km: km, target: { hr: "easy" } }],
  purpose: "有氧",
  success: "心率不超過上限",
  fallback: null,
});
const tempo = (date: string, reps = 4, fallback: string | null = "改成 40 分鐘輕鬆跑"): SessionDraft => ({
  date,
  kind: "threshold",
  title: `${reps}×1 km 閾值`,
  steps: [{ distance_km: 2, target: { pace: "E" } }, { repeat: reps, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] }, { distance_km: 1.5, target: { pace: "E" } }],
  purpose: "提高閾值",
  success: "每一趟都在範圍內",
  fallback,
});
const long = (date: string, km = 14): SessionDraft => ({ ...easy(date, km), kind: "long", title: "長跑" });
const goodWeek = () => [easy("2026-10-13"), tempo("2026-10-15"), long("2026-10-18")];
const rules = (sessions: SessionDraft[], c: Partial<CheckContext> = {}) => checkPlan(sessions, ctx(c)).map((w) => w.rule);

describe("解析課表", () => {
  it("目標要寫代號；固定的課表每堂要有這週的日期", () => {
    expect(() => parseSessions([{ ...easy("2026-10-13"), steps: [{ distance_km: 5, target: { pace: "4:30" } }] }], WEEK, "fixed")).toThrow(/要寫代號|只能是/);
    expect(() => parseSessions([{ ...easy("2026-10-13"), date: null }], WEEK, "fixed")).toThrow(/每堂都要有日期/);
    expect(() => parseSessions([easy("2026-10-20")], WEEK, "fixed")).toThrow(/不在這週/);
    expect(() => parseSessions([{ ...easy("2026-10-13"), kind: "jog" }], WEEK, "fixed")).toThrow(/kind 只能是/);
    expect(() => parseSessions([{ ...easy("2026-10-13"), steps: [{ target: { hr: "easy" } }] }], WEEK, "fixed")).toThrow(/distance_km 或 duration_min/);
    // 彈性的菜單可以沒有日期
    expect(parseSessions([{ ...easy("2026-10-13"), date: null }], WEEK, "flexible")[0]!.date).toBeNull();
  });
});

describe("目標的換算與估算", () => {
  const t = { values: values(), challenge: false, fallbackPaceSec: 360 };
  it("強度課的配速取保守的一端；想要挑戰的取中間；沒有配速依據時用體感", () => {
    expect(targetText({ pace: "T" }, t)).toBe("4:15–4:21/km（T）");
    expect(targetText({ pace: "T" }, { ...t, challenge: true })).toBe("4:12–4:18/km（T）");
    expect(targetText({ pace: "T" }, { ...t, values: values(false) })).toBe("體感 6–7/10（T，還沒有配速的依據）");
    expect(targetText({ hr: "easy" }, t)).toBe("心率 ≤153");
    expect(targetText({ zone: "Z2" }, t)).toBe("心率 Z2（146–153）");
    expect(targetText({ rpe: [3, 4] }, t)).toBe("體感 3–4/10");
  });

  it("重複組乘上次數；依時間的步驟以目標配速換算距離", () => {
    const e = estimateSession(tempo("2026-10-15", 5), t);
    expect(e.qualityKm.T).toBe(5);
    expect(e.km).toBeGreaterThan(8.5 + 5 * 0.15);
    expect(e.km).toBeLessThan(8.5 + 5 * 0.25);
  });

  it("文字版列出換算後的目標與完成的標準", () => {
    const md = planMarkdown({ weekLabel: "2026-W42", weekStart: WEEK, style: "fixed", reason: "第一週", outline: "下週加一趟", notes: null }, goodWeek(), t);
    expect(md).toContain("10-15（星期四）｜T 閾值：4×1 km 閾值");
    expect(md).toContain("4 ×（1 km 4:15–4:21/km（T） ＋ 1 分鐘 心率 ≤153）");
    expect(md).toContain("狀況不好時：改成 40 分鐘輕鬆跑");
    expect(md).toContain("**之後幾週**\n下週加一趟");
  });
});

describe("檢查器", () => {
  it("合理的一週沒有問題", () => {
    expect(checkPlan(goodWeek(), ctx())).toEqual([]);
  });

  it("強度課：次數依強度偏好、不連排兩天、要有替代、每堂的量", () => {
    expect(rules([easy("2026-10-13"), tempo("2026-10-14"), tempo("2026-10-15"), long("2026-10-18")])).toContain("quality_spacing");
    expect(rules(goodWeek(), { profile: { pref_intensity: "easy" } })).toContain("quality_count");
    expect(rules([tempo("2026-10-13"), tempo("2026-10-15"), long("2026-10-18")], { profile: { pref_intensity: "moderate" } })).toContain("quality_count");
    expect(rules([easy("2026-10-13"), tempo("2026-10-15", 4, null), long("2026-10-18")])).toContain("fallback");
    expect(rules([easy("2026-10-13"), tempo("2026-10-15", 8), long("2026-10-18")])).toContain("quality_volume");
  });

  it("跑量、單次距離與長跑：和最近的紀錄比", () => {
    expect(rules([easy("2026-10-13", 10), easy("2026-10-15", 10), long("2026-10-18", 18)])).toEqual(expect.arrayContaining(["weekly_volume", "single_run"]));
    // 長跑佔週跑量的比例：每週 5 次以上才檢查
    const five = [easy("2026-10-12", 5), easy("2026-10-13", 5), easy("2026-10-15", 5), easy("2026-10-16", 5), long("2026-10-18", 13)];
    expect(rules(five)).toContain("long_run");
    expect(rules([easy("2026-10-13", 5), long("2026-10-18", 13)])).not.toContain("long_run");
    expect(rules([long("2026-10-18", 30)], { workouts: [run("2026-10-01", 30)] })).toContain("long_run");
    expect(rules([...goodWeek(), easy("2026-10-12"), easy("2026-10-14"), easy("2026-10-16"), easy("2026-10-17")])).toContain("rest_day");
  });

  it("停跑一週以上：先不排強度課、跑量約一半", () => {
    const old = history().filter((w) => w.date < "2026-09-28");
    expect(rules(goodWeek(), { workouts: old })).toEqual(expect.arrayContaining(["after_break"]));
  });

  it("三週內有比賽：檢查減量", () => {
    const race = { id: 1, name: "半馬", date: "2026-10-25", distance_km: 21.1, confirmed: 1, cancelled: 0, result_time: null } as Race;
    expect(rules(goodWeek(), { races: [race] })).toContain("taper");
    // 考慮中的比賽不要求減量；沒有出賽的也不算
    expect(rules(goodWeek(), { races: [{ ...race, confirmed: 0 }] })).not.toContain("taper");
    expect(rules(goodWeek(), { races: [{ ...race, outcome: "dns", cancelled: 1 }] })).not.toContain("taper");
    expect(rules([easy("2026-10-13", 5), tempo("2026-10-15", 3), long("2026-10-18", 7)], { races: [race] })).not.toContain("taper");
  });

  it("選手的偏好與今天的狀況", () => {
    expect(rules(goodWeek(), { profile: { pref_rest_days: "週二、週五" } })).toContain("preference");
    expect(rules(goodWeek(), { profile: { pref_long_run_day: "週六" } })).toContain("preference");
    expect(rules(goodWeek(), { profile: { pref_runs_per_week: "2" } })).toContain("preference");
    expect(rules(goodWeek(), { profile: { pref_max_minutes: "60" } })).toContain("preference");
    const flagged = { selfFlags: ["自評精神差（2/5）"], watchFlags: [] } as unknown as CheckContext["recovery"];
    expect(rules(goodWeek(), { today: "2026-10-15", recovery: flagged })).toContain("today");
    expect(parseWeekdays("週一、星期五、禮拜天")).toEqual([0, 4, 6]);
  });

  it("肌力訓練不排在強度課前一天；前一天騎很久，隔天不排強度課", () => {
    const strength: SessionDraft = { date: "2026-10-14", kind: "strength", title: "肌力", steps: [{ duration_min: 25, note: "深蹲、弓箭步" }], purpose: "肌力", success: "做完", fallback: null };
    expect(rules([...goodWeek(), strength])).toContain("strength_timing");
    expect(rules([...goodWeek(), { ...strength, date: "2026-10-15" }])).not.toContain("strength_timing");
    const ride = { intervals_id: "r1", date: "2026-10-14", type: "Ride", duration_min: 150, distance_km: 60, avg_hr: 130, training_load: 110 };
    expect(rules(goodWeek(), { others: [ride] })).toContain("cross_fatigue");
    expect(rules(goodWeek(), { others: [{ ...ride, duration_min: 40, training_load: 25 }] })).not.toContain("cross_fatigue");
    // 肌力與交叉訓練不算跑量
    expect(estimateSession(strength, { values: values(), challenge: false, fallbackPaceSec: 360 }).km).toBe(0);
  });

  it("沒有配速依據時提醒", () => {
    expect(rules(goodWeek(), { values: values(false) })).toContain("no_paces");
  });
});

describe("教練存課表與調整", () => {
  const input = (sessions: SessionDraft[], extra: Record<string, unknown> = {}) => ({
    week_start: "2026-10-14",
    style: "fixed",
    reason: "照目前的跑量排第一週",
    sessions,
    outline: "之後每兩週加一點量",
    ...extra,
  });

  /** 最近的 10 km 比賽 45:00，才有配速的依據 */
  const withRace = async (coach: Awaited<ReturnType<typeof makeCoach>>["coach"]) => {
    const id = await coach.db.addRace({ name: "城市路跑", date: "2026-09-20", distance_km: 10, target_time: "", confirmed: 1, notes: "" });
    await coach.recordRaceResult(id, { outcome: "finished", time: "45:00" });
  };

  it("沒有問題就存；有問題先退回，寫了理由才存；可以列出、跳過、改用替代與移動", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("save_training_plan", input([easy("2026-10-13"), tempo("2026-10-14"), tempo("2026-10-15")])),
      toolTurn("save_training_plan", input([easy("2026-10-13"), tempo("2026-10-14"), tempo("2026-10-15")], { accept_warnings: true })),
      toolTurn("save_training_plan", input([easy("2026-10-13"), tempo("2026-10-14"), tempo("2026-10-15")], { accept_warnings: true, warning_notes: "選手想試試看" })),
      toolTurn("save_training_plan", input(goodWeek())),
      turn({ text: "排好了" }),
      toolTurn("get_training_plan"),
      toolTurn("update_planned_session", { session_id: 5, action: "fallback", reason: "今天很累" }),
      toolTurn("update_planned_session", { session_id: 4, action: "move", date: "2026-10-14", reason: "週二沒空" }),
      toolTurn("update_planned_session", { session_id: 6, action: "move", date: "2026-10-30", reason: "延後" }),
      turn({ text: "排好了" }),
    ]);
    await withRace(coach);
    await coach.chat("幫我排下週");
    await coach.chat("週四好累、週二沒空");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toMatch(/^尚未儲存：檢查器發現以下問題/);
    expect(results[0]).toContain("強度課不要連排兩天");
    expect(results[1]).toBe("執行失敗：accept_warnings=true 時要在 warning_notes 寫出保留的理由");
    expect(results[2]).toMatch(/^課表已儲存（2026-W42）/);
    expect(results[3]).toMatch(/^課表已儲存（2026-W42）/);
    expect(results[4]).toContain("[session_id=5] 10-15（星期四）｜T 閾值：4×1 km 閾值");
    expect(results[4]).toMatch(/4 ×（1 km \d:\d\d–\d:\d\d\/km（T） ＋ 1 分鐘 能聊天的強度/);
    expect(results[4]).toContain("排課的原因：照目前的跑量排第一週");
    expect(results[5]).toBe("已改用替代的課（session_id=5）。");
    expect(results[6]).toMatch(/^已移動（session_id=4）。/);
    expect(results[7]).toBe("執行失敗：只能移到這週（2026-10-12～2026-10-18）");

    const plan = (await coach.db.getActiveTrainingPlan())!;
    expect(plan.reason).toBe("照目前的跑量排第一週");
    expect(plan.outline).toBe("之後每兩週加一點量");
    expect(plan.content).toContain("（改用替代）");
    const sessions = await coach.db.getPlannedSessions(plan.id);
    expect(sessions.map((s) => [s.id, s.date, s.status])).toEqual([
      [4, "2026-10-14", "planned"],
      [5, "2026-10-15", "fallback"],
      [6, "2026-10-18", "planned"],
    ]);
    // 舊的計畫停用，保留紀錄
    expect((await coach.db.getPlannedSessions(1)).length).toBe(3);
  });

  it("彈性的菜單：不寫日期", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("save_training_plan", { style: "flexible", reason: "生活不固定", sessions: goodWeek().map((s) => ({ ...s, date: undefined })) }),
      turn({ text: "好" }),
    ]);
    await withRace(coach);
    await coach.chat("我這週時間不固定");
    expect(provider.calls[1]!.toolResults![0]!.content).toContain("這週任一天｜T 閾值");
    expect((await coach.db.getActiveTrainingPlan())!.style).toBe("flexible");
  });

  it("系統提示：訓練偏好與排課前先問", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "好" })]);
    await coach.db.setProfileKey("pref_goal", "speed");
    await coach.db.setProfileKey("pref_intensity", "moderate");
    await coach.db.setProfileKey("pref_schedule", "flexible");
    await coach.chat("排課表");
    const system = provider.calls[0]!.request.system!;
    expect(system).toContain("訓練偏好：目標：練速度（5–10 km）｜強度：適度（每週一堂強度課）｜節奏：彈性");
    expect(system).toContain("排課前先看選手的訓練偏好");
  });
});

describe("其他運動", () => {
  const ride = (date: string, id = "r1") => ({
    intervals_id: id,
    date,
    type: "Ride",
    duration_min: 150,
    distance_km: 60,
    avg_hr: 128,
    training_load: 110,
  });

  it("同步時記下、跟著來源的刪除；教練在訓練紀錄、訓練數值與系統提示看得到", async () => {
    const { coach, activities, provider } = await makeCoach([
      toolTurn("get_recent_workouts", { days: 7 }),
      toolTurn("get_training_values"),
      turn({ text: "好" }),
    ]);
    let list = [ride("2026-10-09"), { ...ride("2026-10-08", "w1"), type: "WeightTraining", duration_min: 30, distance_km: null, training_load: 20 }];
    Object.assign(activities, { fetchOtherActivities: async () => list });
    expect(await coach.sync()).toBe(
      "Intervals.icu 最近 14 天無跑步活動。另有 1 筆騎車、1 筆肌力訓練，已一併記下，教練會參考；如果其中有跑步，可以在 Intervals.icu 把類型改成 Run。",
    );
    expect((await coach.db.getOtherActivities(7)).map((a) => a.intervals_id)).toEqual(["r1", "w1"]);

    await coach.chat("最近練得如何");
    expect(provider.calls[0]!.request.system).toContain("昨天與今天的其他運動");
    expect(provider.calls[0]!.request.system).toContain("- 2026-10-09 騎車：150 分鐘｜60 km｜負荷 110｜心率 128");
    expect(provider.calls[1]!.toolResults![0]!.content).toContain("最近 7 天沒有跑步。");
    expect(provider.calls[1]!.toolResults![0]!.content).toContain("- 2026-10-08 肌力訓練：30 分鐘｜負荷 20");
    expect(provider.calls[2]!.toolResults![0]!.content).toContain("其他運動 2 次 180 分鐘（負荷 130）");

    // 在 Intervals.icu 刪掉的，下次同步就移除
    list = [ride("2026-10-09")];
    await coach.sync();
    expect((await coach.db.getOtherActivities(7)).map((a) => a.intervals_id)).toEqual(["r1"]);
  });
});
