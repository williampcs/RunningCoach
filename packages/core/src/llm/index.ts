/**
 * LLM 呼叫層 — 對外介面與供應商無關：
 * - complete(purpose, prompt, maxTokens)：單次生成（跑後摘要、對話壓縮）
 * - runWithTools(system, messages, tools, executeTool)：帶工具的多輪對話（主對話）
 *
 * 呼叫端只會看到 LlmResult.finish（ok / refused / truncated）或 LlmError。
 */
import type { Logger } from "../types";
import {
  LlmError,
  Usage,
  type ChatEvent,
  type ChatMessage,
  type Effort,
  type LlmProvider,
  type LlmResult,
  type Purpose,
  type ToolDef,
  type ToolResult,
  type Turn,
} from "./types";

export * from "./types";
export { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic";
export {
  OpenAICompatibleProvider,
  OpenAICompatibleError,
  OPENAI_COMPATIBLE_PRESETS,
  type OpenAICompatibleOptions,
} from "./openai-compatible";

// 單次生成（摘要、壓縮）屬於簡單的內容生成，固定用最低強度
const COMPLETE_EFFORT: Effort = "low";

export interface LlmConfig {
  provider: LlmProvider;
  /** 用途 → 模型 */
  models: Record<Purpose, string>;
  /** 主對話的思考強度 */
  chatEffort: Effort;
  maxResponseTokens: number;
  toolCallMaxRounds: number;
}

export class Llm {
  constructor(
    private readonly config: LlmConfig,
    private readonly logger: Logger,
  ) {}

  /** 各用途實際使用的模型與思考強度（供 /status 顯示） */
  describeModels(): Record<Purpose, string> {
    const describe = (purpose: Purpose, effort: Effort) => {
      const model = this.config.models[purpose];
      const applied = this.config.provider.effortFor(model, effort);
      return applied ? `${model}（思考強度 ${applied}）` : model;
    };
    return {
      chat: describe("chat", this.config.chatEffort),
      summary: describe("summary", COMPLETE_EFFORT),
      compress: describe("compress", COMPLETE_EFFORT),
    };
  }

  /**
   * 單次生成（無工具、無 system prompt）。
   * 模型拒絕回答或沒有產生任何文字時丟出 LlmError，避免呼叫端把空字串當成結果存檔。
   */
  async complete(purpose: Purpose, prompt: string, maxTokens: number): Promise<LlmResult> {
    const usage = new Usage();
    const session = this.config.provider.startChat({
      model: this.config.models[purpose],
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      effort: COMPLETE_EFFORT,
    });
    const turn = await session.next();
    usage.add(turn.usage);
    this.logUsage(purpose, usage);

    const finish = this.finishOf(turn, purpose);
    if (finish === "refused" || !turn.text.trim()) {
      throw new LlmError(`${purpose}: 模型未產生內容（${turn.finish}）`);
    }
    return { text: turn.text, usage, finish };
  }

  /**
   * 帶工具的多輪對話：模型要求呼叫工具時以 executeTool 執行，直到產生最終文字回應。
   * 最多 toolCallMaxRounds 輪；超過時禁止再呼叫工具，取得最終回應。
   * 提供 onEvent 時以串流方式呼叫模型，並回報進度（見 ChatEvent）。
   */
  async runWithTools(
    system: string,
    messages: ChatMessage[],
    tools: ToolDef[],
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>,
    onEvent?: (event: ChatEvent) => void,
  ): Promise<LlmResult> {
    const usage = new Usage();
    const session = this.config.provider.startChat({
      model: this.config.models.chat,
      system,
      messages,
      tools,
      maxTokens: this.config.maxResponseTokens,
      effort: this.config.chatEffort,
    });

    const stream = onEvent ? { onText: (text: string) => onEvent({ type: "text", text }) } : {};

    onEvent?.({ type: "thinking" });
    let turn = await session.next(stream);
    usage.add(turn.usage);

    for (let round = 1; turn.finish === "tool_use"; round++) {
      usage.toolRounds += 1;
      const toolResults: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        onEvent?.({ type: "tool", name: call.name });
        const content = await executeTool(call.name, call.input);
        this.logger.info(`Tool [${call.name}] input=${JSON.stringify(call.input)} → ${content.slice(0, 120)}`);
        toolResults.push({ id: call.id, content });
      }

      const lastRound = round >= this.config.toolCallMaxRounds;
      if (lastRound) this.logger.warn(`Max tool call rounds (${this.config.toolCallMaxRounds}) reached`);
      onEvent?.({ type: "thinking" });
      turn = await session.next({ toolResults, disableTools: lastRound, ...stream });
      usage.add(turn.usage);
      if (lastRound) break;
    }

    this.logUsage("chat", usage);
    return { text: turn.text, usage, finish: this.finishOf(turn, "chat") };
  }

  private finishOf(turn: Turn, purpose: Purpose): LlmResult["finish"] {
    if (turn.finish === "refused") {
      this.logger.warn(`${purpose} refused`);
      return "refused";
    }
    if (turn.finish === "truncated") {
      this.logger.warn(`${purpose} hit max tokens — output truncated`);
      return "truncated";
    }
    return "ok";
  }

  private logUsage(purpose: Purpose, usage: Usage): void {
    this.logger.info(
      `${purpose} tokens — input: ${usage.totalInputTokens} (cache read ${usage.cacheReadTokens}, ` +
        `write ${usage.cacheWriteTokens}), output: ${usage.outputTokens}, calls: ${usage.apiCalls}, ` +
        `tool_rounds: ${usage.toolRounds}`,
    );
  }
}
