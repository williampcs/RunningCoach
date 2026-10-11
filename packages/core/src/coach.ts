/** Coach — 組合 context、執行工具、呼叫模型；各外殼（Discord、網頁）只跟這個類別互動. */
import { ContextManager, type LayerChars, type StatusSummary } from "./context";
import { isoWeekLabel, localDate } from "./dates";
import { Db } from "./db";
import { Llm, type LlmConfig, type Purpose, type Usage } from "./llm";
import { compressConversations } from "./summarizer";
import { runSync } from "./sync";
import { buildTools, createToolExecutor, generateWorkoutSummary, type ToolExecutor } from "./tools";
import {
  DEFAULT_SETTINGS,
  silentLogger,
  type Activity,
  type ActivitySource,
  type CoachSettings,
  type Logger,
  type SqlDriver,
} from "./types";

// 模型沒有給出可用回覆時顯示給使用者的訊息
const REFUSED_REPLY = "這個問題我沒辦法回覆，換個方式問問看？";
const EMPTY_REPLY = "這次沒有產生回覆（可能是內容太長被截斷），請再問一次，或把問題拆小一點。";

/** 單次對話的用量統計（主對話，不含背景壓縮） */
export interface UsageStats {
  /** 各層字元數，用於比例估算 */
  layerChars: LayerChars;
  userMsgChars: number;
  /** 實際 API 用量（含所有 tool call 輪次） */
  usage: Usage;
}

export interface ChatReply {
  reply: string;
  stats: UsageStats;
}

export type RunReport =
  /** 找到今天的活動，已合併主觀感受存檔 */
  | { status: "saved"; activity: Activity; workoutId: number; summary: string | null }
  /** 最新活動不是今天（手錶尚未同步），主觀感受已暫存，之後同步時自動合併 */
  | { status: "pending"; date: string; latest: Activity | null };

export interface CoachOptions {
  driver: SqlDriver;
  llm: Omit<LlmConfig, "maxResponseTokens" | "toolCallMaxRounds">;
  activities: ActivitySource;
  settings?: Partial<CoachSettings>;
  now?: () => Date;
  logger?: Logger;
}

export class Coach {
  readonly db: Db;
  readonly settings: CoachSettings;
  private readonly llm: Llm;
  private readonly context: ContextManager;
  private readonly activities: ActivitySource;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly executeTool: ToolExecutor;
  private compressing: Promise<void> | null = null;

  constructor(options: CoachOptions) {
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings };
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
    this.activities = options.activities;
    this.db = new Db(options.driver, { now: this.now, today: () => this.today() });
    this.llm = new Llm(
      {
        ...options.llm,
        maxResponseTokens: this.settings.maxResponseTokens,
        toolCallMaxRounds: this.settings.toolCallMaxRounds,
      },
      this.logger,
    );
    this.context = new ContextManager(this.db, this.settings, this.now);
    this.executeTool = createToolExecutor({
      db: this.db,
      llm: this.llm,
      activities: this.activities,
      settings: this.settings,
      today: () => this.today(),
      logger: this.logger,
    });
  }

  /** 使用者時區的今天，YYYY-MM-DD */
  today(): string {
    return localDate(this.now(), this.settings.timeZone);
  }

  /** 建立資料表並執行 migration；使用前呼叫一次 */
  init(): Promise<void> {
    return this.db.init();
  }

  /** 接收使用者訊息，回傳模型的文字回應與 token 用量統計 */
  async chat(userMessage: string): Promise<ChatReply> {
    await this.db.appendConversation("user", userMessage);

    // 背景觸發壓縮（不阻塞主流程）
    if (await this.context.shouldCompress()) this.compressInBackground();

    const context = await this.context.getContextForApi();
    let result;
    try {
      result = await this.llm.runWithTools(
        context.system,
        context.messages,
        buildTools(this.settings),
        this.executeTool,
      );
    } catch (e) {
      this.logger.error(`LLM API error: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }

    let reply = result.text;
    if (result.finish === "refused") reply = REFUSED_REPLY;
    else if (!result.text.trim()) reply = EMPTY_REPLY;

    await this.db.appendConversation("assistant", reply);
    return {
      reply,
      stats: { layerChars: context.layerChars, userMsgChars: userMessage.length, usage: result.usage },
    };
  }

  private compressInBackground(): void {
    // 上一次壓縮還在進行時不重複觸發，避免同一批對話被摘要兩次
    if (this.compressing) return;
    this.compressing = compressConversations({
      db: this.db,
      context: this.context,
      llm: this.llm,
      logger: this.logger,
    }).finally(() => {
      this.compressing = null;
    });
  }

  /** 等待背景工作（對話壓縮）結束；供測試與關閉前使用 */
  async idle(): Promise<void> {
    await this.compressing;
  }

  /** 從活動來源同步最近的跑步活動，並合併主觀暫存 */
  sync(): Promise<string> {
    return runSync({ db: this.db, llm: this.llm, activities: this.activities, logger: this.logger });
  }

  /**
   * 跑後回報（有表單介面的外殼使用）：不經過模型的工具迴圈，直接拉取活動並存檔。
   * 找到今天的活動時合併主觀感受並生成摘要；否則暫存主觀感受，等同步時合併。
   */
  async reportRun(perceivedEffort: number, subjectiveNotes: string): Promise<RunReport> {
    const today = this.today();
    const latest = await this.activities.fetchLatestActivity();
    if (!latest || latest.date !== today) {
      await this.db.savePendingSubjective(today, perceivedEffort, subjectiveNotes);
      return { status: "pending", date: today, latest };
    }

    const workoutId = await this.db.saveWorkout(latest, perceivedEffort, subjectiveNotes || null);
    let summary: string | null = null;
    try {
      summary = await generateWorkoutSummary(this.llm, {
        ...latest,
        perceived_effort: perceivedEffort,
        subjective_notes: subjectiveNotes,
      });
      await this.db.saveWorkoutSummary(workoutId, summary);
    } catch (e) {
      this.logger.warn(`Summary generation failed for workout_id=${workoutId}: ${String(e)}`);
    }
    return { status: "saved", activity: latest, workoutId, summary };
  }

  /** 以本週的 ISO 週標籤儲存訓練計畫（/plan） */
  async savePlanForThisWeek(content: string): Promise<string> {
    const weekLabel = isoWeekLabel(this.today());
    await this.db.saveTrainingPlan(weekLabel, content);
    return weekLabel;
  }

  status(): Promise<StatusSummary> {
    return this.context.getStatusSummary();
  }

  /** 各用途實際使用的模型與思考強度 */
  describeModels(): Record<Purpose, string> {
    return this.llm.describeModels();
  }
}
