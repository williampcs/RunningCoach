/** Claude 轉接 — 專案中唯一直接使用 Anthropic SDK 的模組. */
import Anthropic from "@anthropic-ai/sdk";

import type { ChatRequest, ChatSession, Effort, LlmProvider, ToolResult, Turn } from "./types";

// 不支援 output_config.effort 的模型（送出會回 400）
const NO_EFFORT_PREFIXES = ["claude-sonnet-4-5", "claude-haiku-4-5"];

export interface AnthropicProviderOptions {
  /** 使用者自己的 API key，或訂閱模式下代理發給的憑證 */
  apiKey: string;
  /** 訂閱模式下指向代理；未設定時直連 Anthropic */
  baseURL?: string;
  /** 在瀏覽器中直連時必須為 true（key 由使用者自行保管於裝置） */
  browser?: boolean;
}

function supportsEffort(model: string): boolean {
  return !NO_EFFORT_PREFIXES.some((prefix) => model.startsWith(prefix));
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(options: AnthropicProviderOptions) {
    this.client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      dangerouslyAllowBrowser: options.browser ?? false,
    });
  }

  effortFor(model: string, effort: Effort): string | null {
    return supportsEffort(model) ? effort : null;
  }

  startChat(request: ChatRequest): ChatSession {
    const client = this.client;
    const messages: Anthropic.MessageParam[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
    const tools = request.tools as Anthropic.Tool[] | undefined;

    return {
      async next(opts = {}): Promise<Turn> {
        if (opts.toolResults) messages.push({ role: "user", content: toToolResultBlocks(opts.toolResults) });

        const response = await client.messages.create({
          model: request.model,
          max_tokens: request.maxTokens,
          ...(request.system ? { system: request.system } : {}),
          messages,
          ...(tools?.length ? { tools } : {}),
          // 達最大輪數時保留 tools 但禁止再呼叫：對話中已有工具呼叫紀錄，且移除 tools 會讓快取失效
          ...(tools?.length && opts.disableTools ? { tool_choice: { type: "none" as const } } : {}),
          // 新模型預設開啟思考，思考深度以 effort 控制
          ...(supportsEffort(request.model) ? { output_config: { effort: request.effort } } : {}),
        });

        // 本輪 assistant 訊息原封不動加回（含 thinking、tool_use 區塊）
        messages.push({ role: "assistant", content: response.content });

        // 回應可能以 thinking 區塊開頭，依 type 取文字而非依位置
        const text = response.content
          .filter((block): block is Anthropic.TextBlock => block.type === "text")
          .map((block) => block.text)
          .join("\n");
        const toolCalls = response.content
          .filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, input: block.input as Record<string, unknown> }));

        return {
          text,
          toolCalls,
          finish: finishOf(response.stop_reason),
          usage: {
            input: response.usage.input_tokens,
            cacheRead: response.usage.cache_read_input_tokens ?? 0,
            cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
            output: response.usage.output_tokens,
          },
        };
      },
    };
  }
}

function toToolResultBlocks(results: ToolResult[]): Anthropic.ToolResultBlockParam[] {
  return results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.content }));
}

function finishOf(stopReason: Anthropic.Message["stop_reason"]): Turn["finish"] {
  if (stopReason === "tool_use") return "tool_use";
  if (stopReason === "refusal") return "refused";
  if (stopReason === "max_tokens") return "truncated";
  return "ok";
}
