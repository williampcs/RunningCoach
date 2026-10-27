import { describe, expect, it } from "vitest";

import { addDays, shortDateLabel, type FeedItem, type WellnessDay } from "../src";
import { activity, makeCoach } from "./helpers";

const TODAY = "2026-10-10"; // 星期六
const kinds = (items: FeedItem[]) => items.map((i) => i.kind);
const normalWeek = (latest: Partial<WellnessDay> = {}): WellnessDay[] =>
  Array.from({ length: 8 }, (_, i) => ({
    date: addDays(TODAY, -7 + i),
    resting_hr: 52,
    hrv: 60,
    hrv_sdnn: null,
    sleep_secs: 7 * 3600,
    sleep_score: null,
    readiness: null,
    ...(i === 7 ? latest : {}),
  }));

// 體感在存檔時另外傳入（saveWorkout 的第二個參數）
const run = (date: string, distance = 8) => activity({ intervals_id: `i-${date}`, date, distance_km: distance });

describe("buildFeed", () => {
  it("asks how the runner feels when nothing else is known", async () => {
    const { coach } = await makeCoach([]);
    const items = await coach.feed();
    expect(items).toEqual([
      expect.objectContaining({ id: `checkin-${TODAY}`, kind: "checkin", tone: "info", actions: [{ type: "checkin" }] }),
    ]);
    // 沒有手錶的恢復資料（例如只用 iPhone）時不提手錶
    expect(items[0]!.detail).toBe("花 10 秒回報精神、痠痛與睡眠。");
  });

  it("mentions what the watch says but asks for the runner's own feeling first", async () => {
    const { coach } = await makeCoach([]);
    await coach.db.upsertWellness(normalWeek({ resting_hr: 59 }));
    const [first] = await coach.feed();
    expect(first!.kind).toBe("checkin");
    expect(first!.detail).toContain("手錶顯示靜息心率比前幾天平均高 7 bpm，但手錶不一定準");
  });

  it("follows the runner's check-in over the watch", async () => {
    const poor = await makeCoach([]);
    await poor.coach.db.upsertWellness(normalWeek());
    await poor.coach.saveCheckin({ energy: 2, soreness: 4, sleep: 3, notes: null });
    const [warn] = await poor.coach.feed();
    expect(warn).toMatchObject({ kind: "recovery", tone: "warn", title: "今天狀況不太好，建議降低強度" });
    expect(warn!.detail).toContain("手錶數據看起來正常，但以你的感受為主");
    expect(warn!.actions[0]).toMatchObject({ type: "ask" });

    const fine = await makeCoach([]);
    await fine.coach.db.upsertWellness(normalWeek({ resting_hr: 59 }));
    await fine.coach.saveCheckin({ energy: 4, soreness: 2, sleep: 4, notes: null });
    const items = await fine.coach.feed();
    expect(items[0]).toMatchObject({ kind: "recovery", tone: "info", title: "手錶的恢復數據偏差，但你自評不錯" });

    const ok = await makeCoach([]);
    await ok.coach.saveCheckin({ energy: 4, soreness: 1, sleep: 4, notes: null });
    expect((await ok.coach.feed())[0]).toMatchObject({ id: `checkin-done-${TODAY}`, tone: "ok" });
  });

  it("reminds about a recent run without a report and a pending report", async () => {
    const { coach } = await makeCoach([]);
    await coach.db.saveWorkout(run(addDays(TODAY, -1), 10));
    await coach.db.savePendingSubjective(TODAY, 6, "還行");
    const items = await coach.feed();
    expect(items.find((i) => i.kind === "report")).toMatchObject({
      title: "昨天的 10 km 還沒回報感受",
      actions: [{ type: "report", workoutId: 1 }],
    });
    expect(items.find((i) => i.kind === "pending")).toMatchObject({ actions: [{ type: "sync" }] });

    const reported = await makeCoach([]);
    await reported.coach.db.saveWorkout(run(TODAY, 10), 6, "順");
    expect(kinds(await reported.coach.feed())).not.toContain("report");
  });

  it("counts down to races and asks for missing results", async () => {
    const { coach } = await makeCoach([]);
    await coach.db.addRace({ name: "城市半馬", date: addDays(TODAY, 5), distance_km: 21.1, target_time: "1:55:00" });
    await coach.db.addRace({ name: "秋季 10K", date: addDays(TODAY, 20), distance_km: 10 });
    await coach.db.addRace({ name: "夏季 5K", date: addDays(TODAY, -3), distance_km: 5 });
    const races = (await coach.feed()).filter((i) => i.kind === "race");
    // 標題是賽事的名稱，倒數在右邊（規格 12.28）
    expect(races.map((r) => r.title)).toEqual(["城市半馬", "秋季 10K", "夏季 5K的成績還沒記錄"]);
    expect(races.map((r) => r.badge)).toEqual(["5 天", "20 天", undefined]);
    expect(races[0]).toMatchObject({ tone: "warn", detail: `${shortDateLabel(addDays(TODAY, 5))} · 半馬 · 目標 1:55:00` });
    expect(races[0]!.actions[0]).toMatchObject({ type: "ask", label: "排賽前幾天" });
    expect(races[1]!.actions).toEqual([]);
  });

  it("shows today's line from the plan", async () => {
    const { coach } = await makeCoach([]);
    await coach.savePlanForThisWeek("- 週五：休息\n- **週六**：長跑 20km\n- 星期日：恢復跑 6km");
    expect((await coach.feed()).find((i) => i.kind === "plan")).toMatchObject({
      title: "今日課表（星期六）",
      detail: "週六：長跑 20km",
    });
  });

  it("warns about a sudden jump in volume", async () => {
    const { coach } = await makeCoach([]);
    for (let w = 1; w <= 3; w++) {
      for (const d of [1, 3, 5]) await coach.db.saveWorkout(run(addDays(TODAY, -(w * 7 + d)), 7));
    }
    for (const d of [0, 1, 2, 4, 6]) await coach.db.saveWorkout(run(addDays(TODAY, -d), 7));
    const volume = (await coach.feed()).find((i) => i.kind === "volume");
    expect(volume).toMatchObject({ tone: "warn", title: "近 7 天跑了 35 km，比前三週平均多 67%" });
  });

  it("notices a long break and puts warnings first", async () => {
    const { coach } = await makeCoach([]);
    await coach.db.saveWorkout(run(addDays(TODAY, -6), 8));
    await coach.db.addRace({ name: "城市半馬", date: addDays(TODAY, 3), distance_km: 21.1 });
    const items = await coach.feed();
    expect(items.find((i) => i.kind === "gap")).toMatchObject({ title: "已經 6 天沒跑了" });
    expect(items[0]!.tone).toBe("warn");
  });
});
