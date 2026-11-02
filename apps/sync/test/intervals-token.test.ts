import { describe, expect, it } from "vitest";

import { handleIntervalsToken, INTERVALS_TOKEN_URL, isIntervalsTokenPath, type IntervalsTokenDeps } from "../src/intervals-token";

const ORIGIN = "https://staging.example.com";

function request(body: unknown, { origin = ORIGIN, method = "POST" }: { origin?: string | null; method?: string } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (origin) headers.origin = origin;
  return new Request("https://sync.example.com/v1/intervals/token", {
    method,
    headers,
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });
}

/** 記下送到 Intervals.icu 的請求，回固定的結果 */
function upstream(status = 200, payload: unknown = { token_type: "Bearer", access_token: "tok-123", scope: "ACTIVITY:READ,WELLNESS:READ,SETTINGS:READ", athlete: { id: "i42", name: "Runner" } }) {
  const calls: { url: string; body: string }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const deps = (extra: Partial<IntervalsTokenDeps> = {}): IntervalsTokenDeps => ({
  clientId: "client-1",
  clientSecret: "secret-1",
  allowedOrigins: [ORIGIN],
  ...extra,
});

describe("Intervals.icu 登入的換 token（規格 12.37）", () => {
  it("帶上 client_secret 向 Intervals.icu 換 token，只回 token、選手與範圍；不快取", async () => {
    const { calls, fetchImpl } = upstream();
    const res = await handleIntervalsToken(request({ code: "abc123", redirect_uri: `${ORIGIN}/` }), deps({ fetch: fetchImpl }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(await res.json()).toEqual({ access_token: "tok-123", athlete_id: "i42", athlete_name: "Runner", scope: "ACTIVITY:READ,WELLNESS:READ,SETTINGS:READ" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(INTERVALS_TOKEN_URL);
    const form = new URLSearchParams(calls[0]!.body);
    expect(Object.fromEntries(form)).toEqual({ client_id: "client-1", client_secret: "secret-1", code: "abc123", redirect_uri: `${ORIGIN}/` });
  });

  it("來源不對：403、不轉送、不給 CORS；預檢也一樣", async () => {
    const { calls, fetchImpl } = upstream();
    const res = await handleIntervalsToken(request({ code: "abc123" }, { origin: "https://evil.example.com" }), deps({ fetch: fetchImpl }));
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    expect((await handleIntervalsToken(request({ code: "abc123" }, { origin: null }), deps({ fetch: fetchImpl }))).status).toBe(403);
    expect((await handleIntervalsToken(request(null, { origin: "https://evil.example.com", method: "OPTIONS" }), deps())).status).toBe(403);
    const pre = await handleIntervalsToken(request(null, { method: "OPTIONS" }), deps());
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
    expect(calls).toHaveLength(0);
  });

  it("沒有設定 client_id 或 client_secret：404「沒有設定」，不轉送", async () => {
    const { calls, fetchImpl } = upstream();
    for (const extra of [{ clientSecret: undefined }, { clientId: "" }]) {
      const res = await handleIntervalsToken(request({ code: "abc123" }), deps({ ...extra, fetch: fetchImpl }));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "not_configured" });
    }
    expect(calls).toHaveLength(0);
  });

  it("授權碼格式不對、回呼網址不是這個來源、內容太大：400／413，不轉送", async () => {
    const { calls, fetchImpl } = upstream();
    const d = deps({ fetch: fetchImpl });
    expect((await handleIntervalsToken(request({ code: "a b" }), d)).status).toBe(400);
    expect((await handleIntervalsToken(request({}), d)).status).toBe(400);
    expect((await handleIntervalsToken(request("not json"), d)).status).toBe(400);
    expect((await handleIntervalsToken(request({ code: "abc123", redirect_uri: "https://evil.example.com/" }), d)).status).toBe(400);
    expect((await handleIntervalsToken(request({ code: "x".repeat(5000) }), d)).status).toBe(413);
    expect(calls).toHaveLength(0);
  });

  it("Intervals.icu 拒絕（授權碼過期或用過）：400 invalid_code；連不上或回壞的：502；不轉送原文", async () => {
    const rejected = upstream(400, { error: "invalid_grant", error_description: "secret details" });
    const res = await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: rejected.fetchImpl }));
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "invalid_code" });
    expect(text).not.toContain("secret");
    expect((await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: upstream(500, {}).fetchImpl }))).status).toBe(502);
    expect((await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: upstream(200, { nope: 1 }).fetchImpl }))).status).toBe(502);
    const down = (async () => {
      throw new TypeError("network");
    }) as unknown as typeof fetch;
    expect((await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: down }))).status).toBe(502);
  });

  it("不存、不記：處理過程沒有任何 console 輸出", async () => {
    const logged: unknown[] = [];
    const original = { log: console.log, warn: console.warn, error: console.error, info: console.info };
    console.log = console.warn = console.error = console.info = (...args: unknown[]) => void logged.push(args);
    try {
      await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: upstream().fetchImpl }));
      await handleIntervalsToken(request({ code: "abc123" }), deps({ fetch: upstream(400, {}).fetchImpl }));
    } finally {
      Object.assign(console, original);
    }
    expect(logged).toEqual([]);
  });

  it("路徑：/v1/intervals/token（模擬服務放在 /sync 底下也認得）", () => {
    expect(isIntervalsTokenPath("/v1/intervals/token")).toBe(true);
    expect(isIntervalsTokenPath("/sync/v1/intervals/token")).toBe(true);
    expect(isIntervalsTokenPath("/v1/spaces/abc")).toBe(false);
  });
});
