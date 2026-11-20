import { describe, expect, it } from "vitest";

import { coverManualOthers, Db, loadOf, type OtherActivity } from "../src";
import { applyEntity, isKnown, snapshot } from "../src/device-sync/entities";
import { matchWeek } from "../src/plan-match";
import { changeSession, planTextForTool, reportSession, unreportedSessions, unreportSession } from "../src/planning";
import { buildTools } from "../src/tools";
import { DEFAULT_SETTINGS, type CoachSettings } from "../src/types";
import { openNodeSqlite } from "@running-coach/sqlite-node";
import { activity, makeCoach, toolTurn, turn } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）
const TODAY = "2026-10-10";
const WEEK = "2026-10-05";
const FLAGS: Partial<CoachSettings> = { features: ["multisport", "report"] };

async function withPlan(settings: Partial<CoachSettings> = FLAGS) {
  const made = await makeCoach([], { settings });
  const planId = await made.coach.db.saveStructuredPlan(
    { weekLabel: "W41", weekStart: WEEK, style: "fixed", reason: "r", outline: null, notes: null, content: "" },
    [
      { date: "2026-10-08", kind: "strength", title: "輕度肌力", steps: [{ duration_min: 30 }], purpose: "", success: "", fallback: null },
      { date: "2026-10-09", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40 }], purpose: "", success: "", fallback: null },
      { date: "2026-10-10", kind: "cross", sport: "ride", title: "輕鬆騎", steps: [{ duration_min: 60 }], purpose: "", success: "", fallback: null },
      { date: "2026-10-11", kind: "strength", title: "明天的肌力", steps: [{ duration_min: 30 }], purpose: "", success: "", fallback: null },
    ],
  );
  const [strength, easy, ride, tomorrow] = await made.coach.db.getPlannedSessions(planId);
  return { ...made, planId, strength: strength!, easy: easy!, ride: ride!, tomorrow: tomorrow! };
}

const report = (partial: Partial<Parameters<typeof reportSession>[3]> = {}) => ({
  completion: "done" as const,
  duration_min: 30,
  distance_km: null,
  perceived_effort: 5,
  subjective_notes: null,
  ...partial,
});

describe("沒有紀錄的課的回報（規格 12.48）", () => {
  it("肌力：存成一筆手動的活動，連到那堂課；比對、紀錄、負荷、教練都讀得到；課上記下回報了", async () => {
    const { coach, strength } = await withPlan();
    const text = await coach.reportSession(strength.id, report({ completion: "partial", duration_min: 25, perceived_effort: 6, subjective_notes: "  棒式撐不到 30 秒  " }));
    expect(text).toContain("做了一部分、25 分鐘、體感 6/10、備註：棒式撐不到 30 秒");

    // 紀錄：其他運動的一筆，來源是手動，體感與備註在裡面
    const [record] = await coach.db.getActivities(7);
    expect(record).toMatchObject({ sport: "strength", source: "manual", duration_min: 25, perceived_effort: 6, subjective_notes: "棒式撐不到 30 秒" });
    expect(record!.key).toMatch(/^o:manual:[0-9a-f]{32}$/);
    // 負荷：時間 × 體感（sRPE）
    expect(loadOf(record!, "strength", { hr: {}, restHr: 60, thresholdPaceSec: null })).toMatchObject({ source: "rpe" });

    // 比對：以選手說的為準（做了一部分），結果帶備註
    const active = await coach.activePlan();
    const view = active!.sessions.find((s) => s.id === strength.id)!;
    expect(view.doneAt).toEqual(expect.any(String));
    expect(view.result).toMatchObject({ outcome: "partial", reasons: ["選手回報做了一部分"], manual: { notes: "棒式撐不到 30 秒" } });
    expect(view.result!.actual).toContain("25 分鐘");
    // 教練：get_training_plan 看得到時間、體感與備註
    const plan = await planTextForTool(coach.db, TODAY, { multisport: true });
    expect(plan).toContain("→ 部分達成：選手回報做了一部分");
    expect(plan).toContain("選手手動回報，備註：棒式撐不到 30 秒");

    // 再回報一次是改原本的那筆（不是多一筆）
    await coach.reportSession(strength.id, report({ completion: "done", duration_min: 32, perceived_effort: 4 }));
    expect(await coach.db.getActivities(7)).toHaveLength(1);
    expect((await coach.activePlan())!.sessions.find((s) => s.id === strength.id)!.result).toMatchObject({ outcome: "achieved", actual: "32 分鐘、體感 4", manual: { notes: null } });

    // 取消回報：紀錄刪掉，課回到沒做
    await coach.unreportSession(strength.id);
    expect(await coach.db.getActivities(7)).toHaveLength(0);
    const after = (await coach.activePlan())!.sessions.find((s) => s.id === strength.id)!;
    expect(after.doneAt).toBeNull();
    expect(after.result!.outcome).toBe("missed");
  });

  it("有改：做了不一樣的課，看板不再問；完成但短很多仍是部分達成", async () => {
    const { coach, strength, ride } = await withPlan();
    await coach.reportSession(strength.id, report({ completion: "changed", subjective_notes: "深蹲改成徒手" }));
    const s = (await coach.activePlan())!.sessions.find((x) => x.id === strength.id)!;
    expect(s.result).toMatchObject({ outcome: "different", reasons: ["選手回報有改"] });
    await coach.reportSession(ride.id, report({ completion: "done", duration_min: 30, distance_km: 12 }));
    const r = (await coach.activePlan())!.sessions.find((x) => x.id === ride.id)!;
    expect(r.result).toMatchObject({ outcome: "partial" });
    expect(r.result!.reasons[0]).toContain("比計畫短");
    expect((await coach.feed()).some((f) => f.id === `plan-different-${ride.id}`)).toBe(false);
    // 騎車記成騎車（紀錄頁的騎車卡片也有）
    expect((await coach.rideCards(7)).map((c) => c.activity.intervals_id)).toEqual([expect.stringMatching(/^manual:/)]);
  });

  it("沒記到的跑步：存成手動的跑步（算跑量），同步的種類是 ma: 不是 mw:；手錶的那趟後來進來時看板問要不要合併", async () => {
    const { coach, driver, easy } = await withPlan();
    await coach.reportSession(easy.id, report({ duration_min: 42, perceived_effort: 3 }));
    const [run] = await coach.db.getRecentWorkouts(7);
    expect(run).toMatchObject({ source: "manual", distance_km: null, duration_min: 42, perceived_effort: 3, completion: "done" });
    expect(run!.session_id).toMatch(/^[0-9a-f]{32}$/);
    const keys = [...(await snapshot(driver)).data.keys()];
    expect(keys.filter((k) => k.startsWith("ma:"))).toHaveLength(1);
    expect(keys.some((k) => k.startsWith("mw:"))).toBe(false);
    expect((await coach.activePlan())!.sessions.find((s) => s.id === easy.id)!.result).toMatchObject({ outcome: "achieved", actual: "42 分鐘、體感 3" });

    // 手錶的紀錄晚到：同一天的另一筆，問是不是同一趟
    const watchId = await coach.db.saveWorkout(activity({ date: "2026-10-09", distance_km: 7.1, duration_min: 43 }));
    const dup = (await coach.feed()).find((f) => f.kind === "duplicate");
    expect(dup?.actions).toContainEqual({ type: "merge", keepId: watchId, dupId: run!.id });
    expect(dup?.detail).toContain("手動回報");
  });

  it("只有沒有手錶紀錄、已經到了、沒跳過的課可以回報；欄位檢查", async () => {
    const { coach, easy, tomorrow, strength } = await withPlan();
    await coach.db.saveWorkout(activity({ date: "2026-10-09", distance_km: 7, duration_min: 40 }));
    await expect(coach.reportSession(easy.id, report())).rejects.toThrow("已經有手錶的紀錄");
    await expect(coach.reportSession(tomorrow.id, report())).rejects.toThrow("還沒到的課");
    await expect(coach.reportSession(strength.id, report({ perceived_effort: 11 }))).rejects.toThrow("體感");
    await expect(coach.reportSession(strength.id, report({ duration_min: 0 }))).rejects.toThrow("花了多久");
    await changeSession(coach.db, TODAY, strength.id, "skip", { reason: "沒空" });
    await expect(coach.reportSession(strength.id, report())).rejects.toThrow("跳過的課");
  });

  it("「回報」分頁列出最近幾天還沒回報、也沒有手錶紀錄的課；回報後不再列", async () => {
    const { coach, strength, easy, ride } = await withPlan();
    expect((await coach.unreportedSessions()).map((s) => [s.id, s.sport, s.minutes])).toEqual([
      [ride.id, "ride", 60],
      [easy.id, "run", 40],
      [strength.id, "strength", 30],
    ]);
    await coach.reportSession(strength.id, report());
    await coach.db.saveWorkout(activity({ date: "2026-10-09", distance_km: 7, duration_min: 40 }));
    expect((await coach.unreportedSessions()).map((s) => s.id)).toEqual([ride.id]);
    // 太久以前的不列
    expect(await unreportedSessions(coach.db, "2026-10-14")).toEqual([]);
  });

  it("舊的「做完了」：取消時連回報的紀錄一起刪", async () => {
    const { coach, strength } = await withPlan();
    await coach.reportSession(strength.id, report());
    await coach.changeSession(strength.id, "undone");
    expect(await coach.db.getActivities(7)).toHaveLength(0);
    await unreportSession(coach.db, strength.id);
  });

  it("去重：手錶的同一趟（同一天、同一種運動）進來後只留手錶的，體感與回報的課帶過去；手錶那筆不見了手動的又出現", async () => {
    const { coach, strength } = await withPlan();
    await coach.reportSession(strength.id, report({ perceived_effort: 7, subjective_notes: "很累" }));
    const watch: OtherActivity = { intervals_id: "i900", date: "2026-10-08", type: "WeightTraining", duration_min: 33, distance_km: null, avg_hr: 110, training_load: 20 };
    await coach.db.upsertOtherActivities([watch]);
    const list = await coach.db.getOtherActivities(7);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ intervals_id: "i900", perceived_effort: 7, subjective_notes: "很累", completion: "done" });
    expect((await coach.activePlan())!.sessions.find((s) => s.id === strength.id)!.result).toMatchObject({ outcome: "achieved", activityId: "i900" });
    // Intervals.icu 刪了那筆：手動的回來
    await coach.db.removeOtherActivitiesMissing([], "2026-10-01", TODAY);
    expect((await coach.db.getOtherActivities(7)).map((a) => a.intervals_id)).toEqual([expect.stringMatching(/^manual:/)]);
    // 不同運動、不同天不合併
    expect(coverManualOthers([{ ...watch, type: "Ride" }, { ...watch, intervals_id: "manual:x", date: "2026-10-08" }])).toHaveLength(2);
  });

  it("同步：整筆一筆 ma:，另一台照樣讀得到；改與刪也帶過去；其他運動的體感不另外送 af:", async () => {
    const a = await withPlan();
    const b = await makeCoach([], { settings: FLAGS });
    const copy = async () => {
      const snap = await snapshot(a.driver);
      const target = await snapshot(b.driver);
      for (const name of [...target.data.keys()].filter((k) => k.startsWith("ma:") && !snap.data.has(k))) await applyEntity(b.driver, name, null, target);
      for (const name of [...snap.data.keys()].filter((k) => k.startsWith("ma:"))) expect(await applyEntity(b.driver, name, snap.data.get(name)!, target)).toBe("applied");
      return snap;
    };
    await a.coach.reportSession(a.strength.id, report({ perceived_effort: 6, subjective_notes: "下雨在家做" }));
    await a.coach.reportSession(a.easy.id, report({ duration_min: 41, distance_km: 6.5 }));
    const snap = await copy();
    expect([...snap.data.keys()].some((k) => k.startsWith("af:manual:"))).toBe(false);
    const strengthEntity = [...snap.data].find(([k, v]) => k.startsWith("ma:") && v.sport === "strength")![1];
    expect(strengthEntity).toMatchObject({ sport: "strength", date: "2026-10-08", duration_min: 30, perceived_effort: 6, subjective_notes: "下雨在家做", completion: "done", session: expect.any(String) });
    expect((await b.coach.db.getActivities(7)).map((r) => [r.sport, r.source, r.duration_min, r.perceived_effort])).toEqual([
      ["run", "manual", 41, 5],
      ["strength", "manual", 30, 6],
    ]);
    // 套用後兩台算出同樣的內容（不會來回互送）
    const bSnap = await snapshot(b.driver);
    for (const [k, v] of snap.data) if (k.startsWith("ma:")) expect(bSnap.data.get(k)).toEqual(v);

    await a.coach.reportSession(a.strength.id, report({ perceived_effort: 3 }));
    await copy();
    expect((await b.coach.db.getActivities(7)).find((r) => r.sport === "strength")!.perceived_effort).toBe(3);
    await a.coach.unreportSession(a.strength.id);
    await a.coach.unreportSession(a.easy.id);
    await copy();
    expect(await b.coach.db.getActivities(7)).toHaveLength(0);
  });

  it("同步：這版看不懂的內容（新版才有的運動）先暫存、不當成刪除；舊版不認得 ma:（isKnown 之外的種類略過）", async () => {
    const { driver } = await makeCoach();
    const snap = await snapshot(driver);
    expect(isKnown("ma:abc")).toBe(true);
    expect(await applyEntity(driver, "ma:abc", { sport: "hike", date: TODAY, duration_min: 30, perceived_effort: 4 }, snap)).toBe("pending");
    expect(await applyEntity(driver, "ma:abd", { sport: "run", date: TODAY, duration_min: 30, perceived_effort: 4, session: null }, snap)).toBe("pending");
    expect(await applyEntity(driver, "zz:new", { x: 1 }, snap)).toBe("applied");
  });

  it("教練：report_session 記下（沒說時間用課表的），開關關著時沒有這個工具；騎車找不到同步的那趟時指向 report_session", async () => {
    expect(buildTools({ ...DEFAULT_SETTINGS, features: ["multisport"] }).some((t) => t.name === "report_session")).toBe(false);
    const tools = buildTools({ ...DEFAULT_SETTINGS, ...FLAGS });
    expect(tools.some((t) => t.name === "report_session")).toBe(true);
    expect(tools.find((t) => t.name === "update_planned_session")!.description).toContain("report_session");

    // 新的資料庫裡第一堂課的 id 是 1
    const scripted = await makeCoach(
      [
        toolTurn("report_session", { session_id: 1, completion: "partial", perceived_effort: 5, subjective_notes: "棒式少做一組" }),
        toolTurn("save_activity_feedback", { date: TODAY, sport: "ride", perceived_effort: 4 }, "call_2"),
        turn({ text: "記下了。" }),
      ],
      { settings: FLAGS },
    );
    await scripted.coach.db.saveStructuredPlan(
      { weekLabel: "W41", weekStart: WEEK, style: "fixed", reason: "r", outline: null, notes: null, content: "" },
      [{ date: "2026-10-08", kind: "strength", title: "輕度肌力", steps: [{ duration_min: 30 }], purpose: "", success: "", fallback: null }],
    );
    expect((await scripted.coach.db.getPlannedSession(1))?.title).toBe("輕度肌力");
    await scripted.coach.chat("肌力做完了，體感 5，棒式少做一組");
    expect(scripted.provider.calls[1]!.toolResults![0]!.content).toContain("做了一部分、30 分鐘、體感 5/10、備註：棒式少做一組");
    expect(scripted.provider.calls[2]!.toolResults![0]!.content).toContain("改用 report_session");
    expect((await scripted.coach.db.getActivities(7))[0]).toMatchObject({ sport: "strength", source: "manual", perceived_effort: 5, subjective_notes: "棒式少做一組" });
  });

  it("schema 21 的資料庫升級：補上 22 的欄位，原有的內容不變", async () => {
    const driver = openNodeSqlite(":memory:");
    const clock = { now: () => new Date("2026-10-10T04:00:00Z"), today: () => TODAY };
    const db = new Db(driver, clock);
    await db.init();
    await db.upsertOtherActivities([{ intervals_id: "i1", date: TODAY, type: "Ride", duration_min: 60, distance_km: 20, avg_hr: 120, training_load: 40 }]);
    await driver.exec(`
      ALTER TABLE workouts DROP COLUMN session_id;
      ALTER TABLE workouts DROP COLUMN completion;
      ALTER TABLE other_activities DROP COLUMN session_id;
      ALTER TABLE other_activities DROP COLUMN completion;
      ALTER TABLE other_activities DROP COLUMN updated_at;
      PRAGMA user_version = 21;
    `);
    const again = new Db(driver, clock);
    await again.init();
    const [row] = await driver.all("PRAGMA user_version");
    expect(row?.user_version).toBe(22);
    expect(await again.getOtherActivities(7)).toEqual([expect.objectContaining({ intervals_id: "i1", session_id: null, completion: null })]);
  });

  it("matchWeek：連到課的那筆優先於同一天的其他紀錄", () => {
    const sessions = [
      { id: 1, plan_id: 1, position: 0, date: "2026-10-08", kind: "strength" as const, title: "肌力", steps: [{ duration_min: 30 }], purpose: "", success: "", fallback: null, status: "planned" as const, note: null, sync_id: "s1" },
    ];
    const others: OtherActivity[] = [
      { intervals_id: "i1", date: "2026-10-08", type: "WeightTraining", duration_min: 30, distance_km: null, avg_hr: null, training_load: null },
      { intervals_id: "manual:m1", date: "2026-10-08", type: "WeightTraining", duration_min: 20, distance_km: null, avg_hr: null, training_load: null, session_id: "s1", completion: "partial" },
    ];
    const ctx = { values: { hr: null } } as never;
    const m = matchWeek(sessions as never, [], others, WEEK, TODAY, ctx);
    expect(m.results.get(1)).toMatchObject({ activityId: "manual:m1", outcome: "partial" });
    expect(m.extraOthers.map((o) => o.intervals_id)).toEqual(["i1"]);
  });
});
