/**
 * LLM 呼叫層 — 對外介面與供應商無關：
 * - complete(purpose, prompt, maxTokens)：單次生成（跑後摘要、對話壓縮）
 * - runWithTools(system, messages, tools, executeTool)：帶工具的多輪對話（主對話）
 *
 * 呼叫端只會看到 LlmResult.finish（ok / refused / truncated / stopped）或 LlmError。
 */
import type { Logger } from "../types";
import {
  joinSystemPrompt,
  LlmError,
  Usage,
  type ChatEvent,
  type ChatMessage,
  type Effort,
  type LlmProvider,
  type LlmResult,
  type Meter,
  type NextOptions,
  type Purpose,
  type SystemPrompt,
  type ToolDef,
  type ToolResult,
  type Turn,
} from "./types";
import { turnCostUsd } from "./pricing";

export * from "./types";
export { priceOf, turnCostUsd, type ModelPrice } from "./pricing";
export { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic";
export { checkLlmKey, classifyKeyError, keyProblemText, type KeyCheck, type KeyProblem } from "./check";
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
  async complete(purpose: Purpose, prompt: string, maxTokens: number, options: { meter?: Meter } = {}): Promise<LlmResult> {
    const usage = new Usage();
    const session = this.config.provider.startChat({
      model: this.config.models[purpose],
      messages: [{ role: "user", content: prompt }],
      maxTokens,
      effort: COMPLETE_EFFORT,
      // 免費試用的每天次數（規格 12.39）：壓縮跟著對話發生，摘要是自動的分析；選手自己按的（匯入整理）由呼叫端指定 chat
      meter: options.meter ?? (purpose === "compress" ? "compress" : "auto"),
    });
    const turn = await session.next();
    usage.add(turn.usage, turnCostUsd(this.config.models[purpose], turn.usage));
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
   * system 分成兩段（SystemPrompt）時，支援快取的供應商在不常變的那段結尾放快取斷點。
   */
  async runWithTools(
    system: string | SystemPrompt,
    messages: ChatMessage[],
    tools: ToolDef[],
    executeTool: (name: string, input: Record<string, unknown>) => Promise<string>,
    onEvent?: (event: ChatEvent) => void,
    signal?: AbortSignal,
  ): Promise<LlmResult> {
    const usage = new Usage();
    const session = this.config.provider.startChat({
      model: this.config.models.chat,
      ...(typeof system === "string"
        ? { system }
        : { system: joinSystemPrompt(system), systemStableChars: system.stable.length }),
      messages,
      tools,
      maxTokens: this.config.maxResponseTokens,
      effort: this.config.chatEffort,
      meter: "chat",
    });

    // 這次模型呼叫已經寫出的文字：停止時存成教練那則的開頭
    let partial = "";
    const stream = onEvent
      ? {
          onText: (text: string) => {
            partial += text;
            onEvent({ type: "text", text });
          },
          onToolStart: (name: string) => {
            // 工具前的文字不是回覆：停止時不存
            partial = "";
            onEvent({ type: "preparing", name });
          },
          onRetry: () => onEvent({ type: "retry" }),
        }
      : {};
    // 停止（規格 12.38）：不再等模型、不開始下一輪；正在執行的工具讓它做完
    const stopped = (): LlmResult => {
      this.logUsage("chat", usage);
      return { text: partial, usage, finish: "stopped" };
    };
    const next = async (opts: NextOptions): Promise<Turn | null> => {
      if (signal?.aborted) return null;
      partial = "";
      try {
        return await session.next({ ...opts, ...stream, signal });
      } catch (e) {
        if (signal?.aborted) return null;
        throw e;
      }
    };

    onEvent?.({ type: "thinking" });
    let turn = await next({});
    if (!turn) return stopped();
    usage.add(turn.usage, turnCostUsd(this.config.models.chat, turn.usage));

    for (let round = 1; turn.finish === "tool_use"; round++) {
      usage.toolRounds += 1;
      const toolResults: ToolResult[] = [];
      for (const call of turn.toolCalls) {
        // 停止後同一輪剩下的工具不執行
        if (signal?.aborted) break;
        onEvent?.({ type: "tool", name: call.name });
        const content = await executeTool(call.name, call.input);
        this.logger.info(`Tool [${call.name}] input=${JSON.stringify(call.input)} → ${content.slice(0, 120)}`);
        toolResults.push({ id: call.id, content });
      }
      if (signal?.aborted) {
        partial = "";
        return stopped();
      }

      const lastRound = round >= this.config.toolCallMaxRounds;
      if (lastRound) this.logger.warn(`Max tool call rounds (${this.config.toolCallMaxRounds}) reached`);
      onEvent?.({ type: "thinking" });
      const following = await next({ toolResults, disableTools: lastRound });
      if (!following) return stopped();
      turn = following;
      usage.add(turn.usage, turnCostUsd(this.config.models.chat, turn.usage));
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
        `tool_rounds: ${usage.toolRounds}` +
        (usage.costUsd === null ? "" : `, cost: US$${usage.costUsd.toFixed(5)}`),
    );
  }
}
