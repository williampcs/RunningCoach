/**
 * 免費試用的代理改寫後送到 Anthropic 的請求，要和模型對照的 haiku-low 一樣（規格 12.43：免費試用用 Haiku low）.
 * 改了代理的預設政策或模型對照的設定時，這裡會不過：兩邊要一起改.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { AnthropicProvider, type ChatRequest } from "../../packages/core/src";
import { openNodeSqlite } from "../../packages/sqlite-node/src";
import { createProxy } from "../../apps/proxy/src/handler";
import { DEFAULT_POLICY } from "../../apps/proxy/src/policy";
import { serve } from "../../apps/proxy/src/server";
import { AccountStore } from "../../apps/proxy/src/store";
import { MODEL_CONFIGS } from "../model-eval/models";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

const message = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  content: [{ type: "text", text: "好" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 2 },
};

/** 直連時的「Anthropic」：記下收到的請求 */
async function anthropic(bodies: unknown[]): Promise<string> {
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(message));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 照預設政策的代理；上游換成記錄請求的假 fetch */
async function proxy(bodies: unknown[]): Promise<{ baseURL: string; token: string }> {
  const driver = openNodeSqlite(":memory:");
  const store = new AccountStore(driver);
  await store.init();
  const handle = createProxy({
    store,
    policy: DEFAULT_POLICY,
    upstream: { baseUrl: "https://upstream.test", apiKey: "sk-operator" },
    adminToken: "admin",
    allowedOrigins: [],
    fetch: (async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json(message);
    }) as typeof fetch,
  });
  const server = await serve(handle, 0, "127.0.0.1");
  servers.push(server);
  const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const invites = (await (await fetch(`${baseURL}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin" }, body: "{}" })).json()) as {
    invites: { code: string }[];
  };
  const redeemed = (await (await fetch(`${baseURL}/v1/redeem`, { method: "POST", body: JSON.stringify({ code: invites.invites[0]!.code }) })).json()) as { token: string };
  return { baseURL, token: redeemed.token };
}

const tools = [{ name: "get_recent_runs", description: "最近的跑步", input_schema: { type: "object" as const, properties: {}, required: [] } }];

describe("免費試用的代理 = 模型對照的 haiku-low", () => {
  it("對話與單次生成：經代理改寫後的請求和直連 haiku-low 的一模一樣", async () => {
    const haikuLow = MODEL_CONFIGS.find((m) => m.id === "haiku-low")!;
    expect(DEFAULT_POLICY.forceModel).toBe(haikuLow.model);
    expect(DEFAULT_POLICY.forceEffort).toBe(haikuLow.effort);
    expect(DEFAULT_POLICY.disableThinking).toBe(!!haikuLow.disableThinking);

    const viaProxy: Record<string, unknown>[] = [];
    const direct: Record<string, unknown>[] = [];
    const { baseURL, token } = await proxy(viaProxy);
    // 網頁版經代理：模型與思考強度照網頁版的設定送（預設 Opus、medium），代理改寫
    const web = new AnthropicProvider({ apiKey: token, baseURL, meterHeader: true });
    // 模型對照的 haiku-low：直連
    const evalProvider = new AnthropicProvider({ apiKey: "k", baseURL: await anthropic(direct), disableThinking: haikuLow.disableThinking, maxRetries: 0 });

    const chat = (model: string, effort: ChatRequest["effort"]): ChatRequest => ({
      model,
      system: "你是教練\n\n今天是星期二",
      systemStableChars: 4,
      messages: [{ role: "user", content: "明天練什麼？" }],
      tools,
      maxTokens: 16000,
      effort,
      meter: "chat",
    });
    await web.startChat(chat("claude-opus-5-5", "medium")).next();
    await evalProvider.startChat(chat(haikuLow.model, haikuLow.effort)).next();
    // 跑後摘要等單次生成：核心固定送 low
    const summary = (model: string): ChatRequest => ({ model, messages: [{ role: "user", content: "摘要這一趟" }], maxTokens: 2000, effort: "low", meter: "auto" });
    await web.startChat(summary("claude-opus-5-5")).next();
    await evalProvider.startChat(summary(haikuLow.model)).next();

    expect(viaProxy).toHaveLength(2);
    expect(viaProxy[0]).toMatchObject({ model: "claude-haiku-5-5", output_config: { effort: "low" } });
    expect(viaProxy[0]!.thinking).toBeUndefined();
    expect(viaProxy).toEqual(direct);
  });
});
