import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AnthropicProvider } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createProxy, type ProxyDeps } from "../src/handler";
import { DEFAULT_POLICY } from "../src/policy";
import { serve } from "../src/server";
import { AccountStore } from "../src/store";

const ADMIN = "admin-secret";
const UPSTREAM_KEY = "sk-operator-key";

interface UpstreamCall {
  url: string;
  headers: Record<string, string>;
  body: any;
}

let driver: NodeSqliteDriver;
let store: AccountStore;
let upstreamCalls: UpstreamCall[];
let logs: string[];
let nowValue: Date;
let servers: Server[];

beforeEach(async () => {
  driver = openNodeSqlite(":memory:");
  store = new AccountStore(driver);
  await store.init();
  upstreamCalls = [];
  logs = [];
  nowValue = new Date("2026-10-10T04:00:00Z");
  servers = [];
});

afterEach(() => {
  for (const s of servers) s.close();
  driver.close();
});

function jsonUpstream(usage: Record<string, number> = { input_tokens: 1000, output_tokens: 200 }, status = 200) {
  return async (url: string | URL | Request, init?: RequestInit) => {
    upstreamCalls.push({
      url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers)),
      body: JSON.parse(String(init?.body)),
    });
    const payload =
      status === 200
        ? { id: "msg_1", type: "message", role: "assistant", content: [{ type: "text", text: "機密的教練回覆" }], stop_reason: "end_turn", usage }
        : { type: "error", error: { type: "overloaded_error", message: "Overloaded" } };
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json", "request-id": "req_1", "anthropic-ratelimit-requests-remaining": "99" },
    });
  };
}

function makeProxy(overrides: Partial<ProxyDeps> = {}) {
  return createProxy({
    store,
    policy: DEFAULT_POLICY,
    upstream: { baseUrl: "https://upstream.test", apiKey: UPSTREAM_KEY },
    adminToken: ADMIN,
    allowedOrigins: ["https://app.example"],
    fetch: jsonUpstream() as typeof fetch,
    now: () => nowValue,
    log: (line) => logs.push(line),
    ...overrides,
  });
}

async function createAccount(proxy: (r: Request) => Promise<Response>, body: object = {}) {
  const response = await proxy(
    new Request("http://proxy/admin/accounts", {
      method: "POST",
      headers: { authorization: `Bearer ${ADMIN}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; token: string };
}

const validBody = {
  model: "claude-sonnet-5-5",
  max_tokens: 16000,
  system: "你是教練",
  messages: [{ role: "user", content: "我的靜息心率 48，這正常嗎？" }],
  tools: [{ name: "get_training_plan", description: "x", input_schema: { type: "object", properties: {}, required: [] } }],
  output_config: { effort: "medium" },
};

function messages(token: string | null, body: unknown = validBody, headers: Record<string, string> = {}) {
  return new Request("http://proxy/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-api-key": token } : {}), ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as { error: { type: string; message: string } }).error };
}

describe("驗證與帳號狀態", () => {
  it("沒有憑證、憑證無效、帳號停用時拒絕，且不會呼叫上游", async () => {
    const proxy = makeProxy();
    const { id, token } = await createAccount(proxy);

    expect(await errorOf(await proxy(messages(null)))).toMatchObject({ status: 401, message: "缺少訂閱憑證" });
    expect(await errorOf(await proxy(messages("rc_wrong")))).toMatchObject({ status: 401, message: "訂閱憑證無效" });

    await proxy(
      new Request(`http://proxy/admin/accounts/${id}`, {
        method: "PATCH",
        headers: { "x-api-key": ADMIN },
        body: JSON.stringify({ status: "suspended" }),
      }),
    );
    expect(await errorOf(await proxy(messages(token)))).toMatchObject({ status: 403, message: "訂閱已停用" });
    expect(upstreamCalls).toHaveLength(0);
  });

  it("儲存的是憑證雜湊，不是憑證本身", async () => {
    const { token } = await createAccount(makeProxy());
    const rows = await driver.all("SELECT * FROM accounts");
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("轉發", () => {
  it("以營運者的金鑰原樣轉發，累計用量並回傳上游的內容", async () => {
    const proxy = makeProxy();
    const { id, token } = await createAccount(proxy);
    const response = await proxy(
      messages(token, validBody, { "anthropic-beta": "some-beta-2026", "anthropic-version": "2023-06-01" }),
    );

    expect(response.status).toBe(200);
    expect(((await response.json()) as any).content[0].text).toBe("機密的教練回覆");
    expect(response.headers.get("request-id")).toBe("req_1");
    // 上游的限流資訊屬於營運者，不外流
    expect(response.headers.get("anthropic-ratelimit-requests-remaining")).toBeNull();

    expect(upstreamCalls).toHaveLength(1);
    expect(upstreamCalls[0]!.url).toBe("https://upstream.test/v1/messages");
    expect(upstreamCalls[0]!.body).toEqual(validBody);
    expect(upstreamCalls[0]!.headers).toEqual({
      "content-type": "application/json",
      "x-api-key": UPSTREAM_KEY,
      "anthropic-version": "2023-06-01",
    });

    // sonnet：1000 × $2 + 200 × $10（每百萬 token）= $0.004
    expect(await store.getUsage(id, "2026-10")).toEqual({
      requests: 1,
      input: 1000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      costMicroUsd: 4000,
    });
  });

  it("請求與回應的內容不會出現在儲存或日誌中", async () => {
    const proxy = makeProxy();
    const { token } = await createAccount(proxy);
    await proxy(messages(token));

    const stored = JSON.stringify([
      await driver.all("SELECT * FROM accounts"),
      await driver.all("SELECT * FROM usage"),
    ]);
    for (const secret of ["靜息心率", "你是教練", "機密的教練回覆", token]) {
      expect(stored).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    expect(logs).toEqual([expect.stringMatching(/^acct_[0-9a-f]{16} claude-sonnet-5-5 200 in=1000 out=200 cost_microusd=4000$/)]);
  });

  it("快取 token 依各自的價格計費", async () => {
    const proxy = makeProxy({
      fetch: jsonUpstream({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 2_000,
      }) as typeof fetch,
    });
    const { id, token } = await createAccount(proxy);
    await proxy(messages(token, { ...validBody, model: "claude-opus-5-5" }));
    // opus：100×4 + 50×20 + 10000×0.2（讀）+ 2000×4×1.25（寫）= 13,400
    expect((await store.getUsage(id, "2026-10")).costMicroUsd).toBe(13_400);
  });

  it("上游錯誤原樣回傳，不計用量", async () => {
    const proxy = makeProxy({ fetch: jsonUpstream({}, 529) as typeof fetch });
    const { id, token } = await createAccount(proxy);
    expect(await errorOf(await proxy(messages(token)))).toMatchObject({ status: 529, type: "overloaded_error" });
    expect((await store.getUsage(id, "2026-10")).requests).toBe(0);
  });
});

describe("防濫用", () => {
  it("拒絕名單外的模型、超過上限的輸出、未允許的欄位與伺服器端工具", async () => {
    const proxy = makeProxy();
    const { token } = await createAccount(proxy);
    const reject = async (body: unknown) => (await errorOf(await proxy(messages(token, body)))).message;

    expect(await reject({ ...validBody, model: "claude-fable-5-1" })).toContain("不支援的模型：claude-fable-5-1");
    expect(await reject({ ...validBody, max_tokens: 64000 })).toBe("max_tokens 超過上限 16000");
    expect(await reject({ ...validBody, max_tokens: undefined })).toBe("max_tokens 必須是正整數");
    expect(await reject({ ...validBody, speed: "fast" })).toBe("不支援的欄位：speed");
    expect(await reject({ ...validBody, tools: [{ type: "web_search_20260209", name: "web_search" }] })).toBe(
      "不支援的工具類型：web_search_20260209",
    );
    expect(await reject("{not json")).toBe("請求內容不是有效的 JSON");
    expect(await reject([])).toBe("請求內容必須是 JSON 物件");
    expect((await errorOf(await proxy(messages(token, { ...validBody, system: "x".repeat(600_000) })))).status).toBe(413);
    expect(upstreamCalls).toHaveLength(0);
  });

  it("本月額度用完後拒絕，下個月自動恢復；可個別調整預算", async () => {
    // 每次請求 $0.004，預算 $0.01
    const proxy = makeProxy();
    const { id, token } = await createAccount(proxy, { monthly_budget_usd: 0.01 });
    for (let i = 0; i < 3; i++) expect((await proxy(messages(token))).status).toBe(200);
    expect(await errorOf(await proxy(messages(token)))).toMatchObject({
      status: 403,
      message: "本月額度已用完，下個月會自動恢復",
    });
    expect(upstreamCalls).toHaveLength(3);

    const usage = (await (await proxy(new Request("http://proxy/v1/usage", { headers: { "x-api-key": token } }))).json()) as any;
    expect(usage).toEqual({
      period: "2026-10",
      requests: 3,
      input_tokens: 3000,
      output_tokens: 600,
      cost_usd: 0.012,
      budget_usd: 0.01,
    });

    await proxy(
      new Request(`http://proxy/admin/accounts/${id}`, {
        method: "PATCH",
        headers: { "x-api-key": ADMIN },
        body: JSON.stringify({ monthly_budget_usd: 1 }),
      }),
    );
    expect((await proxy(messages(token))).status).toBe(200);

    await proxy(
      new Request(`http://proxy/admin/accounts/${id}`, {
        method: "PATCH",
        headers: { "x-api-key": ADMIN },
        body: JSON.stringify({ monthly_budget_usd: 0.01 }),
      }),
    );
    expect((await proxy(messages(token))).status).toBe(403);
    nowValue = new Date("2026-11-01T00:00:01Z");
    expect((await proxy(messages(token))).status).toBe(200);
  });

  it("每分鐘請求數超過上限時回 429", async () => {
    const proxy = makeProxy({ policy: { ...DEFAULT_POLICY, requestsPerMinute: 2 } });
    const { token } = await createAccount(proxy);
    expect((await proxy(messages(token))).status).toBe(200);
    expect((await proxy(messages(token))).status).toBe(200);
    const limited = await proxy(messages(token));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("30");
    nowValue = new Date(nowValue.getTime() + 60_000);
    expect((await proxy(messages(token))).status).toBe(200);
  });
});

describe("串流", () => {
  const events = [
    `event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":800,"cache_read_input_tokens":200,"output_tokens":1}}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"今天"}}\n\n`,
    `event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"跑得不錯"}}\n\n`,
    `event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":120}}\n\n`,
    `event: message_stop\ndata: {"type":"message_stop"}\n\n`,
  ];

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

  it("位元組原樣轉發，結束後依事件中的 usage 計量", async () => {
    // 刻意把事件切在奇怪的位置，確認跨區塊的事件也能解析
    const joined = events.join("");
    const proxy = makeProxy({ fetch: sseUpstream([joined.slice(0, 70), joined.slice(70, 300), joined.slice(300)]) });
    const { id, token } = await createAccount(proxy);
    const response = await proxy(messages(token, { ...validBody, stream: true }));

    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(joined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.getUsage(id, "2026-10")).toMatchObject({ requests: 1, input: 800, cacheRead: 200, output: 120 });
  });

  it("下游提早中斷時仍記錄已知的用量", async () => {
    const proxy = makeProxy({ fetch: sseUpstream(events) });
    const { id, token } = await createAccount(proxy);
    const response = await proxy(messages(token, { ...validBody, stream: true }));
    const reader = response.body!.getReader();
    await reader.read();
    await reader.cancel();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(await store.getUsage(id, "2026-10")).toMatchObject({ requests: 1, input: 800, cacheRead: 200, output: 1 });
  });
});

describe("跨來源與管理端點", () => {
  it("只對允許的來源回應 CORS 標頭，預檢放行 SDK 要求的標頭", async () => {
    const proxy = makeProxy();
    const preflight = await proxy(
      new Request("http://proxy/v1/messages", {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": "x-api-key,anthropic-version,x-stainless-os",
        },
      }),
    );
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(preflight.headers.get("access-control-allow-headers")).toBe("x-api-key,anthropic-version,x-stainless-os");

    const { token } = await createAccount(proxy);
    const allowed = await proxy(messages(token, validBody, { origin: "https://app.example" }));
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example");
    const other = await proxy(messages(token, validBody, { origin: "https://evil.example" }));
    expect(other.headers.get("access-control-allow-origin")).toBeNull();
    // 錯誤回應也要帶 CORS 標頭，瀏覽器端才讀得到錯誤訊息
    const failed = await proxy(messages(null, validBody, { origin: "https://app.example" }));
    expect(failed.headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  it("管理端點需要管理憑證；未設定管理憑證時整組停用", async () => {
    const proxy = makeProxy();
    const create = (token: string) =>
      proxy(new Request("http://proxy/admin/accounts", { method: "POST", headers: { "x-api-key": token }, body: "{}" }));
    expect((await create("wrong")).status).toBe(401);
    const { token: userToken } = await createAccount(proxy);
    expect((await create(userToken)).status).toBe(401);

    const disabled = makeProxy({ adminToken: undefined });
    expect((await disabled(new Request("http://proxy/admin/accounts", { method: "POST", body: "{}" }))).status).toBe(404);
  });

  it("可查詢帳號、重發憑證（舊憑證失效）", async () => {
    const proxy = makeProxy();
    const { id, token } = await createAccount(proxy);
    await proxy(messages(token));

    const view = await proxy(new Request(`http://proxy/admin/accounts/${id}`, { headers: { "x-api-key": ADMIN } }));
    expect(await view.json()).toEqual({
      id,
      status: "active",
      monthly_budget_usd: 3,
      usage: { period: "2026-10", requests: 1, cost_usd: 0.004 },
    });

    const rotated = (await (
      await proxy(new Request(`http://proxy/admin/accounts/${id}/rotate-token`, { method: "POST", headers: { "x-api-key": ADMIN } }))
    ).json()) as { token: string };
    expect((await proxy(messages(token))).status).toBe(401);
    expect((await proxy(messages(rotated.token))).status).toBe(200);
    expect(
      (await proxy(new Request("http://proxy/admin/accounts/acct_missing", { headers: { "x-api-key": ADMIN } }))).status,
    ).toBe(404);
  });
});

describe("端對端：核心的 Claude 轉接 → 代理 → 上游", () => {
  it("客戶端只需把 baseURL 指向代理並帶上訂閱憑證", async () => {
    const received: { key: string | undefined; body: any }[] = [];
    const upstream = createServer((req, res) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        received.push({ key: req.headers["x-api-key"] as string, body: JSON.parse(raw) });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "msg_1",
            type: "message",
            role: "assistant",
            model: "claude-sonnet-5-5",
            content: [{ type: "text", text: "輕鬆跑 8 公里" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage: { input_tokens: 500, output_tokens: 30 },
          }),
        );
      });
    });
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    servers.push(upstream);
    const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    const proxy = makeProxy({ fetch: undefined, upstream: { baseUrl: upstreamUrl, apiKey: UPSTREAM_KEY } });
    const { id, token } = await createAccount(proxy);
    const server = await serve(proxy, 0, "127.0.0.1");
    servers.push(server);
    const proxyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const turn = await new AnthropicProvider({ apiKey: token, baseURL: proxyUrl })
      .startChat({
        model: "claude-sonnet-5-5",
        system: "你是教練",
        messages: [{ role: "user", content: "明天練什麼？" }],
        maxTokens: 16000,
        effort: "medium",
      })
      .next();

    expect(turn).toMatchObject({ text: "輕鬆跑 8 公里", finish: "ok", usage: { input: 500, output: 30 } });
    expect(received).toHaveLength(1);
    expect(received[0]!.key).toBe(UPSTREAM_KEY);
    expect(received[0]!.body).toEqual({
      model: "claude-sonnet-5-5",
      max_tokens: 16000,
      system: "你是教練",
      messages: [{ role: "user", content: "明天練什麼？" }],
      output_config: { effort: "medium" },
    });
    expect(await store.getUsage(id, "2026-10")).toMatchObject({ requests: 1, input: 500, output: 30, costMicroUsd: 1300 });
  });
});
