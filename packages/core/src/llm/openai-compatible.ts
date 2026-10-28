/**
 * OpenAI 相容（Chat Completions）轉接 — 供 OpenAI、Gemini 的相容端點，以及其他相容服務使用.
 *
 * 直接以 fetch 呼叫，不依賴任何 SDK。Claude 不走這裡，見 anthropic.ts。
 */
import type { ChatRequest, ChatSession, Effort, LlmProvider, ToolResult, Turn } from "./types";

export interface OpenAICompatibleOptions {
  apiKey: string;
  /** 例：https://api.openai.com/v1 */
  baseURL: string;
  /** 輸出上限的參數名稱；OpenAI 的新模型只接受 max_completion_tokens */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  /** 是否送出 reasoning_effort。非推理模型會拒絕這個參數，預設不送 */
  reasoningEffort?: boolean;
  /** Claude 的模型（anthropic/…）帶快取標記；未設定時依 baseURL 判斷是不是 OpenRouter */
  anthropicCacheControl?: boolean;
  fetch?: typeof fetch;
}

/** 常見供應商的預設值 */
export const OPENAI_COMPATIBLE_PRESETS = {
  openai: { baseURL: "https://api.openai.com/v1", maxTokensParam: "max_completion_tokens", reasoningEffort: true },
  gemini: {
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
    maxTokensParam: "max_tokens",
    reasoningEffort: true,
  },
} as const satisfies Record<string, Omit<OpenAICompatibleOptions, "apiKey">>;

interface WireToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** assistant 訊息原樣保留（供應商附加的欄位如思考簽章需要原封不動送回） */
type WireMessage = Record<string, unknown> & { role: string };

interface CompletionData {
  choices?: { finish_reason?: string | null; message?: WireMessage }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** cache_write_tokens：OpenRouter 上有明確快取的模型（Claude）才有 */
    prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
  } | null;
}

export class OpenAICompatibleError extends Error {
  override name = "OpenAICompatibleError";
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// xhigh / max 是 Claude 的級距，這裡沒有對應值
function toReasoningEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "low" || effort === "medium" ? effort : "high";
}

export class OpenAICompatibleProvider implements LlmProvider {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: OpenAICompatibleOptions) {
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  effortFor(_model: string, effort: Effort): string | null {
    return this.options.reasoningEffort ? toReasoningEffort(effort) : null;
  }

  startChat(request: ChatRequest): ChatSession {
    const { options, fetchImpl } = this;
    const anthropicCache =
      Boolean(request.system) &&
      (options.anthropicCacheControl ?? isOpenRouter(options.baseURL)) &&
      request.model.trim().toLowerCase().startsWith("anthropic/");
    const messages: WireMessage[] = [
      ...(request.system ? [{ role: "system", content: systemContent(request, anthropicCache) }] : []),
      ...request.messages.map((m) => ({ role: m.role, content: m.content })),
    ];
    const tools = request.tools?.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));

    return {
      async next(opts = {}): Promise<Turn> {
        if (opts.toolResults) messages.push(...toToolMessages(opts.toolResults));

        const body: Record<string, unknown> = {
          model: request.model,
          messages,
          [options.maxTokensParam ?? "max_completion_tokens"]: request.maxTokens,
        };
        if (tools?.length) {
          body.tools = tools;
          if (opts.disableTools) body.tool_choice = "none";
        }
        if (options.reasoningEffort) body.reasoning_effort = toReasoningEffort(request.effort);
        // OpenRouter 的自動快取：斷點放在最後一個可快取的區塊，對話越長自動往後移（TTL 預設 5 分鐘）
        if (anthropicCache) body.cache_control = { type: "ephemeral" };
        if (opts.onText) {
          body.stream = true;
          body.stream_options = { include_usage: true };
        }

        const response = await fetchImpl(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new OpenAICompatibleError(response.status, await errorMessage(response));
        }

        const data = opts.onText
          ? await readStream(response, opts.onText)
          : ((await response.json()) as CompletionData);
        const choice = data.choices?.[0];
        const message = choice?.message;
        if (!message) throw new OpenAICompatibleError(response.status, "回應中沒有 choices[0].message");

        messages.push(message);

        const wireCalls = (message.tool_calls as WireToolCall[] | undefined) ?? [];
        const toolCalls = wireCalls.map((call) => ({
          id: call.id,
          name: call.function.name,
          input: parseArguments(call.function.arguments),
        }));

        const cached = data.usage?.prompt_tokens_details?.cached_tokens ?? 0;
        const cacheWrite = data.usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
        return {
          text: typeof message.content === "string" ? message.content : "",
          toolCalls,
          finish: finishOf(choice?.finish_reason, toolCalls.length > 0, message.refusal),
          usage: {
            input: (data.usage?.prompt_tokens ?? 0) - cached - cacheWrite,
            cacheRead: cached,
            cacheWrite,
            output: data.usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  }
}

/**
 * OpenRouter 上的 Claude 要帶快取標記才會快取（OpenAI、Gemini 自動快取，不用帶）。
 * 依 OpenRouter 的 Prompt Caching 文件：內容區塊的 cache_control 是明確的斷點，請求上的 cache_control 是自動快取
 */
function isOpenRouter(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname;
    return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
  } catch {
    return false;
  }
}

/** 要快取時，系統提示分成兩個區塊，在不常變的那段結尾放斷點（見 anthropic.ts） */
function systemContent(request: ChatRequest, anthropicCache: boolean): string | Record<string, unknown>[] {
  const { system = "", systemStableChars: stableChars } = request;
  if (!anthropicCache || stableChars === undefined) return system;
  const dynamic = system.slice(stableChars).replace(/^\n+/, "");
  return [
    { type: "text", text: system.slice(0, stableChars), cache_control: { type: "ephemeral" } },
    ...(dynamic ? [{ type: "text", text: dynamic }] : []),
  ];
}

interface WireDelta {
  index?: number;
  function?: { name?: string; arguments?: string };
  [key: string]: unknown;
}

interface StreamChunk extends Omit<CompletionData, "choices"> {
  choices?: { finish_reason?: string | null; delta?: Record<string, unknown> }[];
  error?: { message?: string };
}

/**
 * 讀取串流回應（SSE），組回與非串流相同形狀的結果。
 * 文字逐段串接並交給 onText；工具呼叫依 index 合併，名稱與參數逐段串接，其餘欄位（如思考簽章）保留；
 * 訊息上其他欄位的字串逐段串接，非字串以最後收到的為準。
 */
async function readStream(response: Response, onText: (text: string) => void): Promise<CompletionData> {
  const message: WireMessage = { role: "assistant", content: "" };
  const calls: WireToolCall[] = [];
  let finishReason: string | null | undefined;
  let usage: CompletionData["usage"];

  for await (const chunk of sseData(response)) {
    if (chunk.error) throw new OpenAICompatibleError(response.status, chunk.error.message ?? JSON.stringify(chunk.error));
    if (chunk.usage) usage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason) finishReason = choice.finish_reason;

    for (const [key, value] of Object.entries(choice.delta ?? {})) {
      if (key === "role" || value === null || value === undefined) continue;
      if (key === "content" && typeof value === "string") {
        message.content += value;
        if (value) onText(value);
      } else if (key === "tool_calls" && Array.isArray(value)) {
        for (const delta of value as WireDelta[]) mergeToolCall(calls, delta);
      } else {
        const previous = message[key];
        message[key] = typeof value === "string" && typeof previous === "string" ? previous + value : value;
      }
    }
  }

  if (calls.length) {
    message.tool_calls = calls;
    // 非串流時有工具呼叫、沒有文字的訊息 content 為 null
    if (message.content === "") message.content = null;
  }
  return { choices: [{ finish_reason: finishReason, message }], usage };
}

function mergeToolCall(calls: WireToolCall[], delta: WireDelta): void {
  const { index, function: fn, ...rest } = delta;
  // 沒有 index 的供應商一次送完整的工具呼叫
  const target = (calls[index ?? calls.length] ??= { id: "", type: "function", function: { name: "", arguments: "" } });
  Object.assign(target, rest);
  if (fn?.name) target.function.name += fn.name;
  if (fn?.arguments) target.function.arguments += fn.arguments;
}

/** 逐一取出 SSE 事件的 data（JSON），略過結尾的 [DONE] */
async function* sseData(response: Response): AsyncGenerator<StreamChunk> {
  if (!response.body) throw new OpenAICompatibleError(response.status, "串流回應沒有內容");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];

  const flush = function* (): Generator<StreamChunk> {
    const payload = data.join("\n");
    data = [];
    if (!payload || payload === "[DONE]") return;
    yield JSON.parse(payload) as StreamChunk;
  };

  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") yield* flush();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (done) break;
  }
  if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart());
  yield* flush();
}

function toToolMessages(results: ToolResult[]): WireMessage[] {
  return results.map((r) => ({ role: "tool", tool_call_id: r.id, content: r.content }));
}

function parseArguments(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function finishOf(finishReason: string | null | undefined, hasToolCalls: boolean, refusal: unknown): Turn["finish"] {
  if (hasToolCalls) return "tool_use";
  if (finishReason === "content_filter" || (typeof refusal === "string" && refusal)) return "refused";
  if (finishReason === "length") return "truncated";
  return "ok";
}

async function errorMessage(response: Response): Promise<string> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text) as { error?: { message?: string } } | { error?: { message?: string } }[];
    const error = Array.isArray(parsed) ? parsed[0]?.error : parsed.error;
    if (error?.message) return `${response.status} ${error.message}`;
  } catch {
    // 非 JSON 的錯誤內容，直接回傳原文
  }
  return `${response.status} ${text.slice(0, 300)}`;
}
