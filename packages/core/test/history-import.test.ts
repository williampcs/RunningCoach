import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import { Db, IntervalsClient, type Activity, type ActivitySource } from "../src";
import { importHistory, type ImportProgress } from "../src/history-import";
import { activity, NOW } from "./helpers";

const TODAY = "2026-10-10";

async function freshDb() {
  const db = new Db(openNodeSqlite(":memory:"), { now: () => NOW, today: () => TODAY });
  await db.init();
  return db;
}

/** 依日期範圍回傳的來源；記錄每次請求的範圍 */
function source(runs: Activity[], unavailableBefore: string | null = null) {
  const ranges: [string, string][] = [];
  const s: ActivitySource = {
    fetchLatestActivity: async () => null,
    fetchActivities: async () => [],
    fetchRunsBetween: async (oldest, newest) => {
      ranges.push([oldest, newest]);
      return {
        runs: runs.filter((r) => r.date >= oldest && r.date <= newest),
        unavailable: unavailableBefore && newest < unavailableBefore ? 1 : 0,
      };
    },
  };
  return { s, ranges };
}

describe("匯入完整歷史", () => {
  it("從今天往回一年一年抓；連續兩年沒有跑步就停；不產生分析；可以重跑", async () => {
    const db = await freshDb();
    const runs = [
      activity({ intervals_id: "a", date: "2026-09-01" }),
      activity({ intervals_id: "b", date: "2025-03-01" }),
      activity({ intervals_id: "c", date: "2022-12-31" }),
    ];
    const { s, ranges } = source(runs);
    const progress: ImportProgress[] = [];
    const result = await importHistory(db, s, TODAY, (p) => progress.push(p));
    expect(result).toMatchObject({ added: 3, existing: 0, earliest: "2022-12-31", unavailable: 0 });
    expect(result.perYear).toEqual([
      { year: "2022", runs: 1 },
      { year: "2025", runs: 1 },
      { year: "2026", runs: 1 },
    ]);
    expect(ranges[0]).toEqual(["2025-10-11", "2026-10-10"]);
    expect(ranges[1]).toEqual(["2024-10-11", "2025-10-10"]);
    // 2022-10 起那一年有一筆；之後兩年沒有就停
    expect(ranges.length).toBe(6);
    expect(progress.at(-1)!.found).toBe(3);
    expect((await db.getRecentWorkouts(365 * 10)).every((w) => !w.summary)).toBe(true);

    const again = await importHistory(db, source(runs).s, TODAY);
    expect(again).toMatchObject({ added: 0, existing: 3 });
  });

  it("拿不到內容的活動（從 Strava 來的）算進去，也延後停止", async () => {
    const db = await freshDb();
    const { s, ranges } = source([activity({ intervals_id: "a", date: "2026-09-01" })], "2025-10-10");
    const result = await importHistory(db, s, TODAY);
    // 前兩年沒有空殼，之後 28 年每年一筆
    expect(result.unavailable).toBe(28);
    expect(ranges.length).toBe(30);
  });

  it("Intervals.icu：只留跑步，Strava 的空殼另外計數，放寬逾時", async () => {
    const urls: string[] = [];
    const intervals = new IntervalsClient({
      apiKey: "secret",
      today: () => TODAY,
      fetch: async (input) => {
        urls.push(String(input));
        return new Response(
          JSON.stringify([
            { id: "i1", type: "Run", start_date_local: "2025-05-01T06:30:00", distance: 8000, moving_time: 2700 },
            { id: "i2", type: "Ride", start_date_local: "2025-05-02T06:30:00", distance: 30000, moving_time: 3600 },
            { id: "i3", start_date_local: "2025-05-03T06:30:00", source: "STRAVA", _note: "STRAVA activities are not available via the API" },
          ]),
        );
      },
    });
    const { runs, unavailable } = await intervals.fetchRunsBetween("2024-10-11", "2025-10-10");
    expect(urls[0]).toContain("/activities?oldest=2024-10-11&newest=2025-10-10");
    expect(runs.map((r) => r.intervals_id)).toEqual(["i1"]);
    expect(unavailable).toBe(1);
  });
});
