import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { Db, duplicateGroups, raceOutcome, raceStatusText, similarRaces, type Race } from "../src";
import { estimateVdot } from "../src/training-values";
import { activity, makeCoach, toolTurn, turn } from "./helpers";

const TODAY = "2026-10-10";
const clock = { now: () => new Date("2026-10-10T04:00:00Z"), today: () => TODAY };

const race = (partial: Partial<Race> = {}): Race => ({
  id: 1,
  name: "半馬",
  date: "2026-11-01",
  distance_km: 21.1,
  target_time: null,
  confirmed: 1,
  result_time: null,
  notes: null,
  cancelled: 0,
  outcome: null,
  outcome_reason: null,
  created_at: "x",
  ...partial,
});

describe("race rules", () => {
  it("upgrades schema 10: cancelled becomes not started, results become finished", async () => {
    const driver = openNodeSqlite(":memory:");
    await driver.exec(`
      CREATE TABLE races (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, date TEXT NOT NULL,
        distance_km REAL NOT NULL, target_time TEXT, confirmed INTEGER DEFAULT 1,
        result_time TEXT, notes TEXT, created_at TEXT NOT NULL, cancelled INTEGER DEFAULT 0);
      INSERT INTO races (name, date, distance_km, created_at, cancelled, result_time, notes) VALUES
        ('取消的', '2026-09-01', 10, 'x', 1, NULL, '感冒'),
        ('完賽的', '2026-09-08', 10, 'x', 0, '48:00', NULL),
        ('還沒比', '2026-11-01', 21.1, 'x', 0, NULL, NULL);
    `);
    const db = new Db(driver, clock);
    await db.init();
    const rows = await driver.all("SELECT name, outcome, outcome_reason, notes FROM races ORDER BY id");
    expect(rows).toEqual([
      { name: "取消的", outcome: "dns", outcome_reason: "other", notes: "感冒" },
      { name: "完賽的", outcome: "finished", outcome_reason: null, notes: null },
      { name: "還沒比", outcome: null, outcome_reason: null, notes: null },
    ]);
  });

  it("derives the outcome for rows without one and describes the status", () => {
    expect(raceOutcome(race())).toBeNull();
    expect(raceOutcome(race({ cancelled: 1 }))).toBe("dns");
    expect(raceOutcome(race({ result_time: "1:50:00" }))).toBe("finished");
    expect(raceStatusText(race(), TODAY)).toBe("還有 22 天");
    expect(raceStatusText(race({ confirmed: 0, date: TODAY }), TODAY)).toBe("今天（考慮中）");
    expect(raceStatusText(race({ date: "2026-10-03" }), TODAY)).toBe("7 天前，還沒記錄成績");
    expect(raceStatusText(race({ outcome: "finished", result_time: "1:50:00" }), TODAY)).toBe("完賽 1:50:00");
    expect(raceStatusText(race({ outcome: "dnf", outcome_reason: "抽筋" }), TODAY)).toBe("沒有完賽（抽筋）");
    expect(raceStatusText(race({ outcome: "dns", outcome_reason: "event_cancelled" }), TODAY)).toBe("沒有出賽（賽事取消）");
  });

  it("finds races on the same day with a similar distance", () => {
    const races = [race({ id: 1 }), race({ id: 2, distance_km: 21.0975 }), race({ id: 3, distance_km: 10 }), race({ id: 4, date: "2026-11-02" })];
    expect(similarRaces(races, { date: "2026-11-01", distance_km: 21.1 }, 1).map((r) => r.id)).toEqual([2]);
    expect(duplicateGroups(races).map((g) => g.map((r) => r.id))).toEqual([[1, 2]]);
  });

  it("only counts finished races for training paces", () => {
    const base = { date: "2026-09-20", distance_km: 10, result_time: "40:00" };
    expect(estimateVdot([race({ ...base, outcome: "dnf" })], null, TODAY)).toBeNull();
    expect(estimateVdot([race({ ...base, outcome: "finished" })], null, TODAY)?.kind).toBe("race");
  });
});

describe("Coach race actions", () => {
  it("lets everything change before the race, only name and notes after", async () => {
    const { coach } = await makeCoach([]);
    const future = await coach.db.addRace({ name: "半馬", date: "2026-11-01", distance_km: 21.1 });
    await coach.editRace(future, { date: "2026-11-02", distance_km: 21.0975, target_time: "1:50:00" });
    expect(await coach.db.getRace(future)).toMatchObject({ date: "2026-11-02", target_time: "1:50:00" });

    const past = await coach.db.addRace({ name: "10K", date: "2026-10-04", distance_km: 10 });
    await expect(coach.editRace(past, { date: "2026-10-05" })).rejects.toThrow("只能改名稱與備註（不能改：date）");
    await coach.editRace(past, { name: "城市 10K", notes: "風很大" });
    expect(await coach.db.getRace(past)).toMatchObject({ name: "城市 10K", notes: "風很大", date: "2026-10-04" });

    // 已經有結局的，比賽日還沒到也算賽後
    await coach.markRaceNotStarted(future, "conflict");
    await expect(coach.editRace(future, { target_time: "1:45:00" })).rejects.toThrow("只能改名稱與備註");
  });

  it("records results only from race day, and can change them", async () => {
    const { coach } = await makeCoach([]);
    const future = await coach.db.addRace({ name: "半馬", date: "2026-11-01", distance_km: 21.1 });
    await expect(coach.recordRaceResult(future, { outcome: "finished", time: "1:50:00" })).rejects.toThrow("還沒到比賽日");

    const id = await coach.db.addRace({ name: "10K", date: TODAY, distance_km: 10 });
    await expect(coach.recordRaceResult(id, { outcome: "finished", time: "很快" })).rejects.toThrow("看不懂這個成績");
    expect(await coach.recordRaceResult(id, { outcome: "finished", time: "0:48:05" })).toMatchObject({ outcome: "finished", result_time: "48:05" });
    expect(await coach.recordRaceResult(id, { outcome: "dnf", note: "抽筋" })).toMatchObject({ outcome: "dnf", outcome_reason: "抽筋", result_time: null });
    expect(await coach.recordRaceResult(id, { outcome: "finished", time: "48:30" })).toMatchObject({ outcome: "finished", result_time: "48:30", cancelled: 0 });
    await expect(coach.markRaceNotStarted(id, "other")).rejects.toThrow("已經記錄完賽成績");
  });

  it("marks a race as not started with a reason and keeps the record", async () => {
    const { coach } = await makeCoach([]);
    const id = await coach.db.addRace({ name: "全馬", date: "2026-12-20", distance_km: 42.195, notes: "第一場全馬" });
    await expect(coach.markRaceNotStarted(id, "tired")).rejects.toThrow("原因只能是");
    const saved = await coach.markRaceNotStarted(id, "injury", "右膝");
    expect(saved).toMatchObject({ outcome: "dns", outcome_reason: "injury", cancelled: 1, notes: "第一場全馬；右膝" });
    expect(await coach.db.getUpcomingRaces(90)).toEqual([]);
    expect(await coach.deleteRace(id)).toBe(true);
  });

  it("finds the watch activity of race day by distance and uses elapsed time", async () => {
    const { coach } = await makeCoach([]);
    const id = await coach.db.addRace({ name: "半馬", date: "2026-10-04", distance_km: 21.1 });
    expect(await coach.raceActivity(id)).toBeNull();
    await coach.db.saveWorkout(activity({ intervals_id: "warmup", date: "2026-10-04", distance_km: 2.1, duration_min: 12 }));
    await coach.db.saveWorkout(
      activity({ intervals_id: "race", date: "2026-10-04", distance_km: 21.3, duration_min: 113, raw_json: JSON.stringify({ elapsed_time: 6942, moving_time: 6780 }) }),
    );
    expect(await coach.raceActivity(id)).toEqual({ time: "1:55:42", distanceKm: 21.3, workoutId: expect.any(Number) });
  });
});

describe("race tools", () => {
  it("lists every race the runner sees, flags duplicates, and the prompt points to it", async () => {
    const { coach, provider } = await makeCoach([toolTurn("list_races", {}), turn({ text: "好" })]);
    await coach.db.addRace({ name: "去年的半馬", date: "2025-03-01", distance_km: 21.1 });
    const a = await coach.db.addRace({ name: "城市 10K", date: "2026-09-20", distance_km: 10 });
    const b = await coach.db.addRace({ name: "城市10K", date: "2026-09-20", distance_km: 10 });
    await coach.recordRaceResult(a, { outcome: "finished", time: "45:00" });
    await coach.recordRaceResult(b, { outcome: "finished", time: "45:00" });
    await coach.chat("我有哪些比賽");
    const out = provider.calls[1]!.toolResults![0]!.content;
    expect(out).toContain("- [1] 2025-03-01 去年的半馬 21.1km｜目標 完賽｜");
    expect(out).toContain("｜完賽 45:00");
    expect(out).toContain("看起來重複的（同一天、距離相近）：[2]、[3]");
    expect(out).toContain("你不能刪除賽事");
    expect(provider.calls[0]!.request.system).toContain("都可以用 list_races 查");
    expect(provider.calls[0]!.request.tools!.map((t) => t.name)).not.toContain("delete_race");
  });

  it("asks before adding a race that looks like a duplicate", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("add_race", { name: "萬金石", date: "2026-11-01", distance_km: 42.195 }),
      toolTurn("add_race", { name: "萬金石馬拉松", date: "2026-11-01", distance_km: 42.2 }),
      toolTurn("add_race", { name: "萬金石馬拉松", date: "2026-11-01", distance_km: 42.2, confirm_duplicate: true }),
      turn({ text: "好" }),
    ]);
    await coach.chat("幫我記下萬金石");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toBe("賽事已新增（id=1）：2026-11-01 萬金石");
    expect(results[1]).toContain("尚未新增：同一天已有距離相近的賽事");
    expect(results[1]).toContain("- [1] 2026-11-01 萬金石 42.195km");
    expect(results[2]).toBe("賽事已新增（id=2）：2026-11-01 萬金石馬拉松");
  });

  it("checks the watch and needs the runner's confirmation before recording a result", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("record_race_result", { race_id: 1, outcome: "finished", result_time: "1:55:42" }),
      toolTurn("get_race_activity", { race_id: 1 }),
      toolTurn("record_race_result", { race_id: 1, outcome: "finished", result_time: "1:55:30", athlete_confirmed: true }),
      toolTurn("update_race", { race_id: 1, date: "2026-10-05" }),
      toolTurn("mark_race_not_started", { race_id: 1, reason: "other" }),
      turn({ text: "好" }),
    ]);
    await coach.db.addRace({ name: "半馬", date: "2026-10-04", distance_km: 21.1 });
    await coach.db.saveWorkout(activity({ intervals_id: "race", date: "2026-10-04", distance_km: 21.3, raw_json: JSON.stringify({ elapsed_time: 6942 }) }));
    await coach.chat("半馬跑完了");
    const results = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(results[0]).toContain("尚未記錄：先用 get_race_activity 查手錶紀錄");
    expect(results[1]).toContain("當天的手錶紀錄：21.3 km，總時間 1:55:42");
    expect(results[2]).toBe("已記錄「半馬」完賽成績：1:55:30。");
    expect(results[3]).toContain("執行失敗：「半馬」已經是賽後，只能改名稱與備註");
    expect(results[4]).toContain("執行失敗：「半馬」已經記錄完賽成績");
  });
});
