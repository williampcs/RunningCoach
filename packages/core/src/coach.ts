/** Coach — 組合 context、執行工具、呼叫模型；各外殼（Discord、網頁）只跟這個類別互動. */
import { buildExtractionPrompt, parseExtraction, type ImportSuggestion } from "./athlete-import";
import { ContextManager, type LayerChars, type StatusSummary } from "./context";
import { buildFeed, type FeedItem } from "./feed";
import { isoWeekLabel, localDate } from "./dates";
import { Db } from "./db";
import { Llm, type ChatEvent, type LlmConfig, type Purpose, type Usage } from "./llm";
import { compressConversations } from "./summarizer";
import { recoveryNoteFor } from "./recovery";
import { runSync } from "./sync";
import { buildTools, createToolExecutor, generateWorkoutSummary, type ToolExecutor } from "./tools";
import {
  DEFAULT_SETTINGS,
  silentLogger,
  type Activity,
  type ActivitySource,
  type CoachSettings,
  type DailyCheckin,
  type Logger,
  type SqlDriver,
  type Workout,
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

/** 可以在執行中更換的部分（見 Coach.configure） */
export type CoachConfig = Pick<CoachOptions, "llm" | "activities" | "settings">;

/** 由 CoachConfig 建出的元件；一輪對話從頭到尾使用同一份 */
interface Runtime {
  settings: CoachSettings;
  llm: Llm;
  context: ContextManager;
  activities: ActivitySource;
  executeTool: ToolExecutor;
}

export class Coach {
  readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private runtime: Runtime;
  private compressing: Promise<void> | null = null;

  constructor(options: CoachOptions) {
    this.now = options.now ?? (() => new Date());
    this.logger = options.logger ?? silentLogger;
    this.db = new Db(options.driver, { now: this.now, today: () => this.today() });
    this.runtime = this.buildRuntime(options);
  }

  /**
   * 更換 LLM、活動來源與設定（網頁版儲存設定時）。資料庫與背景壓縮的狀態保留：
   * 若改為重建 Coach，新舊實例各有一個操作佇列與壓縮旗標，背景壓縮進行中時
   * 兩邊的 SQL 可能交錯進同一個交易，或重複壓縮同一批對話。
   * 進行中的對話與壓縮沿用開始時的設定。
   */
  configure(config: CoachConfig): void {
    this.runtime = this.buildRuntime(config);
  }

  private buildRuntime(config: CoachConfig): Runtime {
    const settings = { ...DEFAULT_SETTINGS, ...config.settings };
    const llm = new Llm(
      {
        ...config.llm,
        maxResponseTokens: settings.maxResponseTokens,
        toolCallMaxRounds: settings.toolCallMaxRounds,
      },
      this.logger,
    );
    return {
      settings,
      llm,
      context: new ContextManager(this.db, settings, this.now),
      activities: config.activities,
      executeTool: createToolExecutor({
        db: this.db,
        llm,
        activities: config.activities,
        settings,
        today: () => localDate(this.now(), settings.timeZone),
        logger: this.logger,
      }),
    };
  }

  get settings(): CoachSettings {
    return this.runtime.settings;
  }

  /** 使用者時區的今天，YYYY-MM-DD */
  today(): string {
    return localDate(this.now(), this.settings.timeZone);
  }

  /** 建立資料表並執行 migration；使用前呼叫一次 */
  init(): Promise<void> {
    return this.db.init();
  }

  /**
   * 接收使用者訊息，回傳模型的文字回應與 token 用量統計。
   * 提供 onEvent 時以串流方式呼叫模型並回報進度；回覆仍在完成後才寫入對話紀錄。
   */
  async chat(userMessage: string, onEvent?: (event: ChatEvent) => void): Promise<ChatReply> {
    const rt = this.runtime;
    await this.db.appendConversation("user", userMessage);

    // 背景觸發壓縮（不阻塞主流程）
    if (await rt.context.shouldCompress()) this.compressInBackground(rt);

    const context = await rt.context.getContextForApi();
    let result;
    try {
      result = await rt.llm.runWithTools(
        context.system,
        context.messages,
        buildTools(rt.settings),
        rt.executeTool,
        onEvent,
      );
    } catch (e) {
      this.logger.error(`LLM API error: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }

    let reply = result.text;
    if (result.finish === "refused") reply = REFUSED_REPLY;
    else if (!result.text.trim()) reply = EMPTY_REPLY;

    await this.db.appendConversation("assistant", reply);
    // 剛送出的訊息先存進資料庫才組合 context，所以也算在層5；頁尾另列為「訊息」，層5扣掉以免重複計算
    const sentChars = context.messages.at(-1)?.content.length ?? 0;
    return {
      reply,
      stats: {
        layerChars: { ...context.layerChars, layer5: context.layerChars.layer5 - sentChars },
        userMsgChars: sentChars,
        usage: result.usage,
      },
    };
  }

  private compressInBackground(rt: Runtime): void {
    // 上一次壓縮還在進行時不重複觸發，避免同一批對話被摘要兩次
    if (this.compressing) return;
    this.compressing = compressConversations({
      db: this.db,
      context: rt.context,
      llm: rt.llm,
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
    const { llm, activities } = this.runtime;
    return runSync({ db: this.db, llm, activities, logger: this.logger });
  }

  /**
   * 跑後回報（有表單介面的外殼使用）：不經過模型的工具迴圈，直接拉取活動並存檔。
   * 找到今天的活動時合併主觀感受並生成摘要；否則暫存主觀感受，等同步時合併。
   */
  async reportRun(perceivedEffort: number, subjectiveNotes: string): Promise<RunReport> {
    const { llm, activities } = this.runtime;
    const today = this.today();
    const latest = await activities.fetchLatestActivity();
    if (!latest || latest.date !== today) {
      await this.db.savePendingSubjective(today, perceivedEffort, subjectiveNotes);
      return { status: "pending", date: today, latest };
    }

    const workoutId = await this.db.saveWorkout(latest, perceivedEffort, subjectiveNotes || null);
    let summary: string | null = null;
    try {
      summary = await generateWorkoutSummary(llm, {
        ...latest,
        perceived_effort: perceivedEffort,
        subjective_notes: subjectiveNotes,
        recovery: await recoveryNoteFor(this.db, latest.date),
      });
      await this.db.saveWorkoutSummary(workoutId, summary);
    } catch (e) {
      this.logger.warn(`Summary generation failed for workout_id=${workoutId}: ${String(e)}`);
    }
    return { status: "saved", activity: latest, workoutId, summary };
  }

  /**
   * 補填或修改已存檔訓練的主觀感受（例如同步進來、當時沒有回報的紀錄），
   * 並帶著體感重新產生分析摘要。摘要失敗時保留原本的摘要，summary 為 null。
   */
  async addSubjective(
    workoutId: number,
    perceivedEffort: number,
    subjectiveNotes: string,
  ): Promise<{ workout: Workout; summary: string | null }> {
    const existing = await this.db.getWorkout(workoutId);
    if (!existing) throw new Error(`找不到這筆訓練紀錄（id=${workoutId}）`);

    const notes = subjectiveNotes.trim() || null;
    await this.db.updateWorkoutSubjective(workoutId, perceivedEffort, notes);
    let summary: string | null = null;
    try {
      summary = await generateWorkoutSummary(this.runtime.llm, {
        ...existing,
        perceived_effort: perceivedEffort,
        subjective_notes: notes,
        recovery: await recoveryNoteFor(this.db, existing.date),
      });
      await this.db.saveWorkoutSummary(workoutId, summary);
    } catch (e) {
      this.logger.warn(`Summary generation failed for workout_id=${workoutId}: ${String(e)}`);
    }
    return { workout: (await this.db.getWorkout(workoutId))!, summary };
  }

  /** 記錄今天的身體狀況自評（1–5 分），同一天再次記錄會覆蓋 */
  async saveCheckin(checkin: Omit<DailyCheckin, "date">): Promise<DailyCheckin> {
    const saved = { ...checkin, date: this.today(), notes: checkin.notes?.trim() || null };
    for (const key of ["energy", "soreness", "sleep"] as const) {
      if (!Number.isInteger(saved[key]) || saved[key] < 1 || saved[key] > 5) throw new Error(`${key} 必須是 1–5 的整數`);
    }
    await this.db.saveCheckin(saved);
    return saved;
  }

  /** 教練動態：打開 App 時要提醒的事項 */
  feed(): Promise<FeedItem[]> {
    return buildFeed(this.db, this.today(), this.settings);
  }

  /** 以本週的 ISO 週標籤儲存訓練計畫（/plan） */
  async savePlanForThisWeek(content: string): Promise<string> {
    const weekLabel = isoWeekLabel(this.today());
    await this.db.saveTrainingPlan(weekLabel, content);
    return weekLabel;
  }

  /** 從其他 AI 服務整理來的文字擷取選手資料、賽事與課表的建議值；不寫入任何東西 */
  async extractImport(text: string): Promise<ImportSuggestion> {
    const reply = await this.runtime.llm.complete("summary", buildExtractionPrompt(text.trim(), this.today()), 4000);
    return parseExtraction(reply.text, this.today());
  }

  /** 寫入使用者確認過的項目；課表會成為本週的計畫 */
  async applyImport(selected: ImportSuggestion): Promise<{ profile: number; races: number; plan: boolean }> {
    const entries = Object.entries(selected.profile).filter(([, value]) => value.trim());
    for (const [key, value] of entries) await this.db.setProfileKey(key, value.trim());
    for (const race of selected.races) {
      await this.db.addRace({
        name: race.name,
        date: race.date,
        distance_km: race.distance_km,
        target_time: race.target_time ?? undefined,
        notes: race.notes ?? undefined,
      });
    }
    const plan = selected.plan?.trim() ?? "";
    if (plan) await this.savePlanForThisWeek(plan);
    return { profile: entries.length, races: selected.races.length, plan: plan !== "" };
  }

  status(): Promise<StatusSummary> {
    return this.runtime.context.getStatusSummary();
  }

  /** 各用途實際使用的模型與思考強度 */
  describeModels(): Record<Purpose, string> {
    return this.runtime.llm.describeModels();
  }
}
