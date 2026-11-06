import { describe, expect, it } from "vitest";

import { adherenceSummary, adherenceText, isoWeekLabel, type Db, type PastSession, type PastWeek, type SelfChange } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { easyVersion, shortenSteps, type SessionDraft } from "../src/plan";
import { activePlan, editSessionFromTool } from "../src/planning";
import { activity, makeCoach } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）；這週從 10/5 開始
const TODAY = "2026-10-10";
const WEEK = "2026-10-05";

const base = { purpose: "", success: "", fallback: null };
const long16: SessionDraft = { ...base, date: "2026-10-11", kind: "long", title: "16 km 長跑", steps: [{ distance_km: 16, target: { pace: "E" } }] };
const easyStrides: SessionDraft = {
  ...base,
  date: "2026-10-11",
  kind: "easy",
  title: "輕鬆跑＋加速跑",
  steps: [{ duration_min: 40, target: { hr: "easy" } }, { repeat: 4, steps: [{ duration_min: 1 / 3, target: { rpe: [8, 9] } }, { duration_min: 1 }] }],
};
const intervals: SessionDraft = {
  ...base,
  date: "2026-10-11",
  kind: "interval",
  title: "5×1 km 間歇",
  steps: [
    { duration_min: 15, target: { hr: "easy" } },
    { repeat: 5, steps: [{ distance_km: 1, target: { pace: "I" } }, { duration_min: 2, target: { hr: "easy" } }] },
    { duration_min: 10, target: { hr: "easy" } },
  ],
  fallback: "改成 40 分鐘輕鬆跑",
};
const tempo: SessionDraft = {
  ...base,
  date: "2026-10-11",
  kind: "threshold",
  title: "20 分鐘閾值",
  steps: [{ duration_min: 15, target: { hr: "easy" } }, { duration_min: 20, target: { pace: "T" } }, { duration_min: 10, target: { hr: "easy" } }],
  fallback: "改成 40 分鐘輕鬆跑",
};

describe("改短與換成輕鬆的步驟", () => {
  it("長跑縮短距離；輕鬆跑縮短跑的那段、加速跑不動", () => {
    expect(shortenSteps(long16, 0.75)).toEqual([{ distance_km: 12, target: { pace: "E" } }]);
    expect(shortenSteps(long16, 0.5)).toEqual([{ distance_km: 8, target: { pace: "E" } }]);
    const easy = shortenSteps(easyStrides, 0.5);
    expect(easy[0]).toEqual({ duration_min: 20, target: { hr: "easy" } });
    expect(easy[1]).toEqual(easyStrides.steps[1]);
  });

  it("間歇減少組數（至少 1 組）、節奏縮短主課的時間；暖身與緩和照舊", () => {
    const three = shortenSteps(intervals, 0.75);
    expect(three[0]).toEqual(intervals.steps[0]);
    expect(three[1]).toMatchObject({ repeat: 4 });
    expect(three[2]).toEqual(intervals.steps[2]);
    expect(shortenSteps(intervals, 0.5)[1]).toMatchObject({ repeat: 3 });
    expect(shortenSteps({ ...intervals, steps: [{ repeat: 1, steps: [{ distance_km: 1, target: { pace: "I" } }] }] }, 0.5)[0]).toMatchObject({ repeat: 1 });
    expect(shortenSteps(tempo, 0.5).map((s) => ("duration_min" in s ? s.duration_min : null))).toEqual([15, 10, 10]);
  });

  it("換成輕鬆：跑步是輕鬆跑、騎車是耐力騎，時間不超過原本的", () => {
    expect(easyVersion(tempo, 45)).toMatchObject({ kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], fallback: null });
    expect(easyVersion(tempo, 32).steps).toEqual([{ duration_min: 30, target: { hr: "easy" } }]);
    expect(easyVersion({ ...tempo, kind: "ride_vo2" }, 90)).toMatchObject({ kind: "ride_endurance", sport: "ride", steps: [{ duration_min: 60 }] });
  });
});

async function setup(sessions: SessionDraft[]) {
  const made = await makeCoach();
  const meta = { weekLabel: isoWeekLabel(WEEK), weekStart: WEEK, style: "fixed" as const, reason: "測試", outline: null, notes: null, content: "" };
  const planId = await made.coach.db.saveStructuredPlan(meta, sessions);
  const ids = (await made.coach.db.getPlannedSessions(planId)).map((s) => s.id);
  return { ...made, planId, ids };
}

const sessionOf = async (db: Db, id: number) => (await db.getPlannedSession(id))!;

describe("選手自己改課（規格 12.34 第 3 點 B）", () => {
  it("改短：內容換成改過的、記下原本的；再改一半是原本的一半；原因；比對用改過的內容；恢復", async () => {
    const { coach, ids } = await setup([long16]);
    const id = ids[0]!;
    expect(await coach.selfChangeSession(id, { action: "shorten", ratio: 0.75 })).toContain("已改短到約 3/4");
    let s = await sessionOf(coach.db, id);
    expect(s.steps).toEqual([{ distance_km: 12, target: { pace: "E" } }]);
    expect(s.self_change).toMatchObject({ action: "shorten", ratio: 0.75, reason: null, original: { kind: "long", title: "16 km 長跑" } });
    expect(s.self_change!.km).toBeGreaterThan(15);

    await coach.selfChangeReason(id, "tired");
    await coach.selfChangeSession(id, { action: "shorten", ratio: 0.5 });
    s = await sessionOf(coach.db, id);
    expect(s.steps).toEqual([{ distance_km: 8, target: { pace: "E" } }]);
    expect(s.self_change).toMatchObject({ ratio: 0.5, reason: "tired" });

    // 教練看到的課表寫出自己改過
    const plan = (await activePlan(coach.db, TODAY))!;
    expect(plan.sessions[0]!.selfChange).toMatchObject({ action: "shorten" });

    // 照改過的跑完就是達成（原本的 16 km 跑 8 km 是部分達成）
    await coach.db.saveWorkout(activity({ intervals_id: "r1", date: "2026-10-11", distance_km: 8.1, duration_min: 47, raw_json: JSON.stringify({ id: "r1" }) }));
    expect((await activePlan(coach.db, TODAY))!.sessions[0]!.result?.outcome).toBe("achieved");
    // 已經做了的不能再改
    await expect(coach.selfChangeSession(id, { action: "easy" })).rejects.toThrow("已經做了");
  });

  it("換成輕鬆與恢復；本來就輕鬆的、肌力、今天以前的、跳過的不能改", async () => {
    const strength: SessionDraft = { ...base, date: "2026-10-11", kind: "strength", title: "肌力", steps: [{ duration_min: 20 }] };
    const yesterday: SessionDraft = { ...tempo, date: "2026-10-09" };
    const { coach, ids } = await setup([tempo, easyStrides, strength, yesterday]);
    const [t, e, st, y] = ids as [number, number, number, number];
    await coach.selfChangeSession(t, { action: "easy" });
    expect(await sessionOf(coach.db, t)).toMatchObject({ kind: "easy", title: "輕鬆跑", fallback: null, self_change: { action: "easy", original: { kind: "threshold" } } });

    await coach.changeSession(t, "restore");
    expect(await sessionOf(coach.db, t)).toMatchObject({ kind: "threshold", title: "20 分鐘閾值", steps: tempo.steps, self_change: null });

    await expect(coach.selfChangeSession(e, { action: "easy" })).rejects.toThrow("已經是輕鬆");
    await expect(coach.selfChangeSession(st, { action: "shorten", ratio: 0.5 })).rejects.toThrow("只有跑步與騎車");
    await expect(coach.selfChangeSession(y, { action: "shorten", ratio: 0.5 })).rejects.toThrow("今天以前");
    await expect(coach.selfChangeSession(t, { action: "shorten", ratio: 0.3 })).rejects.toThrow("約 3/4 與一半");
    await coach.changeSession(t, "skip");
    await expect(coach.selfChangeSession(t, { action: "shorten", ratio: 0.5 })).rejects.toThrow("先恢復");
    await expect(coach.selfChangeReason(e, "time")).rejects.toThrow("沒有自己改過");
  });

  it("教練之後改同一堂課：紀錄留著（摘要算得到），但以教練的為準、不能恢復成選手改之前的", async () => {
    const { coach, ids } = await setup([long16]);
    const id = ids[0]!;
    await coach.selfChangeSession(id, { action: "shorten", ratio: 0.5 });
    await editSessionFromTool(coach.db, TODAY, {
      session_id: id,
      reason: "選手說只有一小時",
      session: { kind: "long", title: "10 km 長跑", steps: [{ distance_km: 10, target: { pace: "E" } }], purpose: "", success: "" },
    });
    const s = await sessionOf(coach.db, id);
    expect(s.title).toBe("10 km 長跑");
    expect(s.self_change).not.toBeNull();
    expect((await activePlan(coach.db, TODAY))!.sessions[0]!.selfChange).not.toBeNull();
    await coach.changeSession(id, "restore");
    expect((await sessionOf(coach.db, id)).title).toBe("10 km 長跑");
    expect(await coach.db.getSelfChanges(WEEK, WEEK)).toHaveLength(1);
  });

  it("教練整週重排之後，舊版的紀錄還在（摘要用）", async () => {
    const { coach, ids } = await setup([long16]);
    await coach.selfChangeSession(ids[0]!, { action: "shorten", ratio: 0.75 });
    const meta = { weekLabel: isoWeekLabel(WEEK), weekStart: WEEK, style: "fixed" as const, reason: "重排", outline: null, notes: null, content: "" };
    await coach.db.saveStructuredPlan(meta, [long16]);
    const changes = await coach.db.getSelfChanges(WEEK, WEEK);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ date: "2026-10-11", change: { action: "shorten", original: { kind: "long" } } });
  });

  it("同步到另一台：改過的內容與紀錄；恢復後另一台也清掉", async () => {
    const a = await setup([long16]);
    const b = await makeCoach();
    await a.coach.selfChangeSession(a.ids[0]!, { action: "shorten", ratio: 0.5 });
    await a.coach.selfChangeReason(a.ids[0]!, "time");
    const copy = async () => {
      const snap = await snapshot(a.driver);
      const target = await snapshot(b.driver);
      // 課表先、課後
      const entries = [...snap.data].filter(([k]) => k.startsWith("pl:") || k.startsWith("ps:")).sort(([x], [y]) => x.localeCompare(y));
      for (const [name, data] of entries) expect(await applyEntity(b.driver, name, data, target)).toBe("applied");
    };
    await copy();
    const plan = (await b.coach.db.getActiveTrainingPlan())!;
    const [copied] = await b.coach.db.getPlannedSessions(plan.id);
    expect(copied).toMatchObject({ steps: [{ distance_km: 8, target: { pace: "E" } }], self_change: { action: "shorten", ratio: 0.5, reason: "time" } });

    await a.coach.changeSession(a.ids[0]!, "restore");
    await copy();
    const [restored] = await b.coach.db.getPlannedSessions(plan.id);
    expect(restored).toMatchObject({ title: "16 km 長跑", self_change: null });
  });
});

const change = (kind: SessionDraft["kind"], action: SelfChange["action"], reason: SelfChange["reason"]): SelfChange => ({
  action,
  ratio: action === "shorten" ? 0.75 : null,
  reason,
  at: "2026-10-01T00:00:00Z",
  original: { kind, title: "", steps: [], purpose: "", success: "", fallback: null },
  minutes: 60,
  km: 10,
});
const past = (kind: SessionDraft["kind"], date: string, selfChange: SelfChange | null = null): PastSession => ({
  id: 1,
  date,
  kind,
  kindLabel: "",
  title: "",
  isRun: true,
  sport: null,
  outcome: "achieved",
  reasons: [],
  difficulty: null,
  actual: null,
  workoutId: null,
  activityId: null,
  byAthlete: false,
  selfChange,
});
const week = (weekStart: string, sessions: PastSession[]): PastWeek => ({
  weekStart,
  range: "",
  text: false,
  sessions,
  planned: { km: 0, minutes: 0 },
  actual: { km: 0, minutes: 0, runs: 0, others: 0 },
  unit: "km",
});

describe("摘要：選手自己改的（給教練）", () => {
  const sundays = ["2026-09-13", "2026-09-20", "2026-09-27", "2026-10-04"];
  const weeks = sundays.map((d) => week(d, [past("long", d)]));

  it("同一種課改了 2 次以上才寫，附上原因；只有 1 次不提", () => {
    const two = [
      { date: sundays[0]!, change: change("long", "shorten", "tired") },
      { date: sundays[2]!, change: change("long", "shorten", "tired") },
    ];
    const text = adherenceText(adherenceSummary(weeks, "2026-09-07", "2026-10-04", 4, two)!);
    expect(text).toContain("・長跑 4 次裡自己改短 2 次（太累 2）");
    // 都在週日、都是長跑：不另外寫「週日的課」
    expect(text).not.toContain("週日的課自己");
    const one = adherenceText(adherenceSummary(weeks, "2026-09-07", "2026-10-04", 4, two.slice(0, 1))!);
    expect(one).not.toContain("自己改短");
  });

  it("同一個星期幾換成輕鬆 2 次（不同種類的課）；沒選原因也寫", () => {
    const weds = [
      { date: "2026-09-16", change: change("threshold", "easy", "time") },
      { date: "2026-09-30", change: change("interval", "easy", null) },
    ];
    const summary = adherenceSummary(weeks, "2026-09-07", "2026-10-04", 4, weds)!;
    expect(summary.selfChangeDays).toEqual([{ weekday: 2, action: "easy", count: 2, reasons: { time: 1, none: 1 } }]);
    expect(adherenceText(summary)).toContain("・週三的課自己換成輕鬆 2 次（沒時間 1、沒選原因 1）");
  });

  it("從資料庫算：上週自己改了兩次長跑（太累）時，教練的摘要看得到", async () => {
    const { coach } = await makeCoach();
    for (const ws of ["2026-09-21", "2026-09-28"]) {
      const meta = { weekLabel: isoWeekLabel(ws), weekStart: ws, style: "fixed" as const, reason: "測試", outline: null, notes: null, content: "" };
      const planId = await coach.db.saveStructuredPlan(meta, [{ ...long16, date: `${ws.slice(0, 8)}${String(Number(ws.slice(8)) + 6).padStart(2, "0")}` }]);
      const [s] = await coach.db.getPlannedSessions(planId);
      await coach.db.applySelfChange(s!.id, { ...long16, steps: shortenSteps(long16, 0.75) }, change("long", "shorten", "tired"));
    }
    const { recentAdherence } = await import("../src");
    expect(await recentAdherence(coach.db, TODAY)).toContain("・長跑 2 次裡自己改短 2 次（太累 2）");
  });
});
