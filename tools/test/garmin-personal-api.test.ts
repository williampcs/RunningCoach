import { describe, expect, it } from "vitest";

import { probe, reportText, shapeOf } from "../garmin-personal-api";
import { fitFieldSummary, fitFromDownload, fitInfo } from "../lib/fit";
import { fakeRunFit, zipOne } from "../lib/fit-fixture";

const KEY = "secret-garmin-key-123456";
const TOKEN = "secret-access-token-abcdef";
const TODAY = "2026-11-09";

type Route = (req: { method: string; url: URL; auth: string; origin: string | null }) => Response;

/** 模擬 Garmin 的回應；cors 為 false 時不回 CORS 標頭 */
function garmin({ cors = true, dataAuth = "bearer" }: { cors?: boolean; dataAuth?: "bearer" | "apikey" } = {}) {
  const calls: string[] = [];
  const h = (type = "application/json"): Record<string, string> => ({
    "content-type": type,
    ...(cors ? { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization", "access-control-allow-methods": "GET, POST" } : {}),
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: h() });
  const route: Route = ({ method, url, auth }) => {
    if (method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: h("text/plain") });
    const path = url.pathname;
    if (path.endsWith("/personal-api-key/token")) return auth === `ApiKey ${KEY}` ? json(200, { access_token: TOKEN, expires_in: 86400 }) : json(401, {});
    const okAuth = dataAuth === "bearer" ? `Bearer ${TOKEN}` : `ApiKey ${KEY}`;
    if (auth !== okAuth) return json(401, {});
    if (path.endsWith("/activities/search/activities"))
      return json(200, [{ activityId: 987654321, activityName: "Taipei Morning Run", startTimeLocal: "2026-11-08 06:30:00", activityType: { typeKey: "running" }, averageHR: 151, distance: 10234 }]);
    if (path.includes("/activity-service/activity/")) return json(200, { activityId: 987654321, summaryDTO: { averageHR: 151, distance: 10234 } });
    if (path.includes("/download-service/files/activity/")) return new Response(zipOne("x.fit", fakeRunFit()), { status: 200, headers: h("application/x-zip-compressed") });
    if (path.includes("dailySleepSummariesByDate")) return json(200, [{ calendarDate: "2026-11-08", sleepTimeSeconds: 26123 }]);
    if (path.endsWith("/usersummary/daily")) return json(200, { restingHeartRate: 47 });
    if (path.endsWith("/dailysummaries")) return json(200, [{ restingHeartRate: 47 }]);
    if (path.endsWith("/dailyHeartRate")) return json(200, { restingHeartRate: 47, heartRateValues: [[1, 61]] });
    if (path.includes("/hrv/daily/")) return new Response(null, { status: 204, headers: h() });
    return json(404, {});
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const method = init?.method ?? "GET";
    calls.push(`${method} ${url.pathname}`);
    return route({ method, url, auth: headers.get("authorization") ?? "", origin: headers.get("origin") });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("garmin-personal-api", () => {
  it("probes token, activities, FIT and health data, with no values or secrets in the report", async () => {
    const { fetch, calls } = garmin();
    const result = await probe({ apiKey: KEY, fetch, today: TODAY });
    expect(result.auth).toBe("Bearer token");
    expect(result.steps.every((s) => s.ok)).toBe(true);
    expect(calls).toContain("POST /personalapitoken-service/personal-api/personal-api-key/token");
    expect(calls.some((c) => c.startsWith("GET /download-service/files/activity/"))).toBe(true);
    const text = reportText(result);
    // 欄位名稱、類型與筆數
    expect(text).toContain("activityName: string");
    expect(text).toContain("類型：running 1");
    expect(text).toContain("token 在「access_token」欄位");
    expect(text).toContain("靜止心率（restingHeartRate）：有");
    expect(text).toContain("record（#20）60 筆");
    expect(text).toContain("heart_rate 50/60");
    expect(text).toContain("每秒的紀錄有：心率、距離、速度、步頻");
    expect(text).toContain("瀏覽器應該可以直接呼叫");
    expect(text).toContain("不是給服務多位使用者的商業 App");
    // 沒有 key、token、數值、id、名稱、日期
    for (const leak of [KEY, TOKEN, "987654321", "Taipei", "151", "10234", "26123", "2026-11-08", "06:30"]) expect(text).not.toContain(leak);
  });

  it("falls back to the key when the data endpoints refuse the Bearer token", async () => {
    const { fetch } = garmin({ dataAuth: "apikey" });
    const result = await probe({ apiKey: KEY, fetch, today: TODAY });
    expect(result.auth).toBe("直接用 key（ApiKey）");
    expect(result.steps.find((s) => s.name === "列最近的活動")?.notes).toContain("Bearer token：401");
  });

  it("reports a wrong key and missing CORS headers", async () => {
    const { fetch } = garmin({ cors: false });
    const result = await probe({ apiKey: "wrong-key-000000", fetch, today: TODAY });
    expect(result.steps[0]).toMatchObject({ ok: false, status: 401 });
    const text = reportText(result);
    expect(text).toContain("key 不對、過期或被刪了");
    expect(text).toContain("沒有 CORS 標頭：瀏覽器應該會擋下");
    expect(text).not.toContain("wrong-key-000000");
  });

  it("describes shapes without values", () => {
    expect(shapeOf({ a: 1, b: { c: "x", d: 2 }, e: [1, 2] })).toEqual(["a: number", "b: object { c, d }", "e: array（2 筆）"]);
    expect(shapeOf([])).toEqual(["陣列 0 筆（空的）"]);
  });
});

describe("FIT helpers", () => {
  it("summarises messages and fields from a zip download, and still reads the date and sport", () => {
    const fit = fakeRunFit(Date.UTC(2026, 9, 9, 22, 30) / 1000, 20);
    expect(fitFromDownload(zipOne("a.fit", fit))?.equals(fit)).toBe(true);
    expect(fitFromDownload(fit)).toBe(fit);
    expect(fitFromDownload(Buffer.from("not a fit"))).toBeNull();
    const summary = fitFieldSummary(fit)!;
    expect(summary.map((m) => `${m.name}:${m.count}`)).toEqual(["file_id:1", "session:1", "lap:1", "record:20", "device_info:1", "activity:1"]);
    expect(summary.find((m) => m.name === "record")?.fields.find((f) => f.name === "heart_rate")?.withValue).toBe(10);
    expect(fitInfo(fit)).toEqual({ local: "2026-10-10T06:30", run: true });
  });
});
