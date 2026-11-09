import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { accessToken, fetchFits } from "../garmin-fetch-fit";
import { fakeRunFit, zipOne } from "../lib/fit-fixture";

const KEY = "secret-garmin-key-123456";
const TOKEN = "secret-access-token-abcdef";

/** 模擬 Garmin 個人 API：換 token 回純文字、資料端點要 Bearer、列活動照日期分段 */
function garmin(activities: { id: number; date: string; type: string }[], opts: { tokenStatus?: number } = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/personal-api-key/token")) {
      if (opts.tokenStatus) return new Response("", { status: opts.tokenStatus });
      return auth === `ApiKey ${KEY}` ? new Response(TOKEN, { status: 200, headers: { "content-type": "text/plain" } }) : new Response("", { status: 401 });
    }
    if (auth !== `Bearer ${TOKEN}`) return new Response("", { status: 401 });
    if (url.pathname.endsWith("/activities/search/activities")) {
      const [from, to] = [url.searchParams.get("startDate")!, url.searchParams.get("endDate")!];
      const start = Number(url.searchParams.get("start"));
      const list = activities.filter((a) => a.date >= from && a.date <= to).slice(start, start + 99);
      return Response.json(list.map((a) => ({ activityId: a.id, startTimeLocal: `${a.date} 06:30:00`, activityType: { typeKey: a.type } })));
    }
    const m = /\/download-service\/files\/activity\/(\d+)$/.exec(url.pathname);
    if (m) return m[1] === "13" ? new Response("oops", { status: 500 }) : new Response(zipOne(`${m[1]}_ACTIVITY.fit`, fakeRunFit()), { status: 200 });
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "garmin-fit-"));
  dirs.push(d);
  return d;
};

describe("garmin-fetch-fit", () => {
  it("換 token（純文字）、分段列活動、下載 zip、已經有的不重抓、只抓指定類型、不印 key 與 token", async () => {
    const acts = [
      { id: 11, date: "2026-11-08", type: "running" },
      { id: 12, date: "2026-10-01", type: "cycling" },
      { id: 13, date: "2026-09-20", type: "running" },
      { id: 14, date: "2026-11-01", type: "walking" },
    ];
    const { fetch, calls } = garmin(acts);
    const out = tmp();
    writeFileSync(join(out, "2026-10-01_cycling_12.zip"), "old");
    const logs: string[] = [];
    const result = await fetchFits({ apiKey: KEY, fetch, today: "2026-11-09", days: 60, outDir: out, types: ["running", "cycling"], delayMs: 0, log: (l) => logs.push(l) });
    expect(result).toEqual({ listed: 3, downloaded: 1, skipped: 1, failed: 1 });
    expect(readdirSync(out).sort()).toEqual(["2026-10-01_cycling_12.zip", "2026-11-08_running_11.zip"]);
    // 60 天分成 3 段（每段 28 天）
    expect(calls.filter((c) => c.includes("/activities/search/activities"))).toHaveLength(3);
    const text = logs.join("\n");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain(TOKEN);
  });

  it("key 不對：說明怎麼處理，不印 key", async () => {
    const { fetch } = garmin([], { tokenStatus: 401 });
    await expect(accessToken(fetch, "https://x/personal-api-key/token", KEY)).rejects.toThrow(/key 不對、過期或被刪了/);
    await expect(fetchFits({ apiKey: KEY, fetch, today: "2026-11-09", days: 7, outDir: tmp(), delayMs: 0 })).rejects.not.toThrow(KEY);
  });

  it("換 token 的回應是 JSON 也可以", async () => {
    const f = (async () => Response.json({ accessToken: TOKEN })) as unknown as typeof fetch;
    expect(await accessToken(f, "https://x/token", KEY)).toBe(TOKEN);
  });
});
