import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { AnthropicProvider, OpenAICompatibleError, OpenAICompatibleProvider, type ToolDef } from "../src";

const tools: ToolDef[] = [
  {
    name: "get_training_plan",
    description: "取得訓練計畫",
    input_schema: { type: "object", properties: {}, required: [] },
  },
];

interface Captured {
  headers: IncomingMessage["headers"];
  body: Record<string, any>;
}

let server: Server | undefined;

afterEach(() => {
  server?.close();
  server = undefined;
});

/** 依序回覆預先寫好的 JSON，並記錄收到的 request */
async function mockApi(responses: unknown[]) {
  const captured: Captured[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responses.shift()));
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { baseURL: `http://127.0.0.1:${port}`, captured };
}

function anthropicMessage(content: unknown[], stopReason: string, usage: Record<string, number> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 900, output_tokens: 40, ...usage },
  };
}

describe("AnthropicProvider", () => {
  it("送出 effort，工具回合原封不動帶回 thinking 與 tool_use 區塊", async () => {
    const thinking = { type: "thinking", thinking: "", signature: "sig-abc" };
    const toolUse = { type: "tool_use", id: "toolu_1", name: "get_training_plan", input: {} };
    const { baseURL, captured } = await mockApi([
      anthropicMessage([thinking, toolUse], "tool_use", { cache_read_input_tokens: 300, cache_creation_input_tokens: 20 }),
      anthropicMessage([thinking, { type: "text", text: "本週以輕鬆跑為主。" }], "end_turn"),
    ]);
    const session = new AnthropicProvider({ apiKey: "test-key", baseURL }).startChat({
      model: "claude-opus-5-5",
      system: "你是教練",
      messages: [{ role: "user", content: "這週怎麼練？" }],
      tools,
      maxTokens: 16000,
      effort: "medium",
    });

    const first = await session.next();
    expect(first).toEqual({
      text: "",
      toolCalls: [{ id: "toolu_1", name: "get_training_plan", input: {} }],
      finish: "tool_use",
      usage: { input: 900, cacheRead: 300, cacheWrite: 20, output: 40 },
    });
    const second = await session.next({ toolResults: [{ id: "toolu_1", content: "計畫內容" }], disableTools: true });
    expect(second).toMatchObject({ text: "本週以輕鬆跑為主。", finish: "ok", toolCalls: [] });

    expect(captured[0]!.headers["x-api-key"]).toBe("test-key");
    expect(captured[0]!.body).toEqual({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: "你是教練",
      messages: [{ role: "user", content: "這週怎麼練？" }],
      tools,
      output_config: { effort: "medium" },
    });
    expect(captured[1]!.body.tool_choice).toEqual({ type: "none" });
    expect(captured[1]!.body.messages).toEqual([
      { role: "user", content: "這週怎麼練？" },
      { role: "assistant", content: [thinking, toolUse] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "計畫內容" }] },
    ]);
  });

  it("不支援 effort 的舊模型不送 output_config；拒絕與截斷對應到 finish", async () => {
    const { baseURL, captured } = await mockApi([
      anthropicMessage([], "refusal"),
      anthropicMessage([{ type: "text", text: "講到一" }], "max_tokens"),
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", baseURL });
    const request = { messages: [{ role: "user" as const, content: "hi" }], maxTokens: 2000, effort: "low" as const };

    expect((await provider.startChat({ ...request, model: "claude-haiku-4-5" }).next()).finish).toBe("refused");
    expect((await provider.startChat({ ...request, model: "claude-haiku-5-5" }).next()).finish).toBe("truncated");
    expect(captured[0]!.body).toEqual({
      model: "claude-haiku-4-5",
      max_tokens: 2000,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(captured[1]!.body.output_config).toEqual({ effort: "low" });
    expect(provider.effortFor("claude-haiku-4-5", "low")).toBeNull();
    expect(provider.effortFor("claude-haiku-5-5", "low")).toBe("low");
  });
});

describe("OpenAICompatibleProvider", () => {
  it("工具呼叫往返：assistant 訊息原樣送回，用量扣除快取部分", async () => {
    const assistantWithCall = {
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_training_plan", arguments: "{}" },
          extra_content: { google: { thought_signature: "sig-xyz" } },
        },
      ],
    };
    const { baseURL, captured } = await mockApi([
      {
        choices: [{ finish_reason: "tool_calls", message: assistantWithCall }],
        usage: { prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400 } },
      },
      {
        choices: [{ finish_reason: "stop", message: { role: "assistant", content: "本週以輕鬆跑為主。" } }],
        usage: { prompt_tokens: 1100, completion_tokens: 50 },
      },
    ]);
    const provider = new OpenAICompatibleProvider({
      apiKey: "test-key",
      baseURL: `${baseURL}/v1/`,
      maxTokensParam: "max_completion_tokens",
      reasoningEffort: true,
    });
    const session = provider.startChat({
      model: "some-model",
      system: "你是教練",
      messages: [{ role: "user", content: "這週怎麼練？" }],
      tools,
      maxTokens: 16000,
      effort: "xhigh",
    });

    const first = await session.next();
    expect(first).toEqual({
      text: "",
      toolCalls: [{ id: "call_1", name: "get_training_plan", input: {} }],
      finish: "tool_use",
      usage: { input: 600, cacheRead: 400, cacheWrite: 0, output: 30 },
    });
    const second = await session.next({ toolResults: [{ id: "call_1", content: "計畫內容" }], disableTools: true });
    expect(second).toMatchObject({ text: "本週以輕鬆跑為主。", finish: "ok" });

    expect(captured[0]!.headers.authorization).toBe("Bearer test-key");
    expect(captured[0]!.body).toEqual({
      model: "some-model",
      messages: [
        { role: "system", content: "你是教練" },
        { role: "user", content: "這週怎麼練？" },
      ],
      max_completion_tokens: 16000,
      tools: [
        {
          type: "function",
          function: { name: "get_training_plan", description: "取得訓練計畫", parameters: tools[0]!.input_schema },
        },
      ],
      reasoning_effort: "high",
    });
    expect(captured[1]!.body.tool_choice).toBe("none");
    expect(captured[1]!.body.messages.slice(2)).toEqual([
      assistantWithCall,
      { role: "tool", tool_call_id: "call_1", content: "計畫內容" },
    ]);
  });

  it("預設不送 reasoning_effort；內容過濾視為拒絕，length 視為截斷", async () => {
    const { baseURL, captured } = await mockApi([
      { choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: "" } }] },
      { choices: [{ finish_reason: "length", message: { role: "assistant", content: "講到一" } }] },
    ]);
    const provider = new OpenAICompatibleProvider({ apiKey: "k", baseURL, maxTokensParam: "max_tokens" });
    const request = { model: "m", messages: [{ role: "user" as const, content: "hi" }], maxTokens: 500, effort: "low" as const };

    expect((await provider.startChat(request).next()).finish).toBe("refused");
    expect((await provider.startChat(request).next()).finish).toBe("truncated");
    expect(captured[0]!.body).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }], max_tokens: 500 });
    expect(provider.effortFor("m", "low")).toBeNull();
  });

  it("HTTP 錯誤時丟出帶狀態碼的錯誤", async () => {
    const provider = new OpenAICompatibleProvider({
      apiKey: "bad",
      baseURL: "http://example.invalid/v1",
      fetch: async () =>
        new Response(JSON.stringify({ error: { message: "Incorrect API key provided" } }), { status: 401 }),
    });
    const error = await provider
      .startChat({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 10, effort: "low" })
      .next()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAICompatibleError);
    expect(error).toMatchObject({ status: 401, message: "401 Incorrect API key provided" });
  });
});
