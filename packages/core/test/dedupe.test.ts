import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import {
  addDays,
  Coach,
  FakeActivitySource,
  generateActivities,
  keepScore,
  maybeSameRun,
  overlapRatio,
  sameRun,
  timeRangeOf,
  type Activity,
} from "../src";
import { silentLogger } from "../src/types";
import { activity, makeCoach, ScriptedProvider, turn } from "./helpers";

const TODAY = "2026-10-10";

/** 有開始時間與經過時間的跑步；hr 為 false 時像手機經「健康」上傳的那份 */
function timed(id: string, date: string, start: string, minutes: number, partial: Partial<Activity> = {}, hr = true): Activity {
  return activity({
    intervals_id: id,
    date,
    duration_min: minutes,
    avg_hr: hr ? 150 : null,
    max_hr: hr ? 170 : null,
    training_load: hr ? 60 : null,
    raw_json: JSON.stringify({ id, start_date_local: `${date}T${start}`, elapsed_time: minutes * 60 }),
    ...partial,
  });
}
const watch = (date = TODAY) => timed(`w-${date}`, date, "06:30:00", 50);
const phone = (date = TODAY) => timed(`p-${date}`, date, "06:30:40", 51, { distance_km: 10.1 }, false);

describe("同一趟的判斷", () => {
  it("以時間重疊判斷，不要求開始時間相同；早上與晚上各跑一趟不算", () => {
    expect(timeRangeOf(watch().raw_json)).toEqual({
      start: Date.parse(`${TODAY}T06:30:00Z`),
      end: Date.parse(`${TODAY}T07:20:00Z`),
    });
    expect(timeRangeOf(JSON.stringify({ start_date_local: `${TODAY}T06:30:00` }))).toBeNull();
    expect(timeRangeOf("not json")).toBeNull();

    expect(sameRun(watch(), phone())).toBe(true);
    expect(sameRun(watch(), timed("x", TODAY, "18:30:00", 40))).toBe(false);
    // 重疊不到較短那筆的一半：前後接著跑的兩段
    expect(overlapRatio({ start: 0, end: 100 }, { start: 80, end: 300 })).toBe(0.2);
  });

  it("沒有時間時，同一天、距離與時長都相近才算「可能是同一趟」", () => {
    const manual = activity({ intervals_id: "m", raw_json: null, distance_km: 10.0, duration_min: 55 });
    expect(maybeSameRun(manual, activity({ intervals_id: "n", raw_json: null }))).toBe(true);
    expect(maybeSameRun(manual, activity({ intervals_id: "n", raw_json: null, distance_km: 8 }))).toBe(false);
    expect(maybeSameRun(manual, activity({ intervals_id: "n", raw_json: null, date: addDays(TODAY, -1) }))).toBe(false);
    // 兩筆都有時間：以重疊為準
    expect(maybeSameRun(watch(), timed("y", TODAY, "18:00:00", 55))).toBe(false);
    expect(keepScore(watch())).toBeGreaterThan(keepScore(phone()));
  });
});

describe("同步時去重", () => {
  it("先進來沒有心率的那份，有心率的再進來時取代它；體感跟著保留的那筆", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "手機那份的分析" }), turn({ text: "手錶那份的分析" })], {
      activities: [phone(), watch()],
    });
    await coach.db.savePendingSubjective(TODAY, 6, "順");
    expect(await coach.sync()).toBe(
      "✅ Intervals.icu 同步完成：新增 1 筆訓練紀錄，其中 1 筆合併了主觀感受，合併 1 筆重複的紀錄（同一趟從不同來源上傳）",
    );
    const [kept, ...rest] = await coach.db.getRecentWorkouts(7);
    expect(rest).toEqual([]);
    expect(kept).toMatchObject({ intervals_id: `w-${TODAY}`, avg_hr: 150, perceived_effort: 6, duplicate_count: 1 });
    expect(kept!.summary).toBe("手錶那份的分析");
    expect(provider.calls[1]!.request.messages[0]!.content).toContain("體感強度：6/10");
    expect(await coach.db.countWorkouts()).toBe(1);
  });

  it("有心率的先進來時，重複的那份不產生分析", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "手錶那份的分析" })], { activities: [watch(), phone()] });
    expect(await coach.sync()).toContain("新增 1 筆訓練紀錄，合併 1 筆重複的紀錄");
    expect(provider.calls).toHaveLength(1);
    expect(await coach.db.getRecentWorkouts(7)).toMatchObject([{ intervals_id: `w-${TODAY}`, duplicate_count: 1 }]);
  });

  it("跟著 Intervals.icu 的刪除：保留的那筆被刪時由重複的那份接手；又出現時恢復", async () => {
    const { coach, activities } = await makeCoach([turn({ text: "手錶那份的分析" })], { activities: [watch(), phone()] });
    await coach.sync();
    await coach.addSubjective((await coach.db.getRecentWorkouts(7))[0]!.id, 5, "").catch(() => undefined);

    // 使用者在 Intervals.icu 刪掉手錶那份
    activities.activities = [phone()];
    expect(await coach.sync()).toBe("✅ Intervals.icu 同步完成：移除 1 筆在 Intervals.icu 已刪除或不再是跑步的紀錄，略過 1 筆已存在資料");
    const [heir] = await coach.db.getRecentWorkouts(7);
    expect(heir).toMatchObject({ intervals_id: `p-${TODAY}`, perceived_effort: 5, summary: "手錶那份的分析", duplicate_count: 0 });

    // 又出現了（例如類型改回跑步）：恢復，並再次判斷是同一趟
    activities.activities = [watch(), phone()];
    expect(await coach.sync()).toContain("恢復 1 筆");
    expect(await coach.db.getRecentWorkouts(7)).toMatchObject([{ intervals_id: `w-${TODAY}`, duplicate_count: 1 }]);

    // 全部都不見了（例如改成走路）：同步不到跑步時也照樣移除
    activities.activities = [];
    expect(await coach.sync()).toContain("無跑步活動。已移除 1 筆在 Intervals.icu 已刪除或不再是跑步的紀錄。");
    expect(await coach.db.countWorkouts()).toBe(0);
  });

  it("連不上 Intervals.icu 時不移除任何紀錄", async () => {
    const { coach, activities } = await makeCoach([turn({ text: "分析" })], { activities: [watch()] });
    await coach.sync();
    activities.fetchActivities = async () => {
      throw new Error("down");
    };
    expect(await coach.sync()).toContain("❌");
    expect(await coach.db.countWorkouts()).toBe(1);
  });

  it("「不是同一趟」可以拆開，之後不再合併", async () => {
    const { coach } = await makeCoach([turn({ text: "分析" })], { activities: [watch(), phone()] });
    await coach.sync();
    const [kept] = await coach.db.getRecentWorkouts(7);
    expect(await coach.splitDuplicates(kept!.id)).toBe(1);
    expect(await coach.db.countWorkouts()).toBe(2);
    expect(await coach.db.getDistinctPairs()).toEqual(new Set([`${kept!.id}-${kept!.id + 1}`]));
  });

  it("跑後回報不會把還沒同步、但已存過同一趟的那份另外列出", async () => {
    const { coach, activities } = await makeCoach([turn({ text: "分析" })], { activities: [watch()] });
    await coach.sync();
    activities.activities = [phone(), watch()];
    const { candidates } = await coach.reportCandidates();
    expect(candidates.map((c) => c.activity.intervals_id)).toEqual([`w-${TODAY}`]);
  });
});

describe("可能是同一趟：在教練動態詢問", () => {
  it("沒有時間可比的兩筆相近的跑步，問要不要合併；合併或說不是之後不再問", async () => {
    const { coach } = await makeCoach();
    const a = await coach.db.saveWorkout(activity({ intervals_id: "a", raw_json: null }));
    const b = await coach.db.saveWorkout(activity({ intervals_id: "b", raw_json: null, distance_km: 10.2, avg_hr: null }));
    const [ask] = await coach.feed();
    expect(ask).toMatchObject({
      title: "今天的兩筆跑步看起來是同一趟",
      actions: [
        { type: "merge", keepId: a, dupId: b },
        { type: "distinct", aId: a, bId: b },
      ],
    });

    await coach.mergeWorkouts(a, b);
    expect((await coach.feed()).some((i) => i.kind === "duplicate")).toBe(false);
    expect(await coach.db.getRecentWorkouts(1)).toMatchObject([{ id: a, duplicate_count: 1 }]);

    await coach.splitDuplicates(a);
    expect((await coach.feed()).some((i) => i.kind === "duplicate")).toBe(false);
  });

  it("標記不是同一趟後不再詢問", async () => {
    const { coach } = await makeCoach();
    const a = await coach.db.saveWorkout(activity({ intervals_id: "a", raw_json: null }));
    const b = await coach.db.saveWorkout(activity({ intervals_id: "b", raw_json: null }));
    await coach.markDistinct(b, a);
    expect((await coach.feed()).some((i) => i.kind === "duplicate")).toBe(false);
  });
});

describe("測試模式的假資料", () => {
  it("最近 14 天的每一趟也從手機傳一次，同步時合併成一筆", async () => {
    const spec = { scenario: "steady" as const, endDate: TODAY, weeks: 4, runsPerWeek: 4, easyPaceSec: 345, maxHr: 188, seed: 3 };
    const plain = generateActivities(spec);
    const doubled = generateActivities({ ...spec, duplicates: true });
    const copies = doubled.filter((r) => r.intervals_id!.endsWith("-phone"));
    const recent = plain.filter((r) => r.date > addDays(TODAY, -14));
    expect(copies).toHaveLength(recent.length);
    expect(copies.every((c) => c.avg_hr === null && sameRun(c, plain.find((p) => p.date === c.date)!))).toBe(true);

    const coach = new Coach({
      driver: openNodeSqlite(":memory:"),
      llm: {
        provider: new ScriptedProvider(doubled.map(() => turn({ text: "分析" }))),
        models: { chat: "c", summary: "s", compress: "p" },
        chatEffort: "medium",
      },
      activities: new FakeActivitySource(doubled, () => TODAY),
      now: () => new Date(`${TODAY}T04:00:00Z`),
      logger: silentLogger,
    });
    await coach.init();
    const message = await coach.sync();
    // FakeActivitySource 涵蓋 14 天前當天；去掉範圍外的那天後，筆數與手機的那份相同
    const inWindow = plain.filter((r) => r.date >= addDays(TODAY, -14));
    expect(message).toContain(`合併 ${copies.length} 筆重複的紀錄`);
    expect(await coach.db.countWorkouts()).toBe(inWindow.length);
    expect((await coach.db.getRecentWorkouts(14)).every((w) => w.avg_hr !== null)).toBe(true);
  });
});
