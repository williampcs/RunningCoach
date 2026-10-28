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
  /** API 拒絕了 strict 的工具（400）之後，這個轉接層之後都不送 strict（規格 12.31 第 2 點）；程式照樣驗證工具的輸入 */
  private strictRejected = false;

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
    const provider = this;
    const messages: Anthropic.MessageParam[] = request.messages.map((m) => ({ role: m.role, content: m.content }));
    let tools = request.tools?.map((t) => (this.strictRejected ? withoutStrict(t) : t)) as Anthropic.Tool[] | undefined;
    const system = systemParam(request);

    return {
      async next(opts = {}): Promise<Turn> {
        if (opts.toolResults) messages.push({ role: "user", content: toToolResultBlocks(opts.toolResults) });

        const params: Anthropic.MessageCreateParamsNonStreaming = {
          model: request.model,
          max_tokens: request.maxTokens,
          ...(system ? { system } : {}),
          // 主對話（有系統提示）用請求層級的自動快取：斷點放在最後一個可快取的區塊，工具迴圈與對話越長自動往後移。
          // TTL 用預設的 5 分鐘。單次生成（摘要、壓縮）不重送，快取只會多付寫入費用
          ...(system ? { cache_control: { type: "ephemeral" as const } } : {}),
          messages,
          ...(tools?.length ? { tools } : {}),
          // 達最大輪數時保留 tools 但禁止再呼叫：對話中已有工具呼叫紀錄，且移除 tools 會讓快取失效
          ...(tools?.length && opts.disableTools ? { tool_choice: { type: "none" as const } } : {}),
          // 新模型預設開啟思考，思考深度以 effort 控制
          ...(supportsEffort(request.model) ? { output_config: { effort: request.effort } } : {}),
        };
        const send = (p: Anthropic.MessageCreateParamsNonStreaming) =>
          opts.onText ? streamMessage(client, p, opts.onText) : client.messages.create(p);
        let response: Anthropic.Message;
        try {
          response = await send(params);
        } catch (e) {
          // strict 的 schema 不被接受（例如超過複雜度的上限）時，拿掉 strict 再送一次，不讓對話因此失敗；400 不計費
          if (!(e instanceof Anthropic.BadRequestError) || !tools?.some((t) => t.strict)) throw e;
          const loose = tools.map(withoutStrict) as Anthropic.Tool[];
          // 拿掉 strict 也失敗的，是別的原因造成的 400：照樣丟出，之後照樣送 strict
          response = await send({ ...params, tools: loose });
          tools = loose;
          provider.strictRejected = true;
        }

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

/**
 * 以串流方式送出：文字片段一產生就交給 onText，結束後取得與非串流相同的完整訊息。
 * 思考內容不會回傳（新模型預設如此），思考期間沒有文字片段。
 */
async function streamMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParamsNonStreaming,
  onText: (text: string) => void,
): Promise<Anthropic.Message> {
  const stream = client.messages.stream(params);
  let textBlocks = 0;
  for await (const event of stream) {
    if (event.type === "content_block_start" && event.content_block.type === "text") {
      // 非串流時多個文字區塊以換行串接，這裡保持一致
      if (textBlocks++ > 0) onText("\n");
    } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      onText(event.delta.text);
    }
  }
  return stream.finalMessage();
}

/**
 * 系統提示：有不常變的一段時分成兩個區塊，在第一個的結尾放明確的快取斷點（請求依 tools → system → messages 的順序比對，
 * 工具清單在它前面，一起快取）；換日期、選手資料、天氣只影響斷點後面
 */
function systemParam(request: ChatRequest): string | Anthropic.TextBlockParam[] | undefined {
  const { system, systemStableChars: stableChars } = request;
  if (!system) return undefined;
  if (stableChars === undefined) return system;
  const dynamic = system.slice(stableChars).replace(/^\n+/, "");
  return [
    { type: "text", text: system.slice(0, stableChars), cache_control: { type: "ephemeral" } },
    ...(dynamic ? [{ type: "text" as const, text: dynamic }] : []),
  ];
}

function withoutStrict<T extends { strict?: boolean }>(tool: T): T {
  const { strict: _, ...rest } = tool;
  return rest as T;
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
