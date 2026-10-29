import { describe, expect, it } from "vitest";

import { addDays, adherenceText, ATHLETE_ADJUST_NOTE, isoWeekLabel, isoWeekStart, pastPlanWeeks, recentAdherence, type Db, type PastSession, type PastWeek } from "../src";
import type { SessionDraft } from "../src/plan";
import { ContextManager } from "../src/context";
import { DEFAULT_SETTINGS } from "../src";
import { activity, makeCoach, NOW } from "./helpers";

// makeCoach 的今天是 2026-10-10（星期六）；這週的週一是 10/5，最近 4 週是 9/7 – 10/4
const TODAY = "2026-10-10";

const easy = (date: string | null, title = "輕鬆跑"): SessionDraft => ({
  date,
  kind: "easy",
  title,
  steps: [{ duration_min: 50, target: { hr: "easy" } }],
  purpose: "",
  success: "",
  fallback: null,
});
const long = (date: string): SessionDraft => ({ ...easy(date, "長跑"), kind: "long", steps: [{ distance_km: 16, target: { pace: "E" } }] });
const tempo = (date: string): SessionDraft => ({
  ...easy(date, "閾值"),
  kind: "threshold",
  steps: [{ duration_min: 15, target: { hr: "easy" } }, { duration_min: 20, target: { pace: "T" } }, { duration_min: 10, target: { hr: "easy" } }],
  fallback: "改成 40 分鐘輕鬆跑",
});
const ride = (date: string): SessionDraft => ({ ...easy(date, "耐力騎"), kind: "ride_endurance", sport: "ride", steps: [{ duration_min: 60, target: { hr: "easy" } }] });

async function savePlan(db: Db, weekStart: string, sessions: SessionDraft[]): Promise<number[]> {
  const meta = { weekLabel: isoWeekLabel(weekStart), weekStart, style: "fixed" as const, reason: "測試", outline: null, notes: null, content: "" };
  const id = await db.saveStructuredPlan(meta, sessions);
  return (await db.getPlannedSessions(id)).map((s) => s.id);
}

let seq = 0;
const runOn = (db: Db, date: string, km = 10, minutes = 55) =>
  db.saveWorkout(activity({ intervals_id: `r${++seq}`, date, distance_km: km, duration_min: minutes, raw_json: JSON.stringify({ id: `r${seq}` }) }));

describe("ISO 週標籤的週一", () => {
  it("一般的週、跨年的週、格式不對", () => {
    expect(isoWeekStart("2026-W41")).toBe("2026-10-05");
    expect(isoWeekStart(isoWeekLabel("2026-10-28"))).toBe("2026-10-26");
    expect(isoWeekStart("2021-W01")).toBe("2021-01-04");
    expect(isoWeekStart("2026-W01")).toBe("2025-12-29");
    expect(isoWeekStart("下週")).toBeNull();
  });
});

describe("之前的週（課表頁）", () => {
  it("沒有課表時是空的", async () => {
    const { coach } = await makeCoach();
    expect(await pastPlanWeeks(coach.db, TODAY)).toEqual({ weeks: [], more: false });
    expect(await recentAdherence(coach.db, TODAY)).toBeNull();
  });

  it("只列這週以前、有課表的週，新的在前；跨月的週；計畫與實際的總量；沒跑的是灰的沒做（不是 pending）", async () => {
    const { coach } = await makeCoach();
    const db = coach.db;
    await savePlan(db, "2026-09-21", [easy("2026-09-22"), long("2026-09-27")]);
    await savePlan(db, "2026-09-28", [easy("2026-09-29"), tempo("2026-10-01"), long("2026-10-04"), { ...easy(null, "任一天的輕鬆跑") }]);
    // 這週（時間軸上）
    await savePlan(db, "2026-10-05", [easy("2026-10-06")]);
    await runOn(db, "2026-09-22");
    await runOn(db, "2026-09-29", 9, 50);
    await runOn(db, "2026-10-04", 16.4, 98);

    const { weeks, more } = await pastPlanWeeks(db, TODAY);
    expect(more).toBe(false);
    expect(weeks.map((w) => w.weekStart)).toEqual(["2026-09-28", "2026-09-21"]);
    const w = weeks[0]!;
    expect(w.range).toBe("9/28 – 10/4");
    expect(w.unit).toBe("km");
    expect(w.actual).toMatchObject({ km: 25.4, runs: 2 });
    expect(w.planned!.km).toBeGreaterThan(30);
    const byTitle = Object.fromEntries(w.sessions.map((s) => [s.title, s]));
    expect(byTitle["閾值"]!.outcome).toBe("missed");
    expect(byTitle["任一天的輕鬆跑"]!.outcome).toBe("missed");
    expect(byTitle["長跑"]!.workoutId).not.toBeNull();
    expect(weeks[1]!.sessions.map((s) => s.outcome)).toEqual(["achieved", "missed"]);
  });

  it("先列 8 週，再看更早的；文字課表的週只有實際的總量；同一週有結構化的時不列文字的", async () => {
    const { coach } = await makeCoach();
    const db = coach.db;
    for (let i = 1; i <= 9; i++) await savePlan(db, addDays("2026-10-05", -7 * i), [easy(addDays("2026-10-06", -7 * i))]);
    await db.saveTrainingPlan("2026-W30", "週二輕鬆跑、週六長跑");
    await db.saveTrainingPlan(isoWeekLabel("2026-09-28"), "被結構化的蓋過");
    // 啟用中的課表是這週的
    await savePlan(db, "2026-10-05", [easy("2026-10-06")]);
    await runOn(db, "2026-07-21", 8, 45);

    const first = await pastPlanWeeks(db, TODAY);
    expect(first.weeks).toHaveLength(8);
    expect(first.more).toBe(true);
    expect(first.weeks[0]!.text).toBe(false);
    const all = await pastPlanWeeks(db, TODAY, { limit: 16 });
    expect(all.more).toBe(false);
    expect(all.weeks).toHaveLength(10);
    const text = all.weeks.at(-1)!;
    expect(text).toMatchObject({ weekStart: "2026-07-20", text: true, sessions: [], planned: null, actual: { km: 8, runs: 1 } });
  });

  it("時間軸上顯示的是舊的週時不重複列", async () => {
    const { coach } = await makeCoach();
    await savePlan(coach.db, "2026-09-21", [easy("2026-09-22")]);
    await savePlan(coach.db, "2026-09-28", [easy("2026-09-29")]);
    // 最新的課表停在 9/28 那週：課表頁的時間軸顯示它
    expect((await pastPlanWeeks(coach.db, TODAY)).weeks.map((w) => w.weekStart)).toEqual(["2026-09-21"]);
  });

  it("多運動：開著時騎車的課一起列、總量寫時間；關著時只列跑步", async () => {
    const { coach } = await makeCoach();
    const db = coach.db;
    await savePlan(db, "2026-09-28", [easy("2026-09-29"), ride("2026-09-30")]);
    await savePlan(db, "2026-10-05", [easy("2026-10-06")]);
    await db.upsertOtherActivities([
      { intervals_id: "b1", date: "2026-09-30", type: "Ride", duration_min: 62, distance_km: 25, avg_hr: 125, training_load: 50, raw_json: null } as never,
    ]);
    await runOn(db, "2026-09-29", 8, 48);
    const on = (await pastPlanWeeks(db, TODAY, { multisport: true })).weeks[0]!;
    expect(on.sessions.map((s) => s.kind)).toEqual(["easy", "ride_endurance"]);
    expect(on.unit).toBe("time");
    expect(on.actual).toMatchObject({ minutes: 110, others: 1 });
    expect(on.sessions[1]!.activityId).toBe("b1");
    const off = (await pastPlanWeeks(db, TODAY)).weeks[0]!;
    expect(off.sessions.map((s) => s.kind)).toEqual(["easy"]);
    expect(off.unit).toBe("km");
  });
});

const past = (partial: Partial<PastSession> & Pick<PastSession, "kind" | "outcome">): PastSession => ({
  id: 1,
  date: null,
  kindLabel: "",
  title: "",
  isRun: true,
  sport: null,
  reasons: [],
  difficulty: null,
  actual: null,
  workoutId: null,
  activityId: null,
  byAthlete: false,
  ...partial,
});
const week = (weekStart: string, sessions: PastSession[], text = false): PastWeek => ({
  weekStart,
  range: "",
  text,
  sessions,
  planned: text ? null : { km: 0, minutes: 0 },
  actual: { km: 0, minutes: 0, runs: 0, others: 0 },
  unit: "km",
});

describe("最近 4 週的摘要（給教練）", () => {
  it("沒有一堂一堂的課表（只有文字課表）時沒有摘要", () => {
    expect(adherenceText([week("2026-09-28", [], true)], "2026-09-07", "2026-10-04")).toBeNull();
    expect(adherenceText([], "2026-09-07", "2026-10-04")).toBeNull();
  });

  it("各種課的結果、同一個星期幾一直沒做、選手自己跳過或改用替代；跨月的日期", () => {
    // 週三（9/9、9/16、9/23、9/30）的閾值 4 週沒做到 3 次
    const weds = ["2026-09-09", "2026-09-16", "2026-09-23", "2026-09-30"];
    const weeks = weds.map((d, i) =>
      week(addDays(d, -2), [
        past({ kind: "threshold", date: d, outcome: i === 0 ? "achieved" : i === 1 ? "skipped" : "missed", byAthlete: i === 1 }),
        past({ kind: "long", date: addDays(d, 4), outcome: i % 2 ? "partial" : "achieved" }),
        past({ kind: "easy", date: addDays(d, -1), outcome: i === 3 ? "fallback" : "achieved", byAthlete: i === 3 }),
      ]),
    );
    const text = adherenceText(weeks, "2026-09-07", "2026-10-04")!;
    expect(text.split("\n")).toEqual([
      "【最近 4 週照課表的情形】（9/7 – 10/4，程式依手錶紀錄比對；4 週都有課表）",
      "・輕鬆跑 4 堂：做了 3、改用替代 1",
      "・長跑 4 堂：做了 2、部分 2",
      "・T 閾值 4 堂：做了 1、跳過 1、沒做 2",
      "・週三的課：4 週排了 4 次，沒做到 3 次（跳過 1、沒做 2）",
      "・選手自己在課表頁跳過 1 次、改用替代 1 次",
    ]);
  });

  it("沒做到一次不提；文字課表的週另外寫；混合運動", () => {
    const weeks = [
      week("2026-09-28", [past({ kind: "easy", date: "2026-09-29", outcome: "missed" }), past({ kind: "ride_endurance", date: "2026-10-01", outcome: "achieved", isRun: false, sport: "ride" })]),
      week("2026-09-21", [], true),
    ];
    expect(adherenceText(weeks, "2026-09-07", "2026-10-04")!.split("\n")).toEqual([
      "【最近 4 週照課表的情形】（9/7 – 10/4，程式依手錶紀錄比對；4 週裡 1 週有一堂一堂的課表、1 週是文字課表（沒有比對））",
      "・輕鬆跑 1 堂：沒做 1",
      "・耐力騎 1 堂：做了 1",
    ]);
  });

  it("從資料庫算：只看這週以前的 4 個整週；選手在計畫頁跳過的算進去；系統提示的會變那一段看得到、固定段沒有", async () => {
    const { coach } = await makeCoach();
    const db = coach.db;
    const [, wed] = await savePlan(db, "2026-09-28", [easy("2026-09-29"), tempo("2026-09-30")]);
    await db.updatePlannedSession(wed!, { status: "skipped", note: ATHLETE_ADJUST_NOTE });
    await savePlan(db, "2026-08-24", [easy("2026-08-25")]); // 超過 4 週
    await savePlan(db, "2026-10-05", [tempo("2026-10-07")]); // 這週
    await runOn(db, "2026-09-29", 9, 50);
    const text = (await recentAdherence(db, TODAY))!;
    expect(text).toContain("4 週裡 1 週有一堂一堂的課表");
    expect(text).toContain("・輕鬆跑 1 堂：做了 1");
    expect(text).toContain("・T 閾值 1 堂：跳過 1");
    expect(text).toContain("・選手自己在課表頁跳過 1 次");

    const parts = await new ContextManager(db, { ...DEFAULT_SETTINGS }, () => NOW).buildSystemParts();
    expect(parts.dynamic).toContain("【最近 4 週照課表的情形】");
    expect(parts.stable).not.toContain("4 週裡");
    expect(parts.stable).toContain("不要責備選手");
  });
});
