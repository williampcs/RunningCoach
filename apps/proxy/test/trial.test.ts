/** 免費試用的內測（規格 12.39）：邀請碼、每天的次數、總預算、固定的模型、刪除帳號、保存期限. */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AddressInfo } from "node:net";

import { AnthropicProvider } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { serve } from "../src/server";

import { createProxy, isNewTurn, normalizeInviteCode, purgeOld, type ProxyDeps } from "../src/handler";
import { DEFAULT_POLICY, loadPolicy, type Policy } from "../src/policy";
import { AccountStore } from "../src/store";

const ADMIN = "admin-secret";

let driver: NodeSqliteDriver;
let store: AccountStore;
let upstreamBodies: any[];
let upstreamHeaders: Record<string, string>[];
let logs: string[];
let nowValue: Date;
let upstreamStatus: number;

beforeEach(async () => {
  driver = openNodeSqlite(":memory:");
  store = new AccountStore(driver);
  await store.init();
  upstreamBodies = [];
  upstreamHeaders = [];
  logs = [];
  upstreamStatus = 200;
  // 台灣時間 2026-11-10 12:00
  nowValue = new Date("2026-11-10T04:00:00Z");
});

afterEach(() => driver.close());

// 每次 1000 輸入、200 輸出：Haiku 5.5 是 1000×0.1 + 200×0.5 = 200 百萬分之一美元
async function upstream(_url: string | URL | Request, init?: RequestInit) {
  upstreamBodies.push(JSON.parse(String(init?.body)));
  upstreamHeaders.push(Object.fromEntries(new Headers(init?.headers)));
  if (upstreamStatus !== 200) {
    return Response.json({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, { status: upstreamStatus });
  }
  return Response.json({
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "機密的教練回覆" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1000, output_tokens: 200 },
  });
}

function makeProxy(policy: Partial<Policy> = {}, overrides: Partial<ProxyDeps> = {}) {
  return createProxy({
    store,
    policy: { ...DEFAULT_POLICY, ...policy },
    upstream: { baseUrl: "https://upstream.test", apiKey: "sk-operator" },
    adminToken: ADMIN,
    allowedOrigins: ["https://app.example"],
    fetch: upstream as typeof fetch,
    now: () => nowValue,
    log: (line) => logs.push(line),
    ...overrides,
  });
}

type Proxy = (r: Request) => Promise<Response>;

async function admin(proxy: Proxy, method: string, path: string, body?: object) {
  const response = await proxy(
    new Request(`http://proxy${path}`, { method, headers: { authorization: `Bearer ${ADMIN}` }, body: body ? JSON.stringify(body) : undefined }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function invite(proxy: Proxy, body: object = {}) {
  const result = await admin(proxy, "POST", "/admin/invites", body);
  expect(result.status).toBe(201);
  return result.body.invites as { id: string; code: string; expires_at: string | null }[];
}

async function redeem(proxy: Proxy, code: string, ip = "203.0.113.1") {
  const response = await proxy(
    new Request("http://proxy/v1/redeem", { method: "POST", headers: { "cf-connecting-ip": ip }, body: JSON.stringify({ code }) }),
  );
  return { status: response.status, body: (await response.json()) as any };
}

async function account(proxy: Proxy) {
  const [first] = await invite(proxy);
  const result = await redeem(proxy, first!.code);
  expect(result.status).toBe(201);
  return result.body as { account_id: string; token: string };
}

const chatBody = (content: unknown = "今天跑 8 公里會不會太多？") => ({
  model: "claude-opus-5-5",
  max_tokens: 32000,
  system: "你是教練",
  messages: [{ role: "user", content }],
  output_config: { effort: "high" },
});

const toolLoopBody = {
  ...chatBody(),
  messages: [
    { role: "user", content: "今天跑 8 公里會不會太多？" },
    { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "get_recent_runs", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "最近的跑步" }] },
  ],
};

function send(proxy: Proxy, token: string, body: unknown = chatBody(), meter?: string) {
  return proxy(
    new Request("http://proxy/v1/messages", {
      method: "POST",
      headers: { "x-api-key": token, ...(meter ? { "x-coach-meter": meter } : {}) },
      body: JSON.stringify(body),
    }),
  );
}

async function usageOf(proxy: Proxy, token: string) {
  return (await (await proxy(new Request("http://proxy/v1/usage", { headers: { "x-api-key": token } }))).json()) as any;
}

async function errorOf(response: Response) {
  return { status: response.status, ...((await response.json()) as any).error };
}

describe("邀請碼", () => {
  it("產生的邀請碼只回傳一次、只存雜湊；兌換一次拿到帳號與憑證", async () => {
    const proxy = makeProxy();
    const codes = await invite(proxy, { count: 3, label: "第一批", monthly_budget_usd: 5, expires_at: "2026-12-31" });
    expect(codes).toHaveLength(3);
    for (const c of codes) expect(c.code).toMatch(/^RC-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(new Set(codes.map((c) => c.code)).size).toBe(3);
    // 到期日是那一天結束（台灣時間）
    expect(codes[0]!.expires_at).toBe("2026-12-31T15:59:59.999Z");

    const stored = JSON.stringify(await driver.all("SELECT * FROM invites"));
    for (const c of codes) expect(stored).not.toContain(c.code.replace(/-/g, "").slice(2));
    expect(logs.join("\n")).not.toContain(codes[0]!.code);

    // 小寫、空白都可以
    const result = await redeem(proxy, `  ${codes[0]!.code.toLowerCase().replace(/-/g, " ")} `);
    expect(result).toMatchObject({ status: 201, body: { model: "claude-haiku-5-5", daily_messages: 15, daily_auto: 2 } });
    expect(result.body.token).toMatch(/^rc_[0-9a-f]{64}$/);

    const accounts = (await admin(proxy, "GET", "/admin/accounts")).body.accounts;
    expect(accounts).toEqual([expect.objectContaining({ id: result.body.account_id, invite_id: codes[0]!.id, monthly_budget_usd: 5 })]);
    expect(JSON.stringify(await driver.all("SELECT * FROM accounts"))).not.toContain(result.body.token);

    const list = (await admin(proxy, "GET", "/admin/invites")).body.invites;
    expect(list.map((i: any) => i.status)).toEqual(["used", "unused", "unused"]);
    expect(list[0]).toMatchObject({ label: "第一批", account_id: result.body.account_id });
  });

  it("一碼用一次；停用、過期、打錯、格式不對都拒絕", async () => {
    const proxy = makeProxy();
    const [a, b, c] = await invite(proxy, { count: 3 });
    expect((await redeem(proxy, a!.code)).status).toBe(201);
    expect(await redeem(proxy, a!.code)).toMatchObject({ status: 400, body: { error: { type: "invalid_invite", reason: "used", message: "這個邀請碼已經用過了" } } });

    expect((await admin(proxy, "PATCH", `/admin/invites/${b!.id}`, { revoked: true })).body.status).toBe("revoked");
    expect((await redeem(proxy, b!.code)).body.error.reason).toBe("revoked");

    expect((await redeem(proxy, "RC-2222-3333-4444")).body.error.reason).toBe("unknown");
    expect((await redeem(proxy, "hello")).body.error.message).toContain("格式不對");

    const [expiring] = await invite(proxy, { expires_at: "2026-11-10" });
    nowValue = new Date("2026-11-10T16:00:00Z"); // 台灣 11-11 00:00
    expect((await redeem(proxy, expiring!.code)).body.error.reason).toBe("expired");
    expect((await redeem(proxy, c!.code)).status).toBe(201);
  });

  it("同一張碼同時兌換兩次，只有一次成功", async () => {
    const proxy = makeProxy();
    const [only] = await invite(proxy);
    const results = await Promise.all([redeem(proxy, only!.code), redeem(proxy, only!.code)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
    expect(await driver.all("SELECT * FROM accounts")).toHaveLength(1);
  });

  it("同一個 IP 每分鐘最多試 10 次", async () => {
    const proxy = makeProxy();
    for (let i = 0; i < 10; i++) expect((await redeem(proxy, "RC-2222-3333-4444")).status).toBe(400);
    expect((await redeem(proxy, "RC-2222-3333-4444")).status).toBe(429);
    expect((await redeem(proxy, "RC-2222-3333-4444", "203.0.113.2")).status).toBe(400);
  });

  it("停用帳號後拒絕；恢復後可以再用", async () => {
    const proxy = makeProxy();
    const { account_id, token } = await account(proxy);
    await admin(proxy, "PATCH", `/admin/accounts/${account_id}`, { status: "suspended" });
    expect(await errorOf(await send(proxy, token))).toMatchObject({ status: 403, message: "這個試用帳號已停用" });
    await admin(proxy, "PATCH", `/admin/accounts/${account_id}`, { status: "active" });
    expect((await send(proxy, token)).status).toBe(200);
  });

  it("管理端點要管理憑證", async () => {
    const proxy = makeProxy();
    const response = await proxy(new Request("http://proxy/admin/invites", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    expect((await admin(proxy, "POST", "/admin/invites", { count: 51 })).status).toBe(400);
  });

  it("邀請碼的格式：大小寫、空白與連字號不計較，容易看錯的字不收", () => {
    expect(normalizeInviteCode("rc-abcd-efgh-jkmn")).toBe("ABCDEFGHJKMN");
    expect(normalizeInviteCode("ABCD EFGH JKMN")).toBe("ABCDEFGHJKMN");
    expect(normalizeInviteCode("RC-ABCD-EFGH-JKM0")).toBeNull();
    expect(normalizeInviteCode("RC-ABCD-EFGH")).toBeNull();
  });
});

describe("固定的模型與思考強度", () => {
  it("預設：換成 Haiku、思考強度固定 low（不送 thinking）、輸出夾到上限（規格 12.43）", async () => {
    const proxy = makeProxy();
    const { token } = await account(proxy);
    expect((await send(proxy, token)).status).toBe(200);
    expect(upstreamBodies[0]).toMatchObject({ model: "claude-haiku-5-5", max_tokens: 16000, output_config: { effort: "low" } });
    expect(upstreamBodies[0].thinking).toBeUndefined();
    // 請求帶了 thinking 也拿掉；output_config 的其他欄位保留
    await send(proxy, token, { ...chatBody(), thinking: { type: "disabled" }, output_config: { effort: "max", format: { type: "json_schema", schema: {} } } }, "auto");
    expect(upstreamBodies[1].thinking).toBeUndefined();
    expect(upstreamBodies[1].output_config).toEqual({ effort: "low", format: { type: "json_schema", schema: {} } });
    // 沒有 output_config 的（摘要）也加上
    const { output_config: _, ...plain } = chatBody();
    await send(proxy, token, plain, "compress");
    expect(upstreamBodies[2].output_config).toEqual({ effort: "low" });
    // 用量照實際用的模型算；用量端點回思考強度
    const usage = await usageOf(proxy, token);
    expect(usage.cost_usd).toBe(0.0006);
    expect(usage).toMatchObject({ model: "claude-haiku-5-5", thinking: true, effort: "low" });
    // 選手的 key 不會用到，上游拿到的是作者的 key
    expect(upstreamHeaders[0]!["x-api-key"]).toBe("sk-operator");
  });

  it("政策可以改回不思考：拿掉思考強度、送 thinking disabled；用量端點的 effort 是 null", async () => {
    const proxy = makeProxy({ disableThinking: true, forceEffort: null });
    const { token } = await account(proxy);
    expect((await send(proxy, token)).status).toBe(200);
    expect(upstreamBodies[0]).toMatchObject({ model: "claude-haiku-5-5", thinking: { type: "disabled" } });
    expect(upstreamBodies[0].output_config).toBeUndefined();
    expect(await usageOf(proxy, token)).toMatchObject({ thinking: false, effort: null });
    expect((await admin(proxy, "GET", "/admin/summary")).body.policy).toMatchObject({ thinking: false, effort: null });
  });

  it("政策的檢查：forceEffort 和 disableThinking 不能同時開、強度要是認得的、只有 Haiku 能關思考", () => {
    expect(loadPolicy(undefined)).toMatchObject({ forceModel: "claude-haiku-5-5", forceEffort: "low", disableThinking: false });
    expect(() => loadPolicy(JSON.stringify({ disableThinking: true }))).toThrow(/不能同時開/);
    expect(loadPolicy(JSON.stringify({ disableThinking: true, forceEffort: null }))).toMatchObject({ disableThinking: true, forceEffort: null });
    expect(() => loadPolicy(JSON.stringify({ forceEffort: "huge" }))).toThrow(/forceEffort/);
    expect(loadPolicy(JSON.stringify({ forceEffort: "medium" })).forceEffort).toBe("medium");
    expect(() => loadPolicy(JSON.stringify({ forceModel: "claude-opus-5-5", disableThinking: true, forceEffort: null }))).toThrow(/不能關掉思考/);
  });
});

describe("每天的則數", () => {
  it("送出一則算一則，工具迴圈的下一輪不重複算；用完時說明明天幾點恢復", async () => {
    const proxy = makeProxy({ dailyMessages: 3 });
    const { token } = await account(proxy);

    expect((await send(proxy, token)).status).toBe(200);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);
    expect((await usageOf(proxy, token)).today).toEqual({
      day: "2026-11-10",
      messages_used: 1,
      messages_limit: 3,
      auto_used: 0,
      auto_limit: 2,
      resets_at: "2026-11-11T00:00:00+08:00",
    });

    expect((await send(proxy, token)).status).toBe(200);
    expect((await send(proxy, token)).status).toBe(200);
    const limited = await errorOf(await send(proxy, token));
    expect(limited).toMatchObject({ status: 403, type: "daily_limit", limit: 3, resets_at: "2026-11-11T00:00:00+08:00" });
    expect(limited.message).toContain("今天的 3 則用完了");
    expect(upstreamBodies).toHaveLength(5);
    // 用完之後工具迴圈的下一輪仍可以完成（那一則已經算過了）
    expect((await send(proxy, token, toolLoopBody)).status).toBe(200);

    // 台灣時間的午夜重置（UTC 16:00）
    nowValue = new Date("2026-11-10T15:59:00Z");
    expect((await send(proxy, token)).status).toBe(403);
    nowValue = new Date("2026-11-10T16:00:00Z");
    expect((await send(proxy, token)).status).toBe(200);
    expect((await usageOf(proxy, token)).today).toMatchObject({ day: "2026-11-11", messages_used: 1 });
  });

  it("文字和圖片一起的訊息算新的一則；只有工具結果的不算", () => {
    expect(isNewTurn([{ role: "user", content: "嗨" }])).toBe(true);
    expect(isNewTurn([{ role: "user", content: [{ type: "text", text: "嗨" }] }])).toBe(true);
    expect(isNewTurn([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t" }] }])).toBe(false);
    expect(isNewTurn([{ role: "user", content: [{ type: "tool_result", tool_use_id: "t" }, { type: "text", text: "另外" }] }])).toBe(true);
    expect(isNewTurn([])).toBe(false);
  });

  it("自動的分析另外算（每天 2 次）、不扣對話的則數；壓縮不顯示但有上限", async () => {
    const proxy = makeProxy({ dailyMessages: 1, dailyCompress: 1 });
    const { token } = await account(proxy);
    const single = { model: "claude-haiku-5-5", max_tokens: 2000, messages: [{ role: "user", content: "摘要這一趟" }] };

    expect((await send(proxy, token, single, "auto")).status).toBe(200);
    expect((await send(proxy, token, single, "auto")).status).toBe(200);
    expect(await errorOf(await send(proxy, token, single, "auto"))).toMatchObject({ status: 403, type: "daily_auto_limit" });

    expect((await send(proxy, token, single, "compress")).status).toBe(200);
    expect((await send(proxy, token, single, "compress")).status).toBe(403);

    // 對話的則數還在
    expect((await send(proxy, token)).status).toBe(200);
    expect((await usageOf(proxy, token)).today).toMatchObject({ messages_used: 1, auto_used: 2 });
    // 不認得的標頭照對話算
    expect(await errorOf(await send(proxy, token, chatBody(), "free"))).toMatchObject({ type: "daily_limit" });
  });

  it("上游回錯誤時退回那一次", async () => {
    const proxy = makeProxy({ dailyMessages: 1 });
    const { token } = await account(proxy);
    upstreamStatus = 529;
    expect((await send(proxy, token)).status).toBe(529);
    expect((await usageOf(proxy, token)).today.messages_used).toBe(0);
    upstreamStatus = 200;
    expect((await send(proxy, token)).status).toBe(200);
  });

  it("同時送出的請求不會一起超過上限", async () => {
    const proxy = makeProxy({ dailyMessages: 2 });
    const { token } = await account(proxy);
    const statuses = await Promise.all([1, 2, 3, 4].map(() => send(proxy, token).then((r) => r.status)));
    expect(statuses.filter((s) => s === 200)).toHaveLength(2);
  });
});

describe("總預算與每人的預算", () => {
  it("所有帳號合計超過總預算時全部暫停，下個月 1 日恢復；網頁版看得到原因", async () => {
    // 每次 $0.0002；總預算 $0.0005 → 第 3 次之後暫停
    const proxy = makeProxy({ totalMonthlyBudgetUsd: 0.0005 });
    const a = await account(proxy);
    const b = await account(proxy);
    expect((await send(proxy, a.token)).status).toBe(200);
    expect((await send(proxy, b.token)).status).toBe(200);
    expect((await send(proxy, a.token)).status).toBe(200);
    const paused = await errorOf(await send(proxy, b.token));
    expect(paused).toMatchObject({ status: 403, type: "beta_budget", message: "這個月的免費額度用完了，下個月 1 日恢復", resets_at: "2026-12-01T00:00:00+08:00" });
    expect(await usageOf(proxy, b.token)).toMatchObject({ paused: "beta_budget", paused_until: "2026-12-01T00:00:00+08:00" });
    // 拒絕的那次不扣則數
    expect((await usageOf(proxy, b.token)).today.messages_used).toBe(1);

    const summary = (await admin(proxy, "GET", "/admin/summary")).body;
    expect(summary).toMatchObject({ period: "2026-11", cost_usd: 0.0006, total_budget_usd: 0.0005, paused: true, accounts: 2, active_accounts: 2 });

    // 台灣時間 12 月 1 日
    nowValue = new Date("2026-11-30T16:00:00Z");
    expect((await send(proxy, b.token)).status).toBe(200);
  });

  it("每個帳號每月的上限預設 10 美元；邀請碼可以另外設", async () => {
    const proxy = makeProxy();
    const [code] = await invite(proxy, { monthly_budget_usd: 0.0003 });
    const { token } = (await redeem(proxy, code!.code)).body;
    expect((await usageOf(proxy, token)).budget_usd).toBe(0.0003);
    expect((await send(proxy, token)).status).toBe(200);
    expect((await send(proxy, token)).status).toBe(200);
    expect(await errorOf(await send(proxy, token))).toMatchObject({ status: 403, type: "account_budget" });

    const other = await account(proxy);
    expect((await usageOf(proxy, other.token)).budget_usd).toBe(10);
  });
});

describe("不記內容、刪除帳號、保存期限", () => {
  it("對話的內容不會出現在儲存或日誌中", async () => {
    const proxy = makeProxy();
    const { token } = await account(proxy);
    await send(proxy, token);
    await send(proxy, token, toolLoopBody);
    const tables = ["accounts", "usage", "invites", "daily_usage", "totals"];
    const stored = JSON.stringify(await Promise.all(tables.map((t) => driver.all(`SELECT * FROM ${t}`))));
    for (const secret of ["8 公里", "你是教練", "機密的教練回覆", "最近的跑步", token, "203.0.113.1"]) {
      expect(stored).not.toContain(secret);
      expect(logs.join("\n")).not.toContain(secret);
    }
    expect(logs.filter((l) => l.includes("claude-haiku-5-5"))).toEqual([
      expect.stringMatching(/^acct_[0-9a-f]{16} claude-haiku-5-5 200 chat in=1000 out=200 cost_microusd=200$/),
      expect.stringMatching(/^acct_[0-9a-f]{16} claude-haiku-5-5 200 chat\+ in=1000 out=200 cost_microusd=200$/),
    ]);
  });

  it("選手可以自己刪除試用帳號：帳號與用量刪掉、憑證失效、邀請碼不能再用，總花費照算", async () => {
    const proxy = makeProxy();
    const [code] = await invite(proxy);
    const { token, account_id } = (await redeem(proxy, code!.code)).body;
    await send(proxy, token);

    const deleted = await proxy(new Request("http://proxy/v1/account", { method: "DELETE", headers: { "x-api-key": token } }));
    expect(deleted.status).toBe(200);
    expect((await send(proxy, token)).status).toBe(401);
    for (const table of ["accounts", "usage", "daily_usage"]) expect(await driver.all(`SELECT * FROM ${table}`)).toHaveLength(0);
    expect(JSON.stringify(await driver.all("SELECT * FROM invites"))).not.toContain(account_id);
    expect((await redeem(proxy, code!.code)).body.error.reason).toBe("used");
    expect((await admin(proxy, "GET", "/admin/summary")).body.cost_usd).toBe(0.0002);
  });

  it("每天的次數留 90 天、每月的用量留 13 個月", async () => {
    const proxy = makeProxy();
    const { token, account_id } = await account(proxy);
    await send(proxy, token);
    await store.reserveDaily(account_id, "2026-08-11", "chat", 15);
    await store.reserveDaily(account_id, "2026-08-12", "chat", 15);
    await store.addUsage(account_id, "2025-10", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 1);
    await store.addUsage(account_id, "2025-11", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, 1);

    expect(await purgeOld(store, DEFAULT_POLICY, nowValue)).toEqual({ daily: 1, monthly: 1 });
    expect((await driver.all("SELECT day FROM daily_usage ORDER BY day")).map((r) => r.day)).toEqual(["2026-08-12", "2026-11-10"]);
    expect((await driver.all("SELECT period FROM usage ORDER BY period")).map((r) => r.period)).toEqual(["2025-11", "2026-11"]);
  });
});

describe("端對端：核心的 Claude 轉接 → 代理（x-coach-meter）", () => {
  it("對話的工具迴圈只算一則；自動的分析另外算；標頭不轉給上游", async () => {
    // 上游第一次要求呼叫工具，之後回文字
    let calls = 0;
    const toolThenText = async (url: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return upstream(url, init);
      upstreamHeaders.push(Object.fromEntries(new Headers(init?.headers)));
      return Response.json({
        id: "m1",
        type: "message",
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "get_recent_runs", input: {} }],
        stop_reason: "tool_use",
        usage: { input_tokens: 100, output_tokens: 10 },
      });
    };
    const proxy = makeProxy({}, { fetch: toolThenText as typeof fetch });
    const { token } = await account(proxy);
    const server = await serve(proxy, 0, "127.0.0.1");
    try {
      const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const provider = new AnthropicProvider({ apiKey: token, baseURL, meterHeader: true });
      const chat = provider.startChat({
        model: "claude-opus-5-5",
        system: "你是教練",
        messages: [{ role: "user", content: "明天練什麼？" }],
        tools: [{ name: "get_recent_runs", description: "x", input_schema: { type: "object", properties: {}, required: [] } }] as never,
        maxTokens: 16000,
        effort: "medium",
        meter: "chat",
      });
      expect((await chat.next()).finish).toBe("tool_use");
      expect((await chat.next({ toolResults: [{ id: "t1", content: "最近的跑步" }] })).text).toBe("機密的教練回覆");

      await provider
        .startChat({ model: "claude-haiku-5-5", messages: [{ role: "user", content: "摘要這一趟" }], maxTokens: 2000, effort: "low", meter: "auto" })
        .next();

      expect(upstreamHeaders).toHaveLength(3);
      expect(upstreamHeaders.every((h) => !("x-coach-meter" in h))).toBe(true);
      expect((await usageOf(proxy, token)).today).toMatchObject({ messages_used: 1, auto_used: 1 });
    } finally {
      server.close();
    }
  });
});

describe("資料表", () => {
  it("內測之前建的資料庫（憑證在 accounts 裡）打開時搬到 account_tokens，原本的帳號與憑證照樣能用", async () => {
    const old = openNodeSqlite(":memory:");
    try {
      await old.exec(`CREATE TABLE accounts (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'active',
        monthly_budget_microusd INTEGER, created_at TEXT NOT NULL)`);
      await old.run("INSERT INTO accounts (id, token_hash, created_at) VALUES ('acct_old', 'h', '2026-10-01T00:00:00Z')");
      const migrated = new AccountStore(old);
      await migrated.init();
      await migrated.init();
      expect(await migrated.getAccount("acct_old")).toMatchObject({ id: "acct_old", inviteId: null, status: "active" });
      expect((await migrated.findByTokenHash("h"))?.account.id).toBe("acct_old");
      expect((await old.all("PRAGMA table_info(accounts)")).map((c) => c.name)).not.toContain("token_hash");
    } finally {
      old.close();
    }
  });
});

describe("帳號與多台裝置", () => {
  async function linkCode(proxy: Proxy, token: string) {
    const response = await proxy(new Request("http://proxy/v1/link-codes", { method: "POST", headers: { "x-api-key": token } }));
    return { status: response.status, body: (await response.json()) as any };
  }
  async function link(proxy: Proxy, code: string, deviceName = "電腦 · Chrome") {
    const response = await proxy(
      new Request("http://proxy/v1/link", { method: "POST", headers: { "cf-connecting-ip": "198.51.100.7" }, body: JSON.stringify({ code, device_name: deviceName }) }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  async function devices(proxy: Proxy, token: string) {
    return ((await (await proxy(new Request("http://proxy/v1/devices", { headers: { "x-api-key": token } }))).json()) as any).devices as any[];
  }

  it("邀請碼建立帳號與登入方式（invite）；在另一台用連結碼拿到自己的憑證，同一份額度", async () => {
    const proxy = makeProxy({ dailyMessages: 2 });
    const [code] = await invite(proxy);
    const phone = (
      await proxy(new Request("http://proxy/v1/redeem", { method: "POST", body: JSON.stringify({ code: code!.code, device_name: "iPhone · Safari" }) }))
    ).json() as Promise<any>;
    const { token: phoneToken, account_id } = await phone;
    expect(await store.listIdentities(account_id)).toEqual([{ type: "invite", createdAt: expect.any(String) }]);
    expect(JSON.stringify(await driver.all("SELECT * FROM identities"))).not.toContain(code!.code.slice(3, 7));

    const created = await linkCode(proxy, phoneToken);
    expect(created.status).toBe(201);
    expect(created.body.code).toMatch(/^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
    expect(created.body.expires_at).toBe("2026-11-10T04:10:00.000Z");
    expect(JSON.stringify(await driver.all("SELECT * FROM link_codes"))).not.toContain(created.body.code.replace("-", ""));

    const linked = await link(proxy, created.body.code.toLowerCase());
    expect(linked).toMatchObject({ status: 201, body: { account_id } });
    const laptopToken = linked.body.token as string;
    expect(laptopToken).not.toBe(phoneToken);
    // 用過的連結碼不能再用
    expect((await link(proxy, created.body.code)).body.error.reason).toBe("used");

    // 同一份額度
    expect((await send(proxy, phoneToken)).status).toBe(200);
    expect((await send(proxy, laptopToken)).status).toBe(200);
    expect(await errorOf(await send(proxy, phoneToken))).toMatchObject({ type: "daily_limit" });

    const list = await devices(proxy, laptopToken);
    expect(list.map((d) => [d.name, d.current])).toEqual([
      ["iPhone · Safari", false],
      ["電腦 · Chrome", true],
    ]);
    expect(list[1].last_used_at).toBe("2026-11-10T04:00:00.000Z");
  });

  it("連結碼 10 分鐘過期、打錯有說明；新的連結碼讓舊的失效", async () => {
    const proxy = makeProxy();
    const { token } = await account(proxy);
    const first = (await linkCode(proxy, token)).body.code;
    const second = (await linkCode(proxy, token)).body.code;
    expect((await link(proxy, first)).body.error.reason).toBe("unknown");
    expect((await link(proxy, "ZZZZ-ZZZZ")).body.error.reason).toBe("unknown");
    expect((await link(proxy, "12")).body.error.message).toContain("格式不對");
    nowValue = new Date("2026-11-10T04:10:01Z");
    expect((await link(proxy, second)).body.error).toMatchObject({ reason: "expired", message: expect.stringContaining("已過期") });
    // 要連結碼要先登入
    expect((await proxy(new Request("http://proxy/v1/link-codes", { method: "POST" }))).status).toBe(401);
  });

  it("移除某一台只撤銷那台的憑證；不能移除別的帳號的裝置", async () => {
    const proxy = makeProxy();
    const { token: phone } = await account(proxy);
    const laptop = (await link(proxy, (await linkCode(proxy, phone)).body.code)).body.token as string;
    const other = await account(proxy);
    const laptopId = (await devices(proxy, phone)).find((d) => !d.current).id as string;

    const foreign = await proxy(new Request(`http://proxy/v1/devices/${laptopId}`, { method: "DELETE", headers: { "x-api-key": other.token } }));
    expect(foreign.status).toBe(404);

    const removed = await proxy(new Request(`http://proxy/v1/devices/${laptopId}`, { method: "DELETE", headers: { "x-api-key": phone } }));
    expect(removed.status).toBe(200);
    expect((await send(proxy, laptop)).status).toBe(401);
    expect((await send(proxy, phone)).status).toBe(200);
    expect(await devices(proxy, phone)).toHaveLength(1);
  });

  it("刪除帳號時撤銷所有裝置的憑證，登入方式與連結碼一起刪", async () => {
    const proxy = makeProxy();
    const { token: phone } = await account(proxy);
    const laptop = (await link(proxy, (await linkCode(proxy, phone)).body.code)).body.token as string;
    await linkCode(proxy, phone);
    await proxy(new Request("http://proxy/v1/account", { method: "DELETE", headers: { "x-api-key": phone } }));
    expect((await send(proxy, phone)).status).toBe(401);
    expect((await send(proxy, laptop)).status).toBe(401);
    for (const table of ["account_tokens", "identities", "link_codes"]) expect(await driver.all(`SELECT * FROM ${table}`)).toHaveLength(0);
  });
});

describe("帳號的復原密鑰（規格 12.44 第 1 步）", () => {
  async function newSecret(proxy: Proxy, auth: { token?: string; account?: string; secret?: string }, ip = "198.51.100.9") {
    const response = await proxy(
      new Request("http://proxy/v1/recovery-secret", {
        method: "POST",
        headers: { "cf-connecting-ip": ip, ...(auth.token ? { "x-api-key": auth.token } : {}) },
        body: auth.token ? undefined : JSON.stringify({ account: auth.account, secret: auth.secret }),
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  async function recover(proxy: Proxy, account: string, secret: string, ip = "198.51.100.10") {
    const response = await proxy(
      new Request("http://proxy/v1/recover", {
        method: "POST",
        headers: { "cf-connecting-ip": ip },
        body: JSON.stringify({ account, secret, device_name: "Android · Chrome" }),
      }),
    );
    return { status: response.status, body: (await response.json()) as any };
  }
  const devicesOf = async (proxy: Proxy, token: string) =>
    ((await (await proxy(new Request("http://proxy/v1/devices", { headers: { "x-api-key": token } }))).json()) as any).devices as any[];

  it("已登入的裝置產生復原密鑰：只回一次、只存雜湊、不寫進日誌；新的裝置用它拿到自己的憑證，同一份額度", async () => {
    const proxy = makeProxy({ dailyMessages: 2 });
    const { token, account_id } = await account(proxy);
    const created = await newSecret(proxy, { token });
    expect(created.status).toBe(201);
    expect(created.body.account_id).toBe(account_id);
    const secret = created.body.secret as string;
    expect(secret).toMatch(/^rcs_[0-9a-f]{64}$/);
    expect(JSON.stringify(await driver.all("SELECT * FROM accounts"))).not.toContain(secret.slice(4));
    expect(logs.join("\n")).not.toContain(secret.slice(4));

    const recovered = await recover(proxy, account_id, secret);
    expect(recovered).toMatchObject({ status: 201, body: { account_id } });
    const newToken = recovered.body.token as string;
    expect(newToken).not.toBe(token);
    expect(logs.join("\n")).not.toContain(newToken.slice(3));
    // 每台一個憑證、同一份額度；新的那台可以單獨移除
    expect((await send(proxy, token)).status).toBe(200);
    expect((await send(proxy, newToken)).status).toBe(200);
    expect(await errorOf(await send(proxy, newToken))).toMatchObject({ type: "daily_limit" });
    const list = await devicesOf(proxy, token);
    expect(list.map((d) => d.name)).toEqual([null, "Android · Chrome"]);
    // 用量端點回這台的帳號
    expect((await usageOf(proxy, newToken)).account_id).toBe(account_id);
    // 同一把可以再用（另一台新裝置）
    expect((await recover(proxy, account_id, secret)).status).toBe(201);
  });

  it("錯了一律回「不對」，不透露帳號存不存在；沒有產生過的帳號不能取回", async () => {
    const proxy = makeProxy();
    const { token, account_id } = await account(proxy);
    const other = await account(proxy);
    const secret = (await newSecret(proxy, { token })).body.secret as string;
    const wrongSecret = `rcs_${"0".repeat(64)}`;
    const cases = [
      await recover(proxy, account_id, wrongSecret),
      await recover(proxy, "acct_doesnotexist", secret),
      await recover(proxy, other.account_id, secret),
      await recover(proxy, account_id, "rcs_short"),
      await recover(proxy, "not an id", secret),
    ];
    for (const c of cases) expect(c).toMatchObject({ status: 400, body: { error: { type: "invalid_recovery" } } });
    expect(new Set(cases.map((c) => c.body.error.message)).size).toBe(1);
  });

  it("換一把新的之後舊的不能用（同步換金鑰之後，被移除的裝置不能再取回）；沒有憑證的裝置可以用目前的那一把換", async () => {
    const proxy = makeProxy();
    const { token, account_id } = await account(proxy);
    const first = (await newSecret(proxy, { token })).body.secret as string;
    const second = (await newSecret(proxy, { token })).body.secret as string;
    expect(second).not.toBe(first);
    expect((await recover(proxy, account_id, first)).status).toBe(400);
    expect((await recover(proxy, account_id, second)).status).toBe(201);
    // 用自己的 API key 的那台換金鑰：用目前的那一把換新的，換完舊的作廢
    const third = await newSecret(proxy, { account: account_id, secret: second });
    expect(third).toMatchObject({ status: 201, body: { account_id } });
    expect((await recover(proxy, account_id, second)).status).toBe(400);
    expect((await newSecret(proxy, { account: account_id, secret: second })).status).toBe(400);
    expect((await recover(proxy, account_id, third.body.secret)).status).toBe(201);
    // 憑證不對的不能換
    expect((await newSecret(proxy, { token: "rc_wrong" })).status).toBe(401);
  });

  it("帳號被暫停時不能取回；恢復後可以", async () => {
    const proxy = makeProxy();
    const { token, account_id } = await account(proxy);
    const secret = (await newSecret(proxy, { token })).body.secret as string;
    await admin(proxy, "PATCH", `/admin/accounts/${account_id}`, { status: "suspended" });
    expect(await recover(proxy, account_id, secret)).toMatchObject({ status: 403, body: { error: { type: "permission_error" } } });
    expect((await newSecret(proxy, { account: account_id, secret })).status).toBe(403);
    await admin(proxy, "PATCH", `/admin/accounts/${account_id}`, { status: "active" });
    expect((await recover(proxy, account_id, secret)).status).toBe(201);
  });

  it("刪除帳號時復原密鑰一起刪，不能再取回", async () => {
    const proxy = makeProxy();
    const { token, account_id } = await account(proxy);
    const secret = (await newSecret(proxy, { token })).body.secret as string;
    await proxy(new Request("http://proxy/v1/account", { method: "DELETE", headers: { "x-api-key": token } }));
    expect((await recover(proxy, account_id, secret)).status).toBe(400);
    expect(await driver.all("SELECT * FROM accounts WHERE recovery_hash IS NOT NULL")).toHaveLength(0);
  });

  it("和兌換、連結碼共用每個 IP 每分鐘的次數", async () => {
    const proxy = makeProxy({ redeemsPerMinute: 3 });
    const { token, account_id } = await account(proxy);
    const secret = (await newSecret(proxy, { token })).body.secret as string;
    const ip = "192.0.2.50";
    await redeem(proxy, "RC-ZZZZ-ZZZZ-ZZZZ", ip);
    await recover(proxy, account_id, `rcs_${"1".repeat(64)}`, ip);
    expect((await recover(proxy, account_id, secret, ip)).status).toBe(201);
    expect((await recover(proxy, account_id, secret, ip)).status).toBe(429);
    expect((await redeem(proxy, "RC-ZZZZ-ZZZZ-ZZZZ", ip)).status).toBe(429);
    // 別的 IP 不受影響
    expect((await recover(proxy, account_id, secret, "192.0.2.51")).status).toBe(201);
  });

  it("之前建的資料庫（accounts 沒有 recovery_hash）打開時加上這一欄", async () => {
    const old = openNodeSqlite(":memory:");
    try {
      await old.exec("CREATE TABLE accounts (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', monthly_budget_microusd INTEGER, invite_id TEXT, created_at TEXT NOT NULL)");
      await old.run("INSERT INTO accounts (id, created_at) VALUES ('acct_old', '2026-11-01T00:00:00Z')");
      const migrated = new AccountStore(old);
      await migrated.init();
      await migrated.init();
      expect(await migrated.getRecoveryHash("acct_old")).toBeNull();
      expect(await migrated.setRecoveryHash("acct_old", "h")).toBe(true);
      expect(await migrated.getRecoveryHash("acct_old")).toBe("h");
    } finally {
      old.close();
    }
  });
});
