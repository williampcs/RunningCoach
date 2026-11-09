import { describe, expect, it } from "vitest";
import { fakeFit } from "../../../tools/lib/fit-fixture";
import { dataSourcesOf, importActivities, previewImport, previewSummaryText, importRecordOf, importSummaryText, parseFit, scanSummaryText, type OtherActivity } from "../src";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { activity, makeCoach } from "./helpers";

// makeCoach 的今天是 2026-10-10；這趟是當地（+8）2026-10-10 06:30 開始的 20 分鐘
const START = Date.UTC(2026, 9, 9, 22, 30) / 1000;
const parsed = (o: Parameters<typeof fakeFit>[0] = {}) => parseFit(fakeFit({ start: START, records: 1200, ...o }))[0]!;
/** Intervals.icu 的同一趟（開始時間差 20 秒） */
const intervalsRun = (id = "i200") =>
  activity({
    intervals_id: id,
    date: "2026-10-10",
    distance_km: 3.6,
    duration_min: 20,
    raw_json: JSON.stringify({ id, start_date_local: "2026-10-10T06:30:20", elapsed_time: 1200, icu_training_load: 30, source: "GARMIN_CONNECT", device_name: "Garmin Forerunner 265" }),
  });
const intervalsRide = (id: string, startLocal: string): OtherActivity => ({
  intervals_id: id,
  date: startLocal.slice(0, 10),
  type: "Ride",
  duration_min: 20,
  distance_km: 3.6,
  avg_hr: 140,
  training_load: 25,
  raw_json: JSON.stringify({ id, type: "Ride", start_date_local: startLocal, elapsed_time: 1200 }),
});

describe("匯入檔案存進資料庫（規格 12.40）", () => {
  it("跑步：新增成一般的紀錄（來源是檔案）、同一個檔再匯一次不會變兩筆、教練看得到", async () => {
    const { coach } = await makeCoach();
    const counts = await importActivities(coach.db, [parsed({ productName: "Forerunner 265" })]);
    expect(counts).toMatchObject({ added: 1, existing: 0, merged: 0 });
    const [w] = await coach.db.getRecentWorkouts(14);
    expect(w).toMatchObject({ source: "file", date: "2026-10-10", distance_km: 3.6, avg_hr: 143 });
    expect(w!.sync_id).toMatch(/^[0-9a-f]{32}$/);
    const records = await coach.db.getActivities(14);
    expect(records[0]).toMatchObject({ source: "file", sport: "run" });
    expect(records[0]!.details.garmin).toBe("Garmin Forerunner 265");
    expect(dataSourcesOf(records)).toEqual(["Garmin"]);
    expect((await importActivities(coach.db, [parsed()])).existing).toBe(1);
    expect(await coach.db.countWorkouts()).toBe(1);
  });

  it("負荷照現有的規則估（有心率 → 依心率估）", async () => {
    const { coach } = await makeCoach();
    await importActivities(coach.db, [parsed()]);
    const [w] = await coach.db.getRecentWorkouts(14);
    expect(w!.training_load).toBeNull();
    const records = await coach.db.getActivities(14);
    const { loadOf } = await import("../src/load");
    expect(loadOf(records[0]!, "run", { hr: { run: { maxHr: 190, lthr: 170 } }, restHr: 55, thresholdPaceSec: null })?.source).toBe("hr");
  });

  it("和 Intervals.icu 的同一趟：先有 Intervals.icu 的 → 合併（留 Intervals.icu 的）；先匯檔案 → 同步進來時一樣留 Intervals.icu 的", async () => {
    const a = (await makeCoach()).coach;
    await a.db.saveWorkout(intervalsRun());
    expect(await importActivities(a.db, [parsed()])).toMatchObject({ added: 0, merged: 1 });
    expect((await a.db.getRecentWorkouts(14)).map((w) => w.source)).toEqual(["intervals"]);

    const b = (await makeCoach()).coach;
    await importActivities(b.db, [parsed()]);
    const fileId = (await b.db.getRecentWorkouts(14))[0]!.id;
    await b.db.updateWorkoutSubjective(fileId, 4, "很順");
    expect((await b.db.saveWorkoutChecked(intervalsRun())).status).toBe("replaced");
    const [kept] = await b.db.getRecentWorkouts(14);
    expect(kept).toMatchObject({ source: "intervals", perceived_effort: 4, subjective_notes: "很順" });
    expect(await b.db.countWorkouts()).toBe(1);
  });

  it("同步 Intervals.icu 的「來源已刪除」不動匯入的跑步", async () => {
    const { coach } = await makeCoach();
    await importActivities(coach.db, [parsed()]);
    expect(await coach.db.markRemovedMissing([], "2026-10-01", "2026-10-10")).toBe(0);
    expect(await coach.db.countWorkouts()).toBe(1);
  });

  it("手動記的同一天、距離時間很像（沒有開始時間）：新增，算「看板會問」", async () => {
    const { coach } = await makeCoach();
    await coach.db.addManualWorkout({ date: "2026-10-10", distance_km: 3.6, duration_min: 20, perceived_effort: 3, avg_hr: null, subjective_notes: null });
    const counts = await importActivities(coach.db, [parsed()]);
    expect(counts).toMatchObject({ added: 1, maybe: 1 });
    expect(importSummaryText(counts)).toContain("看板上問你");
  });

  it("騎車：存進其他運動；Intervals.icu 已經有同一趟就不存；之後同步進來的同一趟留 Intervals.icu 的（體感搬過去），同步的刪除不動檔案", async () => {
    const { coach } = await makeCoach();
    const ride = parsed({ sport: 2 });
    await coach.db.upsertOtherActivities([intervalsRide("r1", "2026-10-10T06:30:10")]);
    expect(await importActivities(coach.db, [ride])).toMatchObject({ merged: 1, added: 0 });

    const other = (await makeCoach()).coach;
    expect((await importActivities(other.db, [ride])).added).toBe(1);
    const [stored] = await other.db.getOtherActivities(14);
    expect(stored!.intervals_id).toMatch(/^file:/);
    await other.db.setActivityFeedback(stored!.intervals_id, 5, "順");
    // Intervals.icu 沒有這趟：同步的「來源已刪除就刪」不刪檔案的
    await other.db.removeOtherActivitiesMissing([], "2026-10-01", "2026-10-10");
    expect(await other.db.getOtherActivities(14)).toHaveLength(1);
    // 同一趟從 Intervals.icu 進來
    const fromIntervals = intervalsRide("r1", "2026-10-10T06:30:10");
    await other.db.upsertOtherActivities([fromIntervals]);
    expect(await other.db.dropImportedOthersCoveredBy([fromIntervals])).toBe(1);
    const list = await other.db.getOtherActivities(14);
    expect(list.map((o) => o.intervals_id)).toEqual(["r1"]);
    expect(list[0]).toMatchObject({ perceived_effort: 5, subjective_notes: "順" });
  });

  it("不支援的運動、比選的期間舊的：說明裡寫出略過幾個", () => {
    expect(scanSummaryText({ activities: [], files: 5, notActivity: 2, unsupported: new Map([["Walk", 1]]), older: 3, problems: [{ name: "x", reason: "y" }] })).toEqual([
      "略過：3 趟比選的期間舊、1 趟不支援的運動（例如走路、健行）、2 個不是活動的檔（例如每日的健康資料）、1 個讀不了的檔。",
    ]);
    expect(importSummaryText({ added: 3, existing: 1, merged: 2, maybe: 0, failed: 0 })).toBe("新增 3 趟，已經有了 3 趟（其中 2 趟和 Intervals.icu 或之前的紀錄是同一趟）。");
  });

  it("按匯入之前先比對：新的、之前匯入過、和 Intervals.icu 同一趟、可能和手動記的重複；比對不寫入", async () => {
    const { coach } = await makeCoach();
    await coach.db.saveWorkout(intervalsRun());
    await importActivities(coach.db, [parsed({ start: START - 86_400 })]);
    await coach.db.addManualWorkout({ date: "2026-10-08", distance_km: 3.6, duration_min: 20, perceived_effort: 3, avg_hr: null, subjective_notes: null });
    const list = [parsed(), parsed({ start: START - 86_400 }), parsed({ start: START - 2 * 86_400 }), parsed({ start: START - 3 * 86_400 })];
    const before = await coach.db.countWorkouts();
    const preview = await previewImport(coach.db, list);
    expect(preview).toMatchObject({ existing: 1, merged: 1, maybe: 1 });
    expect(preview.fresh.map((a) => a.startLocal.slice(0, 10))).toEqual(["2026-10-08", "2026-10-07"]);
    expect(await coach.db.countWorkouts()).toBe(before);
    expect(previewSummaryText(preview)).toEqual([
      "2 趟是新的，2 趟已經有了（和 Intervals.icu 或之前的紀錄是同一趟）。",
      "其中 1 趟和同一天手動記的很像，匯入後最近 7 天內的會在看板上問你是不是同一趟。",
    ]);
    expect(previewSummaryText({ fresh: [], maybe: 0, existing: 2, merged: 0 })).toEqual(["0 趟是新的，2 趟已經有了（之前匯入過）。"]);
  });

  it("刪掉匯入的那一筆", async () => {
    const { coach } = await makeCoach();
    await importActivities(coach.db, [parsed()]);
    const [w] = await coach.db.getRecentWorkouts(14);
    expect(await coach.db.deleteManualWorkout(w!.id)).toBe(true);
    expect(await coach.db.countWorkouts()).toBe(0);
  });
});

describe("匯入的檔案跟著多裝置同步", () => {
  it("跑步（fw:）與騎車（fo:）整筆帶到另一台；另一台已經有 Intervals.icu 的同一趟時照規則合併；刪除也帶過去", async () => {
    const ma = await makeCoach();
    const mb = await makeCoach();
    await importActivities(ma.coach.db, [parsed(), parsed({ start: START - 86_400, sport: 2 })]);
    const fileRun = (await ma.coach.db.getRecentWorkouts(14))[0]!;
    await ma.coach.db.updateWorkoutSubjective(fileRun.id, 6, "腿有點重");
    const snap = await snapshot(ma.driver);
    const names = [...snap.data.keys()];
    expect(names.filter((n) => n.startsWith("fw:"))).toHaveLength(1);
    expect(names.filter((n) => n.startsWith("fo:"))).toHaveLength(1);
    expect(names.some((n) => n.startsWith("mw:"))).toBe(false);
    const fw = snap.data.get(`fw:${fileRun.sync_id}`)!;
    expect(fw).toMatchObject({ perceived_effort: 6, subjective_notes: "腿有點重" });
    expect(JSON.parse(String(fw.raw_json)).start_date_local).toBe("2026-10-10T06:30:00");

    // b 已經有 Intervals.icu 的同一趟
    await mb.coach.db.saveWorkout(intervalsRun());
    const target = await snapshot(mb.driver);
    for (const [name, data] of snap.data) {
      if (/^(fw|fo):/.test(name)) expect(await applyEntity(mb.driver, name, data, target)).toBe("applied");
    }
    const runs = await mb.coach.db.getRecentWorkouts(14);
    expect(runs.map((w) => w.source)).toEqual(["intervals"]);
    expect(await mb.coach.db.getOtherActivities(14)).toHaveLength(1);
    // 再套一次：不會變兩筆
    for (const [name, data] of snap.data) if (/^(fw|fo):/.test(name)) await applyEntity(mb.driver, name, data, target);
    expect(await mb.coach.db.getOtherActivities(14)).toHaveLength(1);
    const bSnap = await snapshot(mb.driver);
    expect(bSnap.data.has(`fw:${fileRun.sync_id}`)).toBe(true);

    // a 刪掉 → b 跟著刪
    await applyEntity(mb.driver, `fw:${fileRun.sync_id}`, null, bSnap);
    const fo = names.find((n) => n.startsWith("fo:"))!;
    await applyEntity(mb.driver, fo, null, bSnap);
    expect(await mb.coach.db.getOtherActivities(14)).toHaveLength(0);
    expect((await mb.driver.all("SELECT COUNT(*) AS n FROM workouts WHERE source='file'"))[0]!.n).toBe(0);
    void importRecordOf;
  });
});
