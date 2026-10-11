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
    const messages: WireMessage[] = [
      ...(request.system ? [{ role: "system", content: request.system }] : []),
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

        const response = await fetchImpl(`${options.baseURL.replace(/\/+$/, "")}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${options.apiKey}` },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          throw new OpenAICompatibleError(response.status, await errorMessage(response));
        }

        const data = (await response.json()) as {
          choices?: { finish_reason?: string; message?: WireMessage }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
          };
        };
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
        return {
          text: typeof message.content === "string" ? message.content : "",
          toolCalls,
          finish: finishOf(choice?.finish_reason, toolCalls.length > 0, message.refusal),
          usage: {
            input: (data.usage?.prompt_tokens ?? 0) - cached,
            cacheRead: cached,
            cacheWrite: 0,
            output: data.usage?.completion_tokens ?? 0,
          },
        };
      },
    };
  }
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

function finishOf(finishReason: string | undefined, hasToolCalls: boolean, refusal: unknown): Turn["finish"] {
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
