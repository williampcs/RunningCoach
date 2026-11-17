/** 代理的頻率限制與請求檢查（規格 12.39）：計數跨請求有效、工具迴圈的接續另外算、只轉發教練會送的內容、快取用 5 分鐘、上游出錯時的計費. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createProxy, type ProxyDeps } from "../src/handler";
import { DEFAULT_POLICY, loadPolicy, type Policy } from "../src/policy";
import { AccountStore } from "../src/store";

const ADMIN = "admin-secret";

let driver: NodeSqliteDriver;
let store: AccountStore;
let limiter: SqlRateLimiter;
let nowValue: Date;
let upstreamBodies: any[];
let logs: string[];

beforeEach(async () => {
  driver = openNodeSqlite(":memory:");
  store = new AccountStore(driver);
  await store.init();
  limiter = new SqlRateLimiter(driver, () => nowValue.getTime());
  await limiter.init();
  nowValue = new Date("2026-11-17T04:00:00Z");
  upstreamBodies = [];
  logs = [];
});

afterEach(() => driver.close());

async function jsonUpstream(_url: string | URL | Request, init?: RequestInit) {
  upstreamBodies.push(JSON.parse(String(init?.body)));
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "回覆" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

/** 像 Workers 一樣每個請求都重新建立代理；計數用共用的 D1（這裡是同一個 SQLite） */
function freshProxy(policy: Partial<Policy> = {}, overrides: Partial<ProxyDeps> = {}) {
  return (request: Request) =>
    createProxy({
      store,
      policy: { ...DEFAULT_POLICY, ...policy },
      upstream: { baseUrl: "https://upstream.test", apiKey: "sk-operator" },
      adminToken: ADMIN,
      allowedOrigins: [],
      fetch: jsonUpstream as typeof fetch,
      now: () => nowValue,
      log: (line) => logs.push(line),
      rateLimiter: limiter,
      ...overrides,
    })(request);
}

type Proxy = (r: Request) => Promise<Response>;

async function newAccount(proxy: Proxy) {
  const response = await proxy(new Request("http://proxy/admin/accounts", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: "{}" }));
  return (await response.json()) as { id: string; token: string };
}

async function invites(proxy: Proxy, count: number) {
  const response = await proxy(
    new Request("http://proxy/admin/invites", { method: "POST", headers: { authorization: `Bearer ${ADMIN}` }, body: JSON.stringify({ count }) }),
  );
  return ((await response.json()) as { invites: { code: string }[] }).invites.map((i) => i.code);
}

const redeem = (proxy: Proxy, code: string, ip: string) =>
  proxy(new Request("http://proxy/v1/redeem", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ code }) }));

const chatBody = (extra: Record<string, unknown> = {}) => ({
  model: "claude-haiku-5-5",
  max_tokens: 1000,
  system: "你是教練",
  messages: [{ role: "user", content: "今天跑 8 公里會不會太多？" }],
  ...extra,
});

const toolLoopBody = chatBody({
  messages: [
    { role: "user", content: "今天跑 8 公里會不會太多？" },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "想一下", signature: "sig" },
        { type: "redacted_thinking", data: "xxx" },
        { type: "tool_use", id: "t1", name: "get_recent_runs", input: {} },
      ],
    },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "最近的跑步" }] },
  ],
});

const send = (proxy: Proxy, token: string, body: unknown = chatBody()) =>
  proxy(new Request("http://proxy/v1/messages", { method: "POST", headers: { "x-api-key": token }, body: JSON.stringify(body) }));

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as any).error };
}

describe("頻率限制跨請求有效（每個請求都是新的代理）", () => {
  it("每個帳號每分鐘的請求數；別的帳號不受影響；下一分鐘恢復", async () => {
    const proxy = freshProxy({ requestsPerMinute: 3 });
    const a = await newAccount(proxy);
    const b = await newAccount(proxy);
    for (let i = 0; i < 3; i++) expect((await send(proxy, a.token)).status).toBe(200);
    expect(await errorOf(await send(proxy, a.token))).toMatchObject({ status: 429, type: "rate_limit_error" });
    expect((await send(proxy, b.token)).status).toBe(200);
    nowValue = new Date(nowValue.getTime() + 60_000);
    expect((await send(proxy, a.token)).status).toBe(200);
  });

  it("兌換邀請碼、連結碼與取回：每個來源 IP 每分鐘的次數，IP 只存雜湊", async () => {
    const proxy = freshProxy({ redeemsPerMinute: 2 });
    const codes = await invites(proxy, 4);
    expect((await redeem(proxy, codes[0]!, "198.51.100.7")).status).toBe(201);
    expect((await redeem(proxy, "RC-2222-2222-2222", "198.51.100.7")).status).toBe(400);
    expect(await errorOf(await redeem(proxy, codes[1]!, "198.51.100.7"))).toMatchObject({ status: 429, type: "rate_limit_error" });
    const link = await proxy(new Request("http://proxy/v1/link", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" }, body: '{"code":"2222-2222"}' }));
    expect(link.status).toBe(429);
    expect((await redeem(proxy, codes[2]!, "198.51.100.8")).status).toBe(201);
    expect(JSON.stringify(await driver.all("SELECT key FROM rate_limits"))).not.toContain("198.51.100");
  });
});

describe("工具迴圈的接續另外算", () => {
  it("每天的上限：到了回和對話一樣格式的錯誤；新的一則照常扣則數", async () => {
    const proxy = freshProxy({ dailyMessages: 5, dailyToolTurns: 2 });
    const { token } = await newAccount(proxy);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect(await errorOf(await send(proxy, token, toolLoopBody))).toMatchObject({
      status: 403,
      type: "daily_limit",
      limit: 5,
      resets_at: "2026-11-18T00:00:00+08:00",
    });
    // 最後一則不是選手的（例如 assistant）也算接續
    const assistantLast = chatBody({ messages: [{ role: "user", content: "嗨" }, { role: "assistant", content: "好" }] });
    expect((await send(proxy, token, assistantLast)).status).toBe(403);
    expect((await send(proxy, token)).status).toBe(200);
    const usage = (await (await proxy(new Request("http://proxy/v1/usage", { headers: { "x-api-key": token } }))).json()) as any;
    expect(usage.today).toMatchObject({ messages_used: 1, messages_limit: 5 });
    expect(await store.getDaily((await store.listAccounts())[0]!.id, "2026-11-17")).toMatchObject({ chat: 1, tool: 2 });
  });

  it("預設是每天則數的 10 倍", async () => {
    const proxy = freshProxy({ dailyMessages: 1 });
    const { token } = await newAccount(proxy);
    for (let i = 0; i < 10; i++) expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(403);
  });

  it("政策：dailyToolTurns 要是不小於 0 的數字或 null", () => {
    expect(loadPolicy('{"dailyToolTurns":40}').dailyToolTurns).toBe(40);
    expect(() => loadPolicy('{"dailyToolTurns":-1}')).toThrow(/dailyToolTurns/);
  });
});

describe("只轉發教練會送的內容區塊", () => {
  it("文字、思考、工具呼叫與結果可以；圖片、文件等被拒絕，不呼叫上游", async () => {
    const proxy = freshProxy();
    const { token } = await newAccount(proxy);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect((await send(proxy, token, chatBody({ system: [{ type: "text", text: "你是教練" }] }))).status).toBe(200);
    const before = upstreamBodies.length;
    const image = { type: "image", source: { type: "url", url: "https://example.com/a.png" } };
    const pdf = { type: "document", source: { type: "base64", media_type: "application/pdf", data: "JVBERi0=" } };
    const rejected = [
      chatBody({ messages: [{ role: "user", content: [{ type: "text", text: "看圖" }, image] }] }),
      chatBody({ messages: [{ role: "user", content: [pdf] }] }),
      chatBody({ messages: [{ role: "user", content: [{ type: "document", source: { type: "file", file_id: "file_1" } }] }] }),
      chatBody({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [pdf] }] }] }),
      chatBody({ messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [image] }] }] }),
      chatBody({ system: [image] }),
      chatBody({ messages: [{ role: "user", content: [{ type: "search_result", source: "x", title: "t", content: [] }] }] }),
      chatBody({ messages: [{ role: "system", content: "hi" }] }),
      chatBody({ messages: [{ role: "user", content: { type: "text", text: "x" } }] }),
    ];
    for (const body of rejected) expect(await errorOf(await send(proxy, token, body))).toMatchObject({ status: 400, type: "invalid_request_error" });
    expect(upstreamBodies).toHaveLength(before);
  });
});

describe("快取一律 5 分鐘", () => {
  it("cache_control 的 ttl 被拿掉（請求、system、訊息、工具結果、工具）", async () => {
    const proxy = freshProxy();
    const { token } = await newAccount(proxy);
    const hour = { type: "ephemeral", ttl: "1h" };
    await send(
      proxy,
      token,
      chatBody({
        cache_control: hour,
        system: [{ type: "text", text: "你是教練", cache_control: hour }],
        tools: [{ name: "get_recent_runs", description: "x", input_schema: { type: "object" }, cache_control: hour }],
        messages: [
          { role: "user", content: [{ type: "text", text: "嗨", cache_control: hour }] },
          { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_recent_runs", input: {} }] },
          { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "資料", cache_control: hour }], cache_control: hour }] },
        ],
      }),
    );
    const forwarded = JSON.stringify(upstreamBodies.at(-1));
    expect(forwarded).not.toContain("ttl");
    expect(forwarded.match(/"cache_control":\{"type":"ephemeral"\}/g)).toHaveLength(6);
  });
});

describe("串流以上游的 error 事件結束", () => {
  function sseUpstream(chunks: string[]) {
    return (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
            controller.close();
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )) as unknown as typeof fetch;
  }

  const start = `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":800,"output_tokens":1}}}\n\n`;
  const delta = `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"今天"}}\n\n`;
  const error = `event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n`;

  it("輸出照讀到的最後數字算，不照最多的輸出", async () => {
    const proxy = freshProxy({}, { fetch: sseUpstream([start, delta, error]) });
    const { id, token } = await newAccount(proxy);
    const response = await send(proxy, token, chatBody({ stream: true, max_tokens: 16000 }));
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 5));
    // Haiku：800×0.1 + 1×0.5 → 81
    expect(await store.getUsage(id, "2026-11")).toMatchObject({ requests: 1, input: 800, output: 1, costMicroUsd: 81 });
    expect(logs.at(-1)).toMatch(/out=1 cost_microusd=81 \(upstream error\)$/);
  });

  it("下游中斷的照舊照預扣的輸出", async () => {
    const proxy = freshProxy({}, { fetch: sseUpstream([start, delta, delta]) });
    const { id, token } = await newAccount(proxy);
    const response = await send(proxy, token, chatBody({ stream: true, max_tokens: 16000 }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.getUsage(id, "2026-11")).toMatchObject({ output: 16000 });
  });
});
