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
  };
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

export interface ChatRequest {
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  /** 含思考的總輸出上限 */
  maxTokens: number;
  effort: Effort;
}

/**
 * 一段進行中的對話。供應商原生格式的訊息（含思考區塊、工具呼叫紀錄）由 session 自行保存，
 * 核心只需要交回工具結果。
 */
export interface ChatSession {
  next(opts?: { toolResults?: ToolResult[]; disableTools?: boolean }): Promise<Turn>;
}

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

  /** 實際計費的輸入總量（未快取 + 快取讀取 + 快取寫入） */
  get totalInputTokens(): number {
    return this.inputTokens + this.cacheReadTokens + this.cacheWriteTokens;
  }

  add(turn: TurnUsage): void {
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
