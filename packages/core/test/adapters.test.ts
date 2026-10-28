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

/** 串流回應的原文（SSE） */
class Sse {
  constructor(readonly body: string) {}
}

/** HTTP 錯誤的回應 */
class HttpError {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {}
}

/** Anthropic 格式的 SSE：每個事件帶 event 名稱 */
const anthropicSse = (events: Record<string, unknown>[]) =>
  new Sse(events.map((e) => `event: ${String(e.type)}\ndata: ${JSON.stringify(e)}\n\n`).join(""));

/** OpenAI 格式的 SSE：只有 data，以 [DONE] 結尾 */
const openaiSse = (chunks: unknown[], eol = "\n") =>
  new Sse([...chunks.map((c) => JSON.stringify(c)), "[DONE]"].map((d) => `data: ${d}${eol}${eol}`).join(""));

/** 依序回覆預先寫好的 JSON 或 SSE，並記錄收到的 request */
async function mockApi(responses: unknown[]) {
  const captured: Captured[] = [];
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      captured.push({ headers: req.headers, body: JSON.parse(raw) });
      const response = responses.shift();
      if (response instanceof HttpError) {
        res.writeHead(response.status, { "content-type": "application/json" });
        res.end(JSON.stringify(response.body));
        return;
      }
      if (response instanceof Sse) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(response.body);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(response));
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
      cache_control: { type: "ephemeral" },
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

  it("Prompt Caching：系統提示分成兩個區塊，不常變的那段結尾放斷點，請求上加自動快取；單次生成不加", async () => {
    const { baseURL, captured } = await mockApi([
      anthropicMessage([{ type: "text", text: "好" }], "end_turn"),
      anthropicMessage([{ type: "text", text: "摘要" }], "end_turn"),
    ]);
    const provider = new AnthropicProvider({ apiKey: "k", baseURL });
    const stable = "你是教練。\n規則";
    await provider
      .startChat({
        model: "claude-opus-5-5",
        system: `${stable}\n\n今天日期：2026-10-27`,
        systemStableChars: stable.length,
        messages: [{ role: "user", content: "hi" }],
        tools,
        maxTokens: 2000,
        effort: "low",
      })
      .next();
    await provider.startChat({ model: "claude-opus-5-5", messages: [{ role: "user", content: "摘要" }], maxTokens: 2000, effort: "low" }).next();

    expect(captured[0]!.body.system).toEqual([
      { type: "text", text: stable, cache_control: { type: "ephemeral" } },
      { type: "text", text: "今天日期：2026-10-27" },
    ]);
    expect(captured[0]!.body.cache_control).toEqual({ type: "ephemeral" });
    // 工具清單照原樣送（在系統提示前面，一起快取）
    expect(captured[0]!.body.tools).toEqual(tools);
    expect(captured[1]!.body).not.toHaveProperty("cache_control");
    expect(captured[1]!.body).not.toHaveProperty("system");
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
  it("串流：文字片段即時交出，結束後的結果與工具往返和非串流相同", async () => {
    const start = (usage: Record<string, number>) => ({
      type: "message_start",
      message: {
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-opus-5-5",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 1, ...usage },
      },
    });
    const block = (index: number, content_block: Record<string, unknown>) => ({ type: "content_block_start", index, content_block });
    const delta = (index: number, d: Record<string, unknown>) => ({ type: "content_block_delta", index, delta: d });
    const stop = (index: number) => ({ type: "content_block_stop", index });
    const end = (stopReason: string, outputTokens: number) => [
      { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: outputTokens } },
      { type: "message_stop" },
    ];
    const { baseURL, captured } = await mockApi([
      anthropicSse([
        start({ cache_read_input_tokens: 300, cache_creation_input_tokens: 20 }),
        // 思考內容不回傳，只有簽章
        block(0, { type: "thinking", thinking: "", signature: "" }),
        delta(0, { type: "signature_delta", signature: "sig-abc" }),
        stop(0),
        block(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "讓我" }),
        delta(1, { type: "text_delta", text: "看看" }),
        stop(1),
        block(2, { type: "tool_use", id: "toolu_1", name: "get_training_plan", input: {} }),
        delta(2, { type: "input_json_delta", partial_json: '{"week' }),
        delta(2, { type: "input_json_delta", partial_json: '":"2026-W41"}' }),
        stop(2),
        ...end("tool_use", 40),
      ]),
      anthropicSse([
        start({}),
        block(0, { type: "text", text: "" }),
        delta(0, { type: "text_delta", text: "本週" }),
        delta(0, { type: "text_delta", text: "輕鬆跑" }),
        stop(0),
        block(1, { type: "text", text: "" }),
        delta(1, { type: "text_delta", text: "週末長跑" }),
        stop(1),
        ...end("end_turn", 60),
      ]),
    ]);
    const session = new AnthropicProvider({ apiKey: "test-key", baseURL }).startChat({
      model: "claude-opus-5-5",
      messages: [{ role: "user", content: "這週怎麼練？" }],
      tools,
      maxTokens: 16000,
      effort: "medium",
    });
    const texts: string[] = [];
    const onText = (text: string) => texts.push(text);

    const first = await session.next({ onText });
    expect(first).toEqual({
      text: "讓我看看",
      toolCalls: [{ id: "toolu_1", name: "get_training_plan", input: { week: "2026-W41" } }],
      finish: "tool_use",
      usage: { input: 900, cacheRead: 300, cacheWrite: 20, output: 40 },
    });
    const second = await session.next({ toolResults: [{ id: "toolu_1", content: "計畫內容" }], onText });
    // 多個文字區塊與非串流一樣以換行串接
    expect(second).toMatchObject({ text: "本週輕鬆跑\n週末長跑", finish: "ok", usage: { output: 60 } });
    expect(texts).toEqual(["讓我", "看看", "本週", "輕鬆跑", "\n", "週末長跑"]);

    expect(captured[0]!.body).toMatchObject({ stream: true, output_config: { effort: "medium" } });
    expect(captured[1]!.body.messages[1]).toEqual({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "", signature: "sig-abc" },
        { type: "text", text: "讓我看看" },
        { type: "tool_use", id: "toolu_1", name: "get_training_plan", input: { week: "2026-W41" } },
      ],
    });
  });
});

describe("strict 的工具（規格 12.31 第 2 點）", () => {
  const strictTools: ToolDef[] = [
    {
      name: "edit_planned_session",
      description: "改一堂課",
      strict: true,
      input_schema: {
        type: "object",
        properties: { step: { $ref: "#/$defs/step" } },
        required: ["step"],
        additionalProperties: false,
        $defs: { step: { type: "object", properties: { duration_min: { type: "number" } }, required: [], additionalProperties: false } },
      },
    },
  ];
  const ok = { content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } };

  it("Claude：送出 strict 與 $defs；API 不接受（400）時拿掉 strict 再送一次，之後的對話也不送", async () => {
    const rejected = new HttpError(400, { type: "error", error: { type: "invalid_request_error", message: "Schema is too complex for compilation" } });
    const { baseURL, captured } = await mockApi([rejected, ok, ok]);
    const provider = new AnthropicProvider({ apiKey: "k", baseURL });
    const request = { model: "claude-test", system: "s", messages: [{ role: "user" as const, content: "hi" }], tools: strictTools, maxTokens: 100, effort: "low" as const };
    expect((await provider.startChat(request).next()).text).toBe("好");
    expect(captured[0]!.body.tools[0].strict).toBe(true);
    expect(captured[0]!.body.tools[0].input_schema.$defs.step).toBeDefined();
    expect(captured[1]!.body.tools[0].strict).toBeUndefined();
    expect(captured[1]!.body.tools[0].input_schema).toEqual(strictTools[0]!.input_schema);
    await provider.startChat(request).next();
    expect(captured[2]!.body.tools[0].strict).toBeUndefined();
  });

  it("Claude：沒有 strict 的工具時，400 照樣丟出", async () => {
    const { baseURL, captured } = await mockApi([new HttpError(400, { type: "error", error: { type: "invalid_request_error", message: "bad" } })]);
    const session = new AnthropicProvider({ apiKey: "k", baseURL }).startChat({ model: "m", messages: [{ role: "user", content: "hi" }], tools, maxTokens: 10, effort: "low" });
    await expect(session.next()).rejects.toThrow(/bad/);
    expect(captured).toHaveLength(1);
  });

  it("OpenAI 相容：不送 strict，展開 $ref、拿掉 additionalProperties", async () => {
    const { baseURL, captured } = await mockApi([{ choices: [{ message: { role: "assistant", content: "好" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } }]);
    await new OpenAICompatibleProvider({ apiKey: "k", baseURL }).startChat({ model: "m", messages: [{ role: "user", content: "hi" }], tools: strictTools, maxTokens: 10, effort: "low" }).next();
    const tool = captured[0]!.body.tools[0];
    expect(tool.strict).toBeUndefined();
    expect(tool.function.strict).toBeUndefined();
    expect(tool.function.parameters).toEqual({
      type: "object",
      properties: { step: { type: "object", properties: { duration_min: { type: "number" } }, required: [] } },
      required: ["step"],
    });
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

  it("OpenRouter 上的 Claude：系統提示的斷點、請求上的自動快取、快取寫入的用量；其他模型不帶", async () => {
    const reply = (usage: Record<string, unknown>) => ({
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "好" } }],
      usage,
    });
    const { baseURL, captured } = await mockApi([
      reply({ prompt_tokens: 3000, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2500 } }),
      reply({ prompt_tokens: 3000, completion_tokens: 10 }),
    ]);
    const provider = new OpenAICompatibleProvider({ apiKey: "k", baseURL, anthropicCacheControl: true });
    const stable = "你是教練。";
    const request = {
      system: `${stable}\n\n今天日期：2026-10-27`,
      systemStableChars: stable.length,
      messages: [{ role: "user" as const, content: "hi" }],
      maxTokens: 500,
      effort: "low" as const,
    };

    const turn = await provider.startChat({ ...request, model: "anthropic/claude-sonnet-5.5" }).next();
    expect(turn.usage).toEqual({ input: 500, cacheRead: 0, cacheWrite: 2500, output: 10 });
    expect(captured[0]!.body.cache_control).toEqual({ type: "ephemeral" });
    expect(captured[0]!.body.messages[0]).toEqual({
      role: "system",
      content: [
        { type: "text", text: stable, cache_control: { type: "ephemeral" } },
        { type: "text", text: "今天日期：2026-10-27" },
      ],
    });

    await provider.startChat({ ...request, model: "openai/gpt-5" }).next();
    expect(captured[1]!.body).not.toHaveProperty("cache_control");
    expect(captured[1]!.body.messages[0]).toEqual({ role: "system", content: request.system });

    // 沒有指定時依網址判斷
    const bodies: Record<string, unknown>[] = [];
    const fetchStub: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json(reply({ prompt_tokens: 10, completion_tokens: 1 }));
    };
    for (const url of ["https://openrouter.ai/api/v1", "https://api.openai.com/v1"]) {
      await new OpenAICompatibleProvider({ apiKey: "k", baseURL: url, fetch: fetchStub })
        .startChat({ ...request, model: "anthropic/claude-sonnet-5.5" })
        .next();
    }
    expect(bodies.map((b) => b.cache_control)).toEqual([{ type: "ephemeral" }, undefined]);
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

  it("串流：合併逐段送達的文字與工具呼叫，組回與非串流相同的 assistant 訊息", async () => {
    const chunk = (delta: Record<string, unknown>, finish_reason: string | null = null) => ({
      choices: [{ index: 0, delta, finish_reason }],
    });
    const { baseURL, captured } = await mockApi([
      openaiSse([
        chunk({
          role: "assistant",
          content: null,
          tool_calls: [
            {
              index: 0,
              id: "call_1",
              type: "function",
              function: { name: "get_training_plan", arguments: "" },
              extra_content: { google: { thought_signature: "sig-xyz" } },
            },
          ],
        }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"week":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"2026-W41"}' } }] }),
        chunk({}, "tool_calls"),
        { choices: [], usage: { prompt_tokens: 1000, completion_tokens: 30, prompt_tokens_details: { cached_tokens: 400 } } },
      ]),
      // 以 CRLF 換行的伺服器
      openaiSse(
        [
          chunk({ role: "assistant", content: "" }),
          chunk({ content: "本週" }),
          chunk({ content: "輕鬆跑" }, "stop"),
          { choices: [], usage: { prompt_tokens: 1100, completion_tokens: 50 } },
        ],
        "\r\n",
      ),
    ]);
    const session = new OpenAICompatibleProvider({ apiKey: "k", baseURL }).startChat({
      model: "m",
      messages: [{ role: "user", content: "這週怎麼練？" }],
      tools,
      maxTokens: 16000,
      effort: "low",
    });
    const texts: string[] = [];
    const onText = (text: string) => texts.push(text);

    const first = await session.next({ onText });
    expect(first).toEqual({
      text: "",
      toolCalls: [{ id: "call_1", name: "get_training_plan", input: { week: "2026-W41" } }],
      finish: "tool_use",
      usage: { input: 600, cacheRead: 400, cacheWrite: 0, output: 30 },
    });
    const second = await session.next({ toolResults: [{ id: "call_1", content: "計畫內容" }], onText });
    expect(second).toEqual({
      text: "本週輕鬆跑",
      toolCalls: [],
      finish: "ok",
      usage: { input: 1100, cacheRead: 0, cacheWrite: 0, output: 50 },
    });
    expect(texts).toEqual(["本週", "輕鬆跑"]);

    expect(captured[0]!.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(captured[1]!.body.messages[1]).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          function: { name: "get_training_plan", arguments: '{"week":"2026-W41"}' },
          extra_content: { google: { thought_signature: "sig-xyz" } },
        },
      ],
    });
  });

  it("串流中途收到錯誤事件時丟出錯誤", async () => {
    const { baseURL } = await mockApi([
      openaiSse([{ choices: [{ index: 0, delta: { content: "講到" } }] }, { error: { message: "overloaded" } }]),
    ]);
    const texts: string[] = [];
    const error = await new OpenAICompatibleProvider({ apiKey: "k", baseURL })
      .startChat({ model: "m", messages: [{ role: "user", content: "hi" }], maxTokens: 10, effort: "low" })
      .next({ onText: (t) => texts.push(t) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAICompatibleError);
    expect(error).toMatchObject({ message: "overloaded" });
    expect(texts).toEqual(["講到"]);
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
