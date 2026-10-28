/** 傷病紀錄與檢查器依傷病擋課（規格 12.33 第 2、3 點） */
import { describe, expect, it } from "vitest";

import { danielsPaces, heartRateInfo, type TrainingValues } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { hardBlockReason, injuryLine, latestPain, type Injury } from "../src/injuries";
import { checkPlan, injuryWarnings, type CheckContext, type SessionDraft } from "../src/plan";
import { activePlan, changeSession, savePlanFromTool } from "../src/planning";
import { makeCoach, toolTurn, turn } from "./helpers";

// 今天是 2026-10-10（星期六）；排的是下週（10-12 起）
const TODAY = "2026-10-10";
const WEEK = "2026-10-12";

const values = (): TrainingValues =>
  ({
    paces: danielsPaces(50),
    hr: heartRateInfo({}, { lthr: 172, max_hr: 190, hr_zones: [145, 153, 161, 170, 175, 182, 190], threshold_pace: null }, TODAY),
  }) as TrainingValues;

const ctx = (injuries: Injury[], partial: Partial<CheckContext> = {}): CheckContext => ({
  values: values(),
  challenge: false,
  fallbackPaceSec: 360,
  weekStart: WEEK,
  style: "fixed",
  today: TODAY,
  profile: {},
  workouts: [],
  races: [],
  recovery: null,
  others: [],
  injuries,
  ...partial,
});

const injury = (partial: Partial<Injury> = {}): Injury => ({
  id: 1,
  area: "膝蓋",
  side: "left",
  started_on: "2026-10-05",
  status: "active",
  sports: ["run"],
  red_flag: false,
  notes: null,
  scores: [{ date: "2026-10-09", score: 2, when: "after" }],
  created_at: "",
  updated_at: "",
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
const tempo = (date: string): SessionDraft => ({
  date,
  kind: "threshold",
  title: "4×1 km 閾值",
  steps: [{ distance_km: 2, target: { pace: "E" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] }, { distance_km: 1.5, target: { pace: "E" } }],
  purpose: "提高閾值",
  success: "每一趟都在範圍內",
  fallback: "改成 40 分鐘輕鬆跑",
});
const long = (date: string): SessionDraft => ({ ...easy(date, 14), kind: "long", title: "長跑" });
const rest = (date: string): SessionDraft => ({ date, kind: "rest", title: "休息", steps: [], purpose: "", success: "", fallback: null });
const rideSweetspot = (date: string): SessionDraft => ({
  date,
  kind: "ride_sweetspot",
  title: "甜蜜點 2×20",
  steps: [{ duration_min: 15, target: { zone: "Z2" } }, { repeat: 2, steps: [{ duration_min: 20, target: { zone: "SS" } }, { duration_min: 5, target: { zone: "Z1" } }] }],
  purpose: "FTP",
  success: "穩定",
  fallback: "改成 60 分鐘耐力騎",
});
const rideEndurance = (date: string): SessionDraft => ({ ...rideSweetspot(date), kind: "ride_endurance", title: "耐力騎", steps: [{ duration_min: 60, target: { zone: "Z2" } }], fallback: null });
const strength = (date: string): SessionDraft => ({ date, kind: "strength", title: "肌力", steps: [{ duration_min: 25 }], purpose: "", success: "", fallback: null });

const week = () => [easy("2026-10-13"), tempo("2026-10-15"), rideSweetspot("2026-10-16"), rest("2026-10-17"), long("2026-10-18")];
const blocked = (sessions: SessionDraft[], injuries: Injury[]) =>
  injuryWarnings(sessions, ctx(injuries))
    .filter((w) => w.blocking)
    .map((w) => sessions[w.session!]!.title);

describe("傷病紀錄的判斷", () => {
  it("最近一天的分數（同一天取最高）；疼痛超過 3/10、沒有分數、超過 3 天沒回報時擋強度課與長課", () => {
    const i = injury({ scores: [{ date: "2026-10-08", score: 6, when: "during" }, { date: "2026-10-09", score: 1, when: "morning" }, { date: "2026-10-09", score: 3, when: "after" }] });
    expect(latestPain(i)).toEqual({ date: "2026-10-09", score: 3 });
    expect(hardBlockReason(i, TODAY)).toBeNull();
    expect(hardBlockReason(injury({ scores: [{ date: "2026-10-10", score: 4, when: "during" }] }), TODAY)).toContain("4/10");
    expect(hardBlockReason(injury({ scores: [] }), TODAY)).toContain("還沒有回報");
    expect(hardBlockReason(injury({ scores: [{ date: "2026-10-07", score: 1, when: "after" }] }), TODAY)).toBeNull();
    expect(hardBlockReason(injury({ scores: [{ date: "2026-10-06", score: 1, when: "after" }] }), TODAY)).toContain("超過 3 天沒有回報");
  });

  it("教練看到的一行：部位與側別、狀態、會痛的運動、分數、紅旗；不知道會痛的運動時寫全部", () => {
    const line = injuryLine(injury({ sports: [], red_flag: true }), TODAY);
    expect(line).toContain("[id=1] 左膝蓋（進行中，2026-10-05 起）");
    expect(line).toContain("全部的運動");
    expect(line).toContain("10-09 運動後 2/10");
    expect(line).toContain("有紅旗");
  });
});

describe("檢查器依傷病擋課（所有運動）", () => {
  it("疼痛超過 3/10：會痛的運動（跑步）的強度課與長課不能排；騎車不痛照常；輕鬆跑照疼痛規則提醒（要寫理由）", () => {
    const hurt = [injury({ scores: [{ date: "2026-10-10", score: 5, when: "during" }] })];
    expect(blocked(week(), hurt)).toEqual(["4×1 km 閾值", "長跑"]);
    const warnings = injuryWarnings(week(), ctx(hurt));
    const pain = warnings.find((w) => w.rule === "injury_pain")!;
    expect(pain.blocking).toBeFalsy();
    expect(pain.message).toContain("輕鬆跑");
    expect(pain.message).not.toContain("甜蜜點");
  });

  it("不知道哪些運動會痛時當成全部：騎車的強度課也擋；休息不算", () => {
    const hurt = [injury({ sports: [], scores: [{ date: "2026-10-10", score: 5, when: "during" }] })];
    expect(blocked(week(), hurt)).toEqual(["4×1 km 閾值", "甜蜜點 2×20", "長跑"]);
  });

  it("騎車會痛：擋騎車的強度課與長騎，耐力騎照疼痛規則提醒；跑步不受影響", () => {
    const hurt = [injury({ sports: ["ride"], scores: [{ date: "2026-10-10", score: 4, when: "after" }] })];
    const sessions = [...week(), rideEndurance("2026-10-14"), { ...rideEndurance("2026-10-17"), kind: "ride_long" as const, title: "長騎" }];
    expect(blocked(sessions, hurt)).toEqual(["甜蜜點 2×20", "長騎"]);
    expect(injuryWarnings(sessions, ctx(hurt)).find((w) => w.rule === "injury_pain")!.message).toContain("耐力騎");
  });

  it("超過 3 天沒有回報分數也擋；最近的分數不超過 3/10 時強度課只提醒（可以寫理由）", () => {
    expect(blocked(week(), [injury({ scores: [{ date: "2026-10-05", score: 1, when: "after" }] })])).toEqual(["4×1 km 閾值", "長跑"]);
    const ok = injuryWarnings(week(), ctx([injury()]));
    expect(ok.some((w) => w.blocking)).toBe(false);
    expect(ok.find((w) => w.rule === "injury_pain")!.message).toContain("4×1 km 閾值");
  });

  it("有紅旗：所有運動的課都不能排（肌力也是），休息不算", () => {
    const flagged = [injury({ red_flag: true, sports: ["run"] })];
    const sessions = [...week(), strength("2026-10-14")];
    expect(blocked(sessions, flagged)).toEqual(["輕鬆跑", "4×1 km 閾值", "甜蜜點 2×20", "長跑", "肌力"]);
  });

  it("好了的不算；今天以前的課不算", () => {
    expect(injuryWarnings(week(), ctx([injury({ status: "resolved", red_flag: true })]))).toEqual([]);
    expect(blocked([tempo("2026-10-09")], [injury({ scores: [{ date: "2026-10-10", score: 6, when: "during" }] })])).toEqual([]);
  });

  it("沒有傷病時 checkPlan 和原本一樣", () => {
    expect(checkPlan(week(), ctx([])).some((w) => w.rule.startsWith("injury"))).toBe(false);
  });
});

/** 最近的 10 km 比賽 45:00，才有配速的依據（不然存課表時有「沒有配速依據」的提醒） */
async function withPaces(coach: Awaited<ReturnType<typeof makeCoach>>["coach"]) {
  const id = await coach.db.addRace({ name: "城市路跑", date: "2026-09-20", distance_km: 10, target_time: "", confirmed: 1, notes: "" });
  await coach.recordRaceResult(id, { outcome: "finished", time: "45:00" });
}

describe("存課表與調整課表（不能保留的不接受理由）", () => {
  const input = (sessions: SessionDraft[], extra: Record<string, unknown> = {}) => ({ week_start: WEEK, style: "fixed", reason: "下週", sessions, ...extra });

  it("不能排的課：寫了理由（accept_warnings）也不存；改成輕鬆的課就存得了（照疼痛規則的提醒要寫理由）", async () => {
    const { coach } = await makeCoach([]);
    await withPaces(coach);
    const id = await coach.db.addInjury({ area: "膝蓋", side: "left", sports: ["run"] });
    await coach.db.addInjuryScore(id, { date: TODAY, score: 5, when: "during" });
    const refused = await savePlanFromTool(coach.db, TODAY, input([easy("2026-10-13"), tempo("2026-10-15")], { accept_warnings: true, warning_notes: "選手說可以" }));
    expect(refused).toContain("寫理由也不能保留");
    expect(refused).toContain("4×1 km 閾值");
    expect(await coach.db.getActiveTrainingPlan()).toBeNull();

    const needsReason = await savePlanFromTool(coach.db, TODAY, input([easy("2026-10-13", 5), strength("2026-10-15")]));
    expect(needsReason).toContain("尚未儲存");
    expect(needsReason).toContain("疼痛規則");
    const saved = await savePlanFromTool(coach.db, TODAY, input([easy("2026-10-13", 5), strength("2026-10-15")], { accept_warnings: true, warning_notes: "降量、會痛就停" }));
    expect(saved).toContain("課表已儲存");
  });

  it("之後才記下傷病：課表頁標出先不要做的課，不能恢復跳過的課", async () => {
    const { coach } = await makeCoach([]);
    await withPaces(coach);
    expect(await savePlanFromTool(coach.db, TODAY, input([easy("2026-10-13"), tempo("2026-10-15"), long("2026-10-18")]))).toContain("課表已儲存");
    const plan = (await activePlan(coach.db, TODAY))!;
    expect(plan.sessions.every((s) => s.injuryHold === null)).toBe(true);
    const tempoId = plan.sessions.find((s) => s.kind === "threshold")!.id!;
    await changeSession(coach.db, TODAY, tempoId, "skip", { reason: "膝蓋痛" });

    await coach.db.addInjury({ area: "膝蓋", side: "right", sports: [] });
    const held = (await activePlan(coach.db, TODAY))!.sessions.filter((s) => s.injuryHold).map((s) => s.title);
    // 跳過的那堂不算；沒有分數時長跑先不要做
    expect(held).toEqual(["長跑"]);
    await expect(changeSession(coach.db, TODAY, tempoId, "restore")).rejects.toThrow(/傷病/);
  });

  it("只改一堂課：改成不能排的課時，寫理由也不改", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("save_training_plan", input([easy("2026-10-13"), easy("2026-10-15")])),
      turn({ text: "排好了" }),
      toolTurn("record_injury", { area: "小腿", side: "left", sports: ["run"], score: 5, score_when: "during" }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "想練", session: tempo("2026-10-15"), accept_warnings: true, warning_notes: "選手堅持" }),
      turn({ text: "好" }),
    ]);
    await withPaces(coach);
    await coach.chat("幫我排下週");
    await coach.chat("小腿痛，跑步中 5 分；週四想改閾值");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results.find((r) => r.startsWith("已記下傷病"))).toContain("左小腿");
    expect(results.find((r) => r.includes("尚未修改"))).toContain("寫理由也不能保留");
    const sessions = await coach.db.getPlannedSessions((await coach.db.getActiveTrainingPlan())!.id);
    expect(sessions.find((s) => s.id === 2)!.kind).toBe("easy");
  });
});

describe("教練的工具與系統提示", () => {
  it("record_injury 記下後系統提示有【傷病紀錄】；update_injury 記分數、改狀態；課表上不能做的課列給教練", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("save_training_plan", { week_start: WEEK, style: "fixed", reason: "下週", sessions: [easy("2026-10-13"), tempo("2026-10-15")] }),
      turn({ text: "排好了" }),
      toolTurn("record_injury", { area: "膝蓋", side: "left", started_on: "2026-10-08", sports: ["run"], score: 4, score_when: "after", notes: "下樓梯會痛" }),
      turn({ text: "已記下：左膝" }),
      turn({ text: "好" }),
      toolTurn("update_injury", { injury_id: 1, score: 2, score_when: "morning", status: "improving" }),
      turn({ text: "好轉中" }),
    ]);
    await withPaces(coach);
    await coach.chat("幫我排下週");
    await coach.chat("左膝外側痛");
    const recorded = provider.calls.at(-1)!.toolResults![0]!.content;
    expect(recorded).toContain("已記下傷病（id=1）");
    expect(recorded).toContain("4×1 km 閾值");
    expect(recorded).toContain("update_planned_session");
    await coach.chat("今天怎麼樣");
    const system = provider.calls.at(-1)!.request.system!;
    expect(system).toContain("【傷病紀錄】");
    expect(system).toContain("[id=1] 左膝蓋（進行中，2026-10-08 起）");
    expect(system).toContain("傷病的處理（v7）");
    await coach.chat("今天早上 2 分，好多了");
    const injury = (await coach.db.getInjury(1))!;
    expect(injury.status).toBe("improving");
    expect(injury.scores.map((s) => [s.when, s.score])).toEqual([["after", 4], ["morning", 2]]);
  });

  it("好了的不在系統提示裡；刪除", async () => {
    const { coach } = await makeCoach([turn({ text: "好" })]);
    const id = await coach.db.addInjury({ area: "足底", side: "right", status: "resolved" });
    expect(await coach.db.getInjuries()).toEqual([]);
    expect(await coach.db.getInjuries({ includeResolved: true })).toHaveLength(1);
    expect(await coach.db.deleteInjury(id)).toBe(true);
  });
});

describe("多裝置同步", () => {
  it("傷病紀錄（含分數）帶到另一台；刪除也跟著刪", async () => {
    const ma = await makeCoach([]);
    const mb = await makeCoach([]);
    const id = await ma.coach.db.addInjury({ area: "膝蓋", side: "left", sports: ["run", "ride"], red_flag: true });
    await ma.coach.db.addInjuryScore(id, { date: TODAY, score: 3, when: "after" });
    const snap = await snapshot(ma.driver);
    const entries = [...snap.data].filter(([k]) => k.startsWith("in:"));
    expect(entries).toHaveLength(1);
    const target = await snapshot(mb.driver);
    for (const [name, data] of entries) expect(await applyEntity(mb.driver, name, data, target)).toBe("applied");
    const [copied] = await mb.coach.db.getInjuries();
    expect(copied).toMatchObject({ area: "膝蓋", side: "left", sports: ["run", "ride"], red_flag: true, scores: [{ date: TODAY, score: 3, when: "after" }] });
    await applyEntity(mb.driver, entries[0]![0], null, target);
    expect(await mb.coach.db.getInjuries()).toEqual([]);
  });
});

describe("看板（規格 12.33）", () => {
  it("自評過了、還沒好的傷今天沒有分數：問今天幾分；回報了就不問", async () => {
    const { coach } = await makeCoach([]);
    const id = await coach.db.addInjury({ area: "膝蓋", side: "left", sports: ["run"] });
    expect((await coach.feed()).some((i) => i.kind === "injury")).toBe(false);
    await coach.saveCheckin({ energy: 4, soreness: 2, sleep: 4, notes: null });
    const item = (await coach.feed()).find((i) => i.kind === "injury")!;
    expect(item.title).toBe("左膝蓋今天幾分？");
    expect(item.actions).toEqual([{ type: "checkin" }]);
    await coach.db.addInjuryScore(id, { date: TODAY, score: 2, when: "checkin" });
    expect((await coach.feed()).some((i) => i.kind === "injury")).toBe(false);
  });

  it("今天的課因為傷病不能做：那一行標「先不要做」，請教練調整", async () => {
    const { coach } = await makeCoach([]);
    await withPaces(coach);
    // 這週（10-05 起）、今天 10-10 的閾值課
    const saved = await savePlanFromTool(coach.db, TODAY, { week_start: "2026-10-05", style: "fixed", reason: "這週", sessions: [tempo(TODAY)] });
    expect(saved).toContain("課表已儲存");
    await coach.db.addInjury({ area: "膝蓋", side: "left", sports: ["run"] });
    const today = (await coach.feed()).find((i) => i.title === "今天的課")!;
    expect(today.tone).toBe("warn");
    expect(today.lines![0]!.text).toContain("先不要做");
    expect(today.actions[0]).toMatchObject({ type: "ask", label: "請教練調整" });
  });
});
