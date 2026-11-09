/** Garmin 的資料來源標示（KI-048）：判斷的規則、轉換、多來源的列法、卡片、看板與「參考了」 */
import { describe, expect, it } from "vitest";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import {
  buildFeed,
  dataSourceLine,
  dataSourcesOf,
  dataSourcesOfRows,
  Db,
  DEFAULT_SETTINGS,
  detailsOf,
  GARMIN_SOURCE_NOTE,
  garminLabelOf,
  mergeDataSources,
  recordOfWorkout,
  sourcesText,
  type Workout,
} from "../src";
import { runCards } from "../src/history";
import { activity, makeCoach, NOW, toolTurn, turn } from "./helpers";

const clock = { now: () => NOW, today: () => "2026-10-10" };

async function freshDb() {
  const db = new Db(openNodeSqlite(":memory:"), clock);
  await db.init();
  return db;
}

const raw = (fields: Record<string, unknown>) => JSON.stringify({ icu_training_load: 50, ...fields });
const GARMIN_RUN = { source: "GARMIN_CONNECT", device_name: "Garmin Forerunner 265" };
const COROS_RUN = { source: "COROS", device_name: "COROS PACE 3" };

describe("哪些活動來自 Garmin", () => {
  it("經 Garmin Connect 同步的，照裝置名稱標「Garmin〔型號〕」", () => {
    expect(garminLabelOf(GARMIN_RUN)).toBe("Garmin Forerunner 265");
  });

  it("來源是 Garmin Connect、裝置名稱沒有 Garmin 字樣時補上；沒有裝置名稱時只寫 Garmin", () => {
    expect(garminLabelOf({ source: "GARMIN_CONNECT", device_name: "Forerunner 965" })).toBe("Garmin Forerunner 965");
    expect(garminLabelOf({ source: "GARMIN_CONNECT" })).toBe("Garmin");
    expect(garminLabelOf({ source: "garmin_connect", device_name: "  " })).toBe("Garmin");
  });

  it("上傳的 Garmin 手錶的檔案（裝置名稱以 Garmin 開頭）也標；大小寫統一成 Garmin", () => {
    expect(garminLabelOf({ source: "UPLOAD", device_name: "Garmin Edge 540" })).toBe("Garmin Edge 540");
    expect(garminLabelOf({ source: "UPLOAD", device_name: "garmin fenix 7" })).toBe("Garmin fenix 7");
  });

  it("其他品牌、手機、手動記的不標；名字裡只是含有 Garmin 的不算", () => {
    expect(garminLabelOf(COROS_RUN)).toBeNull();
    expect(garminLabelOf({ source: "OAUTH_CLIENT", device_name: "Apple Watch Series 9" })).toBeNull();
    expect(garminLabelOf({ source: "MANUAL" })).toBeNull();
    expect(garminLabelOf({})).toBeNull();
    expect(garminLabelOf({ source: "UPLOAD", device_name: "NotGarmin 1" })).toBeNull();
    expect(garminLabelOf({ source: "UPLOAD", device_name: "Garminator" })).toBeNull();
  });

  it("拿不到內容的空殼（有 _note）不標", () => {
    expect(garminLabelOf({ ...GARMIN_RUN, _note: "not available via the API" })).toBeNull();
  });

  it("detailsOf 帶出裝置、Garmin 的標示與是否經 Garmin Connect", () => {
    expect(detailsOf(raw(GARMIN_RUN))).toMatchObject({ device: "Garmin Forerunner 265", garmin: "Garmin Forerunner 265", garminConnect: true });
    expect(detailsOf(raw({ source: "UPLOAD", device_name: "Garmin Edge 540" }))).toMatchObject({ garmin: "Garmin Edge 540", garminConnect: false });
    expect(detailsOf(raw(COROS_RUN))).toMatchObject({ device: "COROS PACE 3", garmin: null, garminConnect: false });
    expect(detailsOf(null)).toMatchObject({ device: null, garmin: null, garminConnect: false });
  });
});

const workout = (id: number, source: string, fields: Record<string, unknown> = {}): Workout =>
  ({ id, date: "2026-10-09", source, raw_json: raw(fields) }) as Workout;

describe("由多趟算的：資料來源的列法", () => {
  it("Garmin 在最前面，其他照固定的順序，同樣的只列一次", () => {
    const records = [workout(1, "manual"), workout(2, "intervals", COROS_RUN), workout(3, "intervals", GARMIN_RUN), workout(4, "intervals", GARMIN_RUN)].map(recordOfWorkout);
    expect(dataSourcesOf(records)).toEqual(["Garmin", "其他裝置", "手動記"]);
    expect(dataSourceLine(dataSourcesOf(records))).toBe("資料來源：Garmin、其他裝置、手動記");
  });

  it("只有 Garmin 時「資料來源：Garmin」", () => {
    expect(dataSourceLine(dataSourcesOfRows([workout(1, "intervals", GARMIN_RUN)]))).toBe("資料來源：Garmin");
  });

  it("沒有用到 Garmin 時不標", () => {
    expect(dataSourceLine(dataSourcesOfRows([workout(1, "manual"), workout(2, "intervals", COROS_RUN), workout(3, "import")]))).toBeNull();
    expect(dataSourceLine([])).toBeNull();
  });

  it("其他運動（騎車）也算；幾組合起來照同一個順序", () => {
    const ride = { intervals_id: "r1", date: "2026-10-09", type: "Ride", raw_json: raw({ source: "GARMIN_CONNECT", device_name: "Garmin Edge 540" }) };
    expect(dataSourcesOfRows([workout(1, "manual")], [ride as never])).toEqual(["Garmin", "手動記"]);
    expect(mergeDataSources([["手動記"], ["其他裝置", "Garmin"], []])).toEqual(["Garmin", "其他裝置", "手動記"]);
  });
});

describe("卡片與看板", () => {
  it("跑步的卡片：Garmin 的有標示，其他品牌與手動記的沒有", async () => {
    const db = await freshDb();
    await db.saveWorkout(activity({ intervals_id: "g", date: "2026-10-10", raw_json: raw(GARMIN_RUN) }));
    await db.saveWorkout(activity({ intervals_id: "c", date: "2026-10-09", raw_json: raw(COROS_RUN) }));
    await db.addManualWorkout({ date: "2026-10-08", distance_km: 5, duration_min: 32, avg_hr: null, perceived_effort: 3, subjective_notes: null });
    const cards = await runCards(db, "2026-10-10", 30);
    expect(cards.map((c) => [c.workout.date, c.garmin])).toEqual([
      ["2026-10-10", "Garmin Forerunner 265"],
      ["2026-10-09", null],
      ["2026-10-08", null],
    ]);
  });

  it("看板：還沒回報的那一趟是 Garmin 的時候標在那一列", async () => {
    const db = await freshDb();
    await db.saveWorkout(activity({ intervals_id: "g", date: "2026-10-10", raw_json: raw(GARMIN_RUN) }));
    const feed = await buildFeed(db, "2026-10-10", DEFAULT_SETTINGS);
    expect(feed.find((i) => i.kind === "report")?.source).toBe("Garmin Forerunner 265");
  });

  it("看板：其他品牌的那一趟不標", async () => {
    const db = await freshDb();
    await db.saveWorkout(activity({ intervals_id: "c", date: "2026-10-10", raw_json: raw(COROS_RUN) }));
    const feed = await buildFeed(db, "2026-10-10", DEFAULT_SETTINGS);
    expect(feed.find((i) => i.kind === "report")?.source).toBeUndefined();
  });
});

describe("教練的回覆：「參考了」", () => {
  it("讀過的紀錄有 Garmin 的：最後加上「（含 Garmin 的資料）」，也存進對話紀錄", async () => {
    const { coach } = await makeCoach([toolTurn("get_recent_workouts", { days: 14 }), turn({ text: "這週練得不錯" })]);
    await coach.db.saveWorkout(activity({ intervals_id: "g", date: "2026-10-09", raw_json: raw(GARMIN_RUN) }));
    const reply = await coach.chat("最近練得怎樣");
    expect(reply.sources).toEqual(["最近 14 天的訓練", GARMIN_SOURCE_NOTE]);
    expect(sourcesText(reply.sources)).toBe("參考了：最近 14 天的訓練（含 Garmin 的資料）");
    const rows = await coach.db.getRecentConversations(2);
    expect(rows.at(-1)!.sources).toEqual(["最近 14 天的訓練", GARMIN_SOURCE_NOTE]);
  });

  it("只有其他品牌或手動記的紀錄時不加", async () => {
    const { coach } = await makeCoach([toolTurn("get_recent_workouts", { days: 14 }), turn({ text: "這週練得不錯" })]);
    await coach.db.saveWorkout(activity({ intervals_id: "c", date: "2026-10-09", raw_json: raw(COROS_RUN) }));
    const reply = await coach.chat("最近練得怎樣");
    expect(reply.sources).toEqual(["最近 14 天的訓練"]);
    expect(sourcesText(reply.sources)).toBe("參考了：最近 14 天的訓練");
  });

  it("沒有讀紀錄的工具（例如只看課表以外的說明）時不加", async () => {
    const { coach } = await makeCoach([toolTurn("get_app_help", { topic: "sync" }), turn({ text: "到設定按同步" })]);
    await coach.db.saveWorkout(activity({ intervals_id: "g", date: "2026-10-09", raw_json: raw(GARMIN_RUN) }));
    const reply = await coach.chat("怎麼同步");
    expect(reply.sources).not.toContain(GARMIN_SOURCE_NOTE);
  });

  it("恢復狀況：最近有經 Garmin Connect 同步的紀錄時加", async () => {
    const { coach } = await makeCoach([toolTurn("get_recovery_status", { days: 7 }), turn({ text: "恢復得還可以" })]);
    await coach.db.saveWorkout(activity({ intervals_id: "g", date: "2026-10-01", raw_json: raw(GARMIN_RUN) }));
    const reply = await coach.chat("我恢復得怎樣");
    expect(reply.sources.at(-1)).toBe(GARMIN_SOURCE_NOTE);
  });

  it("沒有讀過資料時是空字串；只有標記也不顯示", () => {
    expect(sourcesText([])).toBe("");
    expect(sourcesText([GARMIN_SOURCE_NOTE])).toBe("");
  });
});
