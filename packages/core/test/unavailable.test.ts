import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import { Coach, IntervalsClient, SNAPSHOT_UNAVAILABLE, unavailableCountText, unavailableOriginOf, type UnavailableSnapshot } from "../src";
import { silentLogger } from "../src/types";
import { ScriptedProvider } from "./helpers";

const TODAY = "2026-10-10";

const run = (id: string, date: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "Run",
  start_date_local: `${date}T06:30:00`,
  distance: 8000,
  moving_time: 2700,
  average_speed: 2.96,
  average_heartrate: 148,
  icu_training_load: 55,
  source: "GARMIN_CONNECT",
  device_name: "Garmin Forerunner 265",
  ...extra,
});
const stravaShell = (id: string, date: string) => ({
  id,
  type: "Run",
  start_date_local: `${date}T07:00:00`,
  source: "STRAVA",
  _note: "STRAVA activities are not available via the API",
});
// Garmin 的空殼：格式還沒公布，用推測的樣子（只有 id、類型、時間、來源）
const garminShell = (id: string, date: string) => ({ id, type: "Run", start_date_local: `${date}T06:30:00`, source: "GARMIN_CONNECT" });

function setup(initial: Record<string, unknown>[]) {
  const state = { list: initial };
  const intervals = new IntervalsClient({
    apiKey: "secret",
    today: () => TODAY,
    fetch: async (input) => {
      const url = String(input);
      if (url.includes("/activities?")) return new Response(JSON.stringify(state.list));
      if (url.includes("/wellness?")) return new Response("[]");
      return new Response("null");
    },
  });
  const coach = new Coach({
    driver: openNodeSqlite(":memory:"),
    // 分析失敗只記錄，不影響同步
    llm: { provider: new ScriptedProvider([]), models: { chat: "c", summary: "s", compress: "p" }, chatEffort: "medium" },
    activities: intervals,
    now: () => new Date(`${TODAY}T04:00:00Z`),
    logger: silentLogger,
  });
  return { coach, state };
}

describe("unavailableOriginOf", () => {
  it("recognises Strava and Garmin shells but not real activities", () => {
    expect(unavailableOriginOf(stravaShell("a", TODAY))).toBe("strava");
    expect(unavailableOriginOf({ id: "b", source: "STRAVA" })).toBe("strava");
    expect(unavailableOriginOf(garminShell("c", TODAY))).toBe("garmin");
    expect(unavailableOriginOf({ id: "d", _note: "GARMIN activities are not available via the API" })).toBe("garmin");
    expect(unavailableOriginOf({ id: "e", _note: "not available" })).toBe("other");
    expect(unavailableOriginOf(run("f", TODAY))).toBeNull();
    // 沒有距離的肌力訓練不是空殼
    expect(unavailableOriginOf({ id: "g", type: "WeightTraining", source: "GARMIN_CONNECT", elapsed_time: 1800, average_heartrate: 110 })).toBeNull();
  });

  it("describes the counts by origin, Garmin first", () => {
    const item = (origin: "garmin" | "strava" | "other") => ({ intervals_id: "x", date: TODAY, origin, type: "Run" });
    expect(unavailableCountText([item("strava"), item("garmin"), item("garmin")])).toBe("2 筆來自 Garmin、1 筆來自 Strava");
    expect(unavailableCountText([])).toBeNull();
  });
});

describe("sync with shells", () => {
  it("does not save shells as runs or other activities, nor count their load", async () => {
    const { coach } = setup([
      run("i1", "2026-10-09"),
      stravaShell("s1", "2026-10-08"),
      garminShell("g1", "2026-10-07"),
      { id: "s2", type: "Ride", start_date_local: "2026-10-06T07:00:00", source: "STRAVA", _note: "STRAVA activities are not available via the API" },
    ]);
    await coach.init();
    const text = await coach.sync();
    expect(text).toContain("新增 1 筆訓練紀錄");
    expect(text).toContain("另有 1 筆來自 Garmin、2 筆來自 Strava 的活動，Intervals.icu 不能提供內容");
    const workouts = await coach.db.getRecentWorkouts(14);
    expect(workouts.map((w) => w.intervals_id)).toEqual(["i1"]);
    expect(workouts.every((w) => (w.distance_km ?? 0) > 0)).toBe(true);
    expect(await coach.db.getOtherActivities(14)).toEqual([]);
    const snapshot = await coach.db.getSnapshot<UnavailableSnapshot>(SNAPSHOT_UNAVAILABLE);
    expect(snapshot?.value.items.map((i) => [i.intervals_id, i.origin])).toEqual([
      ["s1", "strava"],
      ["g1", "garmin"],
      ["s2", "strava"],
    ]);
    expect(workouts.reduce((sum, w) => sum + (w.training_load ?? 0), 0)).toBe(55);
  });

  it("keeps a stored run when Intervals.icu later only lists it as a shell", async () => {
    const { coach, state } = setup([run("i1", "2026-10-09"), run("i2", "2026-10-08")]);
    await coach.init();
    await coach.sync();
    // Garmin 的活動變成空殼：已經存了內容的不刪，也不提示（內容已經在這台）
    state.list = [garminShell("i1", "2026-10-09"), garminShell("i2", "2026-10-08"), garminShell("g3", "2026-10-07")];
    const text = await coach.sync();
    expect(text).not.toContain("移除");
    expect((await coach.db.getRecentWorkouts(14)).map((w) => w.intervals_id)).toEqual(["i1", "i2"]);
    const snapshot = await coach.db.getSnapshot<UnavailableSnapshot>(SNAPSHOT_UNAVAILABLE);
    expect(snapshot?.value.items.map((i) => i.intervals_id)).toEqual(["g3"]);
    // 真的在 Intervals.icu 刪了（清單裡連空殼都沒有）才移除
    state.list = [garminShell("i1", "2026-10-09")];
    expect(await coach.sync()).toContain("移除 1 筆");
  });

  it("removes 0 km shells that an older version saved", async () => {
    const { coach } = setup([stravaShell("s1", "2026-10-08")]);
    await coach.init();
    // 舊版會把有類型的空殼存成 0 公里的跑步
    await coach.db.saveWorkoutChecked(
      { intervals_id: "s1", date: "2026-10-08", type: "run", distance_km: 0, duration_min: 0, avg_hr: null, max_hr: null, avg_pace: null, elevation_m: null, calories: null, training_load: null, raw_json: JSON.stringify(stravaShell("s1", "2026-10-08")) },
      null,
      null,
    );
    expect(await coach.db.getRecentWorkouts(14)).toHaveLength(1);
    await coach.sync();
    expect(await coach.db.getRecentWorkouts(14)).toEqual([]);
  });

  it("tells there are no runs without asking to check the upload when only shells came", async () => {
    const { coach } = setup([stravaShell("s1", "2026-10-08")]);
    await coach.init();
    const text = await coach.sync();
    expect(text).toContain("另有 1 筆來自 Strava 的活動");
    expect(text).not.toContain("請確認手錶或 App 已把紀錄上傳");
  });
});

describe("feed item for shells", () => {
  it("explains the shells with alternatives, and hides dates already logged by hand", async () => {
    const { coach, state } = setup([garminShell("g1", "2026-10-09"), stravaShell("s1", "2026-10-08")]);
    await coach.init();
    await coach.sync();
    let item = (await coach.feed()).find((i) => i.kind === "unavailable");
    expect(item).toMatchObject({
      id: `unavailable-${TODAY}`,
      title: "1 筆來自 Garmin、1 筆來自 Strava 的活動，拿不到內容",
      actions: [{ type: "manual" }, { type: "help", topic: "unavailable", label: "其他方式" }],
    });
    expect(item?.detail).toContain("不算負荷");

    // 手動記了 10/9 那一趟：只剩 Strava 的那筆
    await coach.addManualWorkout({ date: "2026-10-09", distance_km: 8, duration_min: 45, avg_hr: null, perceived_effort: 4, subjective_notes: null });
    item = (await coach.feed()).find((i) => i.kind === "unavailable");
    expect(item?.title).toBe("1 筆來自 Strava 的活動，拿不到內容");

    // 下一次同步沒有空殼：提示消失
    state.list = [];
    await coach.sync();
    expect((await coach.feed()).some((i) => i.kind === "unavailable")).toBe(false);
  });
});
