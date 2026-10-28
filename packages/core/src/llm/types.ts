/** LLM 呼叫層的供應商中立型別. */

export type Purpose = "chat" | "summary" | "compress";
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 工具定義：JSON Schema 格式，與供應商無關 */
export interface ToolDef {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: false;
    /** 共用的子 schema（以 {"$ref": "#/$defs/名稱"} 引用） */
    $defs?: Record<string, unknown>;
  };
  /**
   * Claude 的 strict tool use：模型的輸入一定符合 schema（每個物件都要 additionalProperties: false，限制見規格 12.31 第 2 點）.
   * 只有 Claude 轉接層會送；OpenAI 相容的供應商不送
   */
  strict?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResult {
  id: string;
  content: string;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** 單次 API 呼叫的用量 */
export interface TurnUsage {
  /** 未快取輸入 */
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

export interface Turn {
  text: string;
  toolCalls: ToolCall[];
  /** ok / refused（模型拒絕回答）/ truncated（達輸出上限被截斷）/ tool_use（要求呼叫工具） */
  finish: "ok" | "refused" | "truncated" | "tool_use";
  usage: TurnUsage;
}

/**
 * 系統提示的兩段（規格 12.23 第 2 點）：stable 是不常變的（角色、教練方法、規則），放在前面讓供應商快取；
 * dynamic 是每天或每次會變的（日期、選手資料、天氣）
 */
export interface SystemPrompt {
  stable: string;
  dynamic: string;
}

/** 兩段接成全文；不支援分段的供應商送這個 */
export function joinSystemPrompt(system: SystemPrompt): string {
  return system.dynamic ? `${system.stable}\n\n${system.dynamic}` : system.stable;
}

export interface ChatRequest {
  model: string;
  /** 系統提示的全文 */
  system?: string;
  /** system 開頭這麼多字元是不常變的一段（SystemPrompt.stable）；支援快取的供應商在它的結尾放斷點 */
  systemStableChars?: number;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** 含思考的總輸出上限 */
  maxTokens: number;
  effort: Effort;
}

export interface NextOptions {
  toolResults?: ToolResult[];
  disableTools?: boolean;
  /** 提供時以串流方式呼叫，回覆文字一產生就交給它；回傳的 Turn 與非串流時相同 */
  onText?: (text: string) => void;
}

/**
 * 一段進行中的對話。供應商原生格式的訊息（含思考區塊、工具呼叫紀錄）由 session 自行保存，
 * 核心只需要交回工具結果。
 */
export interface ChatSession {
  next(opts?: NextOptions): Promise<Turn>;
}

/**
 * 主對話的進度，供介面即時顯示；不影響結果。
 * - thinking：開始一次模型呼叫，在第一段文字出現前模型在思考
 * - text：這次模型呼叫產生的文字片段
 * - tool：開始執行工具；這次模型呼叫先前產生的文字不是最終回覆
 */
export type ChatEvent = { type: "thinking" } | { type: "text"; text: string } | { type: "tool"; name: string };

export interface LlmProvider {
  /** 供 /status 顯示：該模型實際會套用的思考強度；不支援時回傳 null */
  effortFor(model: string, effort: Effort): string | null;
  startChat(request: ChatRequest): ChatSession;
}

/** 模型未產生可用內容（拒絕回答，或輸出在產生文字前就被截斷） */
export class LlmError extends Error {
  override name = "LlmError";
}

/** 單次任務的 token 用量（含多輪 API 呼叫，逐輪累加） */
export class Usage {
  /** 第一輪完整輸入（代表 context 大小，供分層估算） */
  firstInputTokens = 0;
  /** 累計未快取輸入 */
  inputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  outputTokens = 0;
  apiCalls = 0;
  toolRounds = 0;
  /** 依模型單價估算的費用（美元）；有任何一次呼叫的模型不在價格表時為 null */
  costUsd: number | null = 0;

  /** 實際計費的輸入總量（未快取 + 快取讀取 + 快取寫入） */
  get totalInputTokens(): number {
    return this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
  }

  /** cost：這次呼叫的費用（美元），無法估算時為 null */
  add(turn: TurnUsage, cost: number | null = null): void {
    this.costUsd = this.costUsd === null || cost === null ? null : this.costUsd + cost;
    if (this.apiCalls === 0) {
      this.firstInputTokens = turn.input + turn.cacheRead + turn.cacheWrite;
    }
    this.inputTokens += turn.input;
    this.cacheReadTokens += turn.cacheRead;
    this.cacheWriteTokens += turn.cacheWrite;
    this.outputTokens += turn.output;
    this.apiCalls += 1;
  }
}

export interface LlmResult {
  text: string;
  usage: Usage;
  finish: "ok" | "refused" | "truncated";
}
