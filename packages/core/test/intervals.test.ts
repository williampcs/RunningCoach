import { describe, expect, it } from "vitest";

import { IntervalsClient, IntervalsError, speedToPace } from "../src";

function client(response: unknown, options: Partial<ConstructorParameters<typeof IntervalsClient>[0]> = {}, status = 200) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const intervals = new IntervalsClient({
    apiKey: "secret",
    today: () => "2026-10-10",
    fetch: async (input, init) => {
      requests.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify(response), { status });
    },
    ...options,
  });
  return { intervals, requests };
}

describe("IntervalsClient", () => {
  it("配速換算", () => {
    expect(speedToPace(3.0303)).toBe("5:30/km");
    expect(speedToPace(2.7778)).toBe("5:59/km");
    expect(speedToPace(0)).toBeNull();
    expect(speedToPace(null)).toBeNull();
  });

  it("以 API key 查詢最近 N 天，只留跑步並由新到舊排序", async () => {
    const { intervals, requests } = client([
      { id: "i1", type: "Run", start_date_local: "2026-10-07T06:30:00", distance: 8000, moving_time: 2700 },
      { id: "i2", type: "Ride", start_date_local: "2026-10-09T06:30:00", distance: 30000, moving_time: 3600 },
      {
        id: "i3",
        type: "TrailRun",
        start_date_local: "2026-10-09T18:00:00",
        distance: 10021.4,
        moving_time: 3306,
        average_speed: 3.0303,
        average_heartrate: 152,
        max_heartrate: 171,
        total_elevation_gain: 48,
        calories: 640,
        icu_training_load: 72,
      },
    ]);
    const activities = await intervals.fetchActivities(14);

    expect(requests[0]).toEqual({
      url: "https://intervals.icu/api/v1/athlete/0/activities?oldest=2026-09-26&newest=2026-10-10",
      headers: { authorization: `Basic ${btoa("API_KEY:secret")}`, accept: "application/json" },
    });
    expect(activities.map((a) => a.intervals_id)).toEqual(["i3", "i1"]);
    expect(activities[0]).toMatchObject({
      intervals_id: "i3",
      date: "2026-10-09",
      type: "run",
      distance_km: 10.02,
      duration_min: 55.1,
      avg_hr: 152,
      max_hr: 171,
      avg_pace: "5:30/km",
      elevation_m: 48,
      calories: 640,
      training_load: 72,
    });
    expect(JSON.parse(activities[0]!.raw_json!).id).toBe("i3");
    // 沒有 average_speed 時以距離與時間推算
    expect(activities[1]).toMatchObject({ avg_pace: "5:37/km", avg_hr: null, training_load: null });
  });

  it("列出跑步以外的活動類型（同步不到跑步時說明用）", async () => {
    const { intervals } = client([
      { id: "i1", type: "Run", start_date_local: "2026-10-07T06:30:00" },
      { id: "i2", type: "Walk", start_date_local: "2026-10-09T06:30:00" },
      { id: "i3", sport_type: "Ride", start_date_local: "2026-10-08T06:30:00" },
      { id: "i4", start_date_local: "2026-10-08T07:30:00" },
    ]);
    expect(await intervals.fetchOtherActivityTypes(14)).toEqual(["Walk", "Ride", "Other"]);
  });

  it("最新一筆只查最近 7 天；支援 OAuth token 與指定選手", async () => {
    const { intervals, requests } = client([], { apiKey: undefined, accessToken: "tok", athleteId: "i12345" });
    expect(await intervals.fetchLatestActivity()).toBeNull();
    expect(requests[0]!.url).toBe("https://intervals.icu/api/v1/athlete/i12345/activities?oldest=2026-10-03&newest=2026-10-10");
    expect(requests[0]!.headers.authorization).toBe("Bearer tok");
  });

  it("未設定憑證或驗證失敗時丟出 IntervalsError", async () => {
    await expect(client([], { apiKey: "" }).intervals.fetchActivities()).rejects.toThrow(IntervalsError);
    await expect(client({ error: "Unauthorized" }, {}, 401).intervals.fetchActivities()).rejects.toThrow(
      "Intervals.icu 回應 401（請確認 API Key 與 Athlete ID）",
    );
  });
});
