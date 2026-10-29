/** Coach — 組合 context、執行工具、呼叫模型；各外殼（Discord、網頁）只跟這個類別互動. */
import { buildExtractionPrompt, parseExtraction, type ImportSuggestion } from "./athlete-import";
import { ContextManager, type LayerChars, type StatusSummary } from "./context";
import { buildFeed, RACE_WEATHER_FEED_DAYS, type FeedItem } from "./feed";
import { featureOn } from "./features";
import { accumulation, rideAccumulation, rideCards, runCards, type Accumulation, type RideAccumulation, type RideCard, type RunCard } from "./history";
import { importHistory, type ImportProgress, type ImportResult } from "./history-import";
import { activePlan, changeSession, nextPlan, planNoteFor, selfChangeReason, selfChangeSession, type ActivePlan, type SelfChangeRequest, type SessionAction } from "./planning";
import type { SelfChange, SelfChangeReason } from "./plan";
import { pastPlanWeeks, type PastWeek } from "./plan-history";
import { isoWeekLabel, localDate } from "./dates";
import { Db, type ManualWorkoutInput } from "./db";
import { Llm, type ChatEvent, type LlmConfig, type Purpose, type Usage } from "./llm";
import { compressConversations } from "./summarizer";
import { sameRun } from "./dedupe";
import { sportOfType } from "./sports";
import { recoveryNoteFor } from "./recovery";
import { runSync, SYNC_DAYS } from "./sync";
import { editRace, markRaceNotStarted, placeFields, raceActivity, recordRaceResult } from "./races";
import type { RaceUpdate } from "./db";
import { runWeatherNote, todayWeatherLine, type WeatherForecast, type WeatherHour, type WeatherSource } from "./weather";
import { racePlaceOf, type RaceWeatherSource } from "./race-weather";
import { analyzeRide, weeklyVolumeOf, type WeekVolume } from "./ride-analysis";
import {
  buildTools,
  createToolExecutor,
  generateWorkoutSummary,
  sourcesOf,
  TOOL_FAILED_PREFIX,
  type ToolExecutor,
} from "./tools";
import {
  DEFAULT_SETTINGS,
  silentLogger,
  type Activity,
  type ActivitySource,
  type CoachSettings,
  type DailyCheckin,
  type OtherActivity,
  type Race,
  type Logger,
  type Sport,
  type ReplyRef,
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
  /** 回覆前讀過的資料（例如「訓練數值」「最近 14 天的訓練」），由實際呼叫的工具產生 */
  sources: string[];
}

export type RunReport =
  /** 找到今天的活動，已合併主觀感受存檔 */
  | { status: "saved"; activity: Activity; workoutId: number; summary: string | null }
  /** 最新活動不是今天（手錶尚未同步），主觀感受已暫存，之後同步時自動合併 */
  | { status: "pending"; date: string; latest: Activity | null }
  /** 騎車等其他運動（多運動）：體感存到那一趟 */
  /** summary：騎車的分析（多運動開著時，規格 12.31）；其他運動或產生失敗時為 null */
  | { status: "other"; activity: OtherActivity; summary: string | null };

/** 跑後回報要存到哪裡 */
export type ReportTarget =
  /** 已同步進資料庫的紀錄 */
  | { kind: "saved"; workoutId: number }
  /** Intervals.icu 上有、還沒同步的活動 */
  | { kind: "new"; intervalsId: string }
  /** 手錶還沒上傳：暫存為今天的回報，同步時配對 */
  | { kind: "pending" }
  /** 已同步的騎車等其他運動（多運動） */
  | { kind: "other"; intervalsId: string };

/** 跑後回報可以選的一筆跑步 */
export interface ReportCandidate {
  target: Exclude<ReportTarget, { kind: "pending" }>;
  activity: Activity;
  /** 開始時間（當地），例：07:12；來源沒有提供時為 null */
  startTime: string | null;
  /** 哪種運動（多運動）；跑步是 run */
  sport: Sport;
}

/** 跑後回報列出幾天內的跑步：今天、昨天、前天 */
const REPORT_LOOKBACK_DAYS = 2;

/** 原始資料中的當地開始時間，例：2026-10-19T07:12:00 → 07:12 */
function startTimeOf(rawJson: string | null | undefined): string | null {
  if (!rawJson) return null;
  try {
    const start = (JSON.parse(rawJson) as { start_date_local?: unknown }).start_date_local;
    return typeof start === "string" && /T\d{2}:\d{2}/.test(start) ? start.slice(11, 16) : null;
  } catch {
    return null;
  }
}

/** 其他運動當成 Activity 顯示（跑後回報的選項） */
function otherAsActivity(a: OtherActivity): Activity {
  return {
    intervals_id: a.intervals_id,
    date: a.date,
    type: a.type,
    distance_km: a.distance_km,
    duration_min: a.duration_min,
    avg_hr: a.avg_hr,
    max_hr: null,
    avg_pace: null,
    elevation_m: null,
    calories: null,
    training_load: a.training_load,
    raw_json: a.raw_json ?? null,
  };
}

/** 手動新增的欄位檢查；錯誤訊息直接給選手看 */
export function checkManualWorkout(input: ManualWorkoutInput, today: string): ManualWorkoutInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new Error("日期的格式不對");
  if (input.date > today) throw new Error("不能記還沒到的日子");
  if (!(input.distance_km > 0 && input.distance_km <= 200)) throw new Error("距離要在 0–200 km 之間");
  if (!(input.duration_min >= 1 && input.duration_min <= 24 * 60)) throw new Error("時間至少 1 分鐘");
  // 每公里不到 2 分鐘：多半是距離或時間打錯
  if (input.duration_min / input.distance_km < 2) throw new Error("配速快過每公里 2 分鐘，請確認距離與時間");
  if (!Number.isInteger(input.perceived_effort) || input.perceived_effort < 1 || input.perceived_effort > 10) throw new Error("體感要是 1–10");
  if (input.avg_hr !== null && !(Number.isInteger(input.avg_hr) && input.avg_hr >= 40 && input.avg_hr <= 240)) throw new Error("平均心率要在 40–240 之間");
  return { ...input, distance_km: Math.round(input.distance_km * 100) / 100, subjective_notes: input.subjective_notes?.trim() || null };
}

function workoutAsActivity(w: Workout): Activity {
  return {
    intervals_id: w.intervals_id,
    strava_id: w.strava_id,
    source: w.source ?? undefined,
    date: w.date,
    type: w.type,
    distance_km: w.distance_km,
    duration_min: w.duration_min,
    avg_hr: w.avg_hr,
    max_hr: w.max_hr,
    avg_pace: w.avg_pace,
    elevation_m: w.elevation_m,
    calories: w.calories,
    training_load: w.training_load,
    raw_json: w.raw_json ?? null,
  };
}

export interface CoachOptions {
  driver: SqlDriver;
  llm: Omit<LlmConfig, "maxResponseTokens" | "toolCallMaxRounds">;
  activities: ActivitySource;
  /** 天氣（選手設定了天氣的城市時）；地點只在 WeatherSource 裡，Coach 看不到 */
  weather?: WeatherSource | null;
  /** 比賽地點的天氣（規格 12.31）：地點在賽事上，只用來查天氣；沒有時教練與看板查不到比賽日的天氣 */
  raceWeather?: RaceWeatherSource | null;
  settings?: Partial<CoachSettings>;
  now?: () => Date;
  logger?: Logger;
}

/** 可以在執行中更換的部分（見 Coach.configure） */
export type CoachConfig = Pick<CoachOptions, "llm" | "activities" | "weather" | "raceWeather" | "settings">;

/** 由 CoachConfig 建出的元件；一輪對話從頭到尾使用同一份 */
interface Runtime {
  settings: CoachSettings;
  llm: Llm;
  context: ContextManager;
  activities: ActivitySource;
  weather: WeatherSource | null;
  raceWeather: RaceWeatherSource | null;
  executeTool: ToolExecutor;
}

/** 對話與教練動態等天氣最多等多久；取不到就不帶天氣 */
const WEATHER_WAIT_MS = 4000;

/** 恢復資料超過這麼久沒更新時，打開 App 或對話前自動重新取得 */
export const WELLNESS_MAX_AGE_MS = 30 * 60_000;

export class Coach {
  readonly db: Db;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private runtime: Runtime;
  private compressing: Promise<void> | null = null;
  /** 上次從活動來源取得恢復資料的時間（毫秒）；同步也算 */
  private wellnessFetchedAt = -Infinity;
  private wellnessRefresh: Promise<boolean> | null = null;

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
    // 活動來源可能換了（新的 API key、測試模式的假資料），下次重新取得恢復資料
    this.wellnessFetchedAt = -Infinity;
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
      weather: config.weather ?? null,
      raceWeather: config.raceWeather ?? null,
      executeTool: createToolExecutor({
        db: this.db,
        llm,
        activities: config.activities,
        weather: config.weather ?? null,
        raceWeather: config.raceWeather ?? null,
        settings,
        today: () => localDate(this.now(), settings.timeZone),
        logger: this.logger,
      }),
    };
  }

  get settings(): CoachSettings {
    return this.runtime.settings;
  }

  /** 現在的時間（測試模式模擬的日期也算進去） */
  currentTime(): Date {
    return this.now();
  }

  /** 使用者時區的今天，YYYY-MM-DD */
  today(): string {
    return localDate(this.now(), this.settings.timeZone);
  }

  /** 有沒有設定天氣 */
  get hasWeather(): boolean {
    return this.runtime.weather !== null;
  }

  /** 今天起 7 天的預報；沒設定、逾時或取不到時為 null（只記錄，不丟錯） */
  async weatherForecast(): Promise<WeatherForecast | null> {
    const { weather } = this.runtime;
    if (!weather) return null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        weather.forecast(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), WEATHER_WAIT_MS);
        }),
      ]);
    } catch (e) {
      this.logger.warn(`Weather fetch failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 系統提示的天氣：undefined 沒有設定；null 設定了但取不到 */
  private async weatherLine(rt: Runtime): Promise<string | null | undefined> {
    if (!rt.weather) return undefined;
    const forecast = await this.weatherForecast();
    return forecast ? todayWeatherLine(forecast, this.today()) : null;
  }

  /** 建立資料表並執行 migration；使用前呼叫一次 */
  init(): Promise<void> {
    return this.db.init();
  }

  /**
   * 接收使用者訊息，回傳模型的文字回應與 token 用量統計。
   * 提供 onEvent 時以串流方式呼叫模型並回報進度；回覆仍在完成後才寫入對話紀錄。
   * replyTo：選手回覆的那一則（教練會看到它的時間與前段文字）
   */
  async chat(userMessage: string, onEvent?: (event: ChatEvent) => void, options: { replyTo?: ReplyRef | null } = {}): Promise<ChatReply> {
    const rt = this.runtime;
    await this.db.appendConversation("user", userMessage, [], options.replyTo ?? null);
    // 手錶早上才同步的靜息心率、HRV 與睡眠，對話前先取得，教練才不會拿昨天的資料當今天的
    await this.refreshWellness();

    // 背景觸發壓縮（不阻塞主流程）
    if (await rt.context.shouldCompress()) this.compressInBackground(rt);

    const context = await rt.context.getContextForApi({ weather: await this.weatherLine(rt) });
    // 記下這次呼叫成功的工具，作為回覆的依據
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    const executeTool: ToolExecutor = async (name, input) => {
      const output = await rt.executeTool(name, input);
      if (!output.startsWith(TOOL_FAILED_PREFIX)) calls.push({ name, input });
      return output;
    };
    let result;
    try {
      result = await rt.llm.runWithTools(context.system, context.messages, buildTools(rt.settings, { weather: rt.weather !== null }), executeTool, onEvent);
    } catch (e) {
      this.logger.error(`LLM API error: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    }

    let reply = result.text;
    if (result.finish === "refused") reply = REFUSED_REPLY;
    else if (!result.text.trim()) reply = EMPTY_REPLY;

    const sources = sourcesOf(calls);
    await this.db.appendConversation("assistant", reply, sources);
    // 剛送出的訊息先存進資料庫才組合 context，所以也算在層5；頁尾另列為「訊息」，層5扣掉以免重複計算
    const sentChars = context.messages.at(-1)?.content.length ?? 0;
    return {
      reply,
      stats: {
        layerChars: { ...context.layerChars, layer5: context.layerChars.layer5 - sentChars },
        userMsgChars: sentChars,
        usage: result.usage,
      },
      sources,
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
      multisport: featureOn(rt.settings, "multisport"),
    }).finally(() => {
      this.compressing = null;
    });
  }

  /** 等待背景工作（對話壓縮）結束；供測試與關閉前使用 */
  async idle(): Promise<void> {
    await this.compressing;
  }

  /** 從活動來源同步最近的跑步活動，並合併主觀暫存 */
  async sync(): Promise<string> {
    const { llm, activities, weather } = this.runtime;
    const result = await runSync({ db: this.db, llm, activities, weather, logger: this.logger, multisport: featureOn(this.runtime.settings, "multisport") });
    this.wellnessFetchedAt = this.now().getTime();
    return result;
  }

  /** 匯入完整歷史：只存紀錄，不產生 AI 分析（不花模型的費用）；可以重跑 */
  importHistory(onProgress?: (p: ImportProgress) => void): Promise<ImportResult> {
    return importHistory(this.db, this.runtime.activities, this.today(), onProgress);
  }

  /** 活動來源能不能匯入完整歷史 */
  get canImportHistory(): boolean {
    return typeof this.runtime.activities.fetchRunsBetween === "function";
  }

  /**
   * 恢復資料（靜息心率、HRV、睡眠）超過 maxAgeMs 沒更新時，從活動來源重新取得最近 14 天的。
   * 只讀取，不呼叫 LLM、不花費用；打開 App、回到前景與對話前呼叫。失敗只記錄。回傳是否取得了資料。
   */
  refreshWellness(maxAgeMs = WELLNESS_MAX_AGE_MS): Promise<boolean> {
    const { activities } = this.runtime;
    if (!activities.fetchWellness || this.now().getTime() - this.wellnessFetchedAt < maxAgeMs) return Promise.resolve(false);
    // 同時有好幾個地方要求更新（例如回到前景時正好送出訊息）時只取一次
    this.wellnessRefresh ??= (async () => {
      try {
        await this.db.upsertWellness(await activities.fetchWellness!(SYNC_DAYS));
        return true;
      } catch (e) {
        this.logger.warn(`Wellness refresh failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      } finally {
        // 失敗時也等下一個間隔再試：連不上時，不要每則訊息都卡在逾時
        this.wellnessFetchedAt = this.now().getTime();
        this.wellnessRefresh = null;
      }
    })();
    return this.wellnessRefresh;
  }

  /**
   * 跑後回報可以選的紀錄：今天、昨天、前天還沒回報體感的跑步，新的在前。
   * 合併 Intervals.icu 上的活動與已同步的紀錄；連不上活動來源時只列已同步的，並附上錯誤訊息。
   */
  async reportCandidates(): Promise<{ candidates: ReportCandidate[]; fetchError: string | null }> {
    let fetched: Activity[] = [];
    let fetchError: string | null = null;
    try {
      fetched = await this.runtime.activities.fetchActivities(REPORT_LOOKBACK_DAYS);
    } catch (e) {
      fetchError = e instanceof Error ? e.message : String(e);
    }
    const saved = await this.db.getRecentWorkouts(REPORT_LOOKBACK_DAYS);
    const byIntervalsId = new Map(saved.filter((w) => w.intervals_id).map((w) => [w.intervals_id!, w]));

    const candidates: ReportCandidate[] = [];
    const listed = new Set<number>();
    for (const activity of fetched) {
      const local = activity.intervals_id ? byIntervalsId.get(activity.intervals_id) : undefined;
      if (local) listed.add(local.id);
      if (local?.perceived_effort != null) continue;
      if (!local && !activity.intervals_id) continue;
      if (!local) {
        // 已存過、但併進別筆的（重複的那筆），或還沒同步、但和已存的某一筆是同一趟：不另外列出
        const stored = await this.db.getWorkoutByIntervalsId(activity.intervals_id!);
        if (stored?.duplicate_of != null) continue;
        if (!stored && saved.some((w) => sameRun(w, activity))) continue;
      }
      candidates.push({
        target: local ? { kind: "saved", workoutId: local.id } : { kind: "new", intervalsId: activity.intervals_id! },
        activity,
        startTime: startTimeOf(activity.raw_json),
        sport: "run",
      });
    }
    // 已同步、但這次沒從來源拿到的（例如連不上 Intervals.icu）
    for (const w of saved) {
      if (listed.has(w.id) || w.perceived_effort != null) continue;
      candidates.push({ target: { kind: "saved", workoutId: w.id }, activity: workoutAsActivity(w), startTime: startTimeOf(w.raw_json), sport: "run" });
    }
    // 多運動：已同步、還沒回報的騎車等其他運動（肌力訓練用課表頁的「做完了」）
    if (featureOn(this.runtime.settings, "multisport")) {
      for (const a of await this.db.getOtherActivities(REPORT_LOOKBACK_DAYS)) {
        const sport = sportOfType(a.type);
        if (a.perceived_effort != null || sport === "strength") continue;
        candidates.push({ target: { kind: "other", intervalsId: a.intervals_id }, activity: otherAsActivity(a), startTime: startTimeOf(a.raw_json), sport });
      }
    }
    candidates.sort(
      (a, b) => b.activity.date.localeCompare(a.activity.date) || (b.startTime ?? "").localeCompare(a.startTime ?? ""),
    );
    return { candidates, fetchError };
  }

  /**
   * 跑後回報（有表單介面的外殼使用）：不經過模型的工具迴圈，直接存檔並生成摘要。
   * 指定 target 時存到那一筆（reportCandidates 列出的）或暫存；
   * 未指定時沿用舊的行為：今天有活動就存到最新的一筆，否則暫存為今天的回報，等同步時合併。
   */
  async reportRun(perceivedEffort: number, subjectiveNotes: string, target?: ReportTarget): Promise<RunReport> {
    const { llm, activities } = this.runtime;
    const today = this.today();
    if (target?.kind === "other") {
      const found = await this.db.getOtherActivity(target.intervalsId);
      if (!found) throw new Error("找不到這筆活動，可能已在 Intervals.icu 刪除。請重新整理後再選一次。");
      await this.db.setActivityFeedback(target.intervalsId, perceivedEffort, subjectiveNotes.trim() || null);
      // 騎車：和跑步一樣，存了體感就產生分析（失敗時體感照樣存著）
      const summary = await this.analyzeRide(target.intervalsId).catch((e) => {
        this.logger.warn(`Ride summary failed for ${target.intervalsId}: ${String(e)}`);
        return null;
      });
      return { status: "other", activity: (await this.db.getOtherActivity(target.intervalsId))!, summary };
    }
    if (target?.kind === "saved") {
      const { workout, summary } = await this.addSubjective(target.workoutId, perceivedEffort, subjectiveNotes);
      return { status: "saved", activity: workoutAsActivity(workout), workoutId: workout.id, summary };
    }
    if (target?.kind === "pending") {
      // 同一天只留一筆暫存，重送時以新的為準
      const previous = await this.db.getPendingSubjectiveByDate(today);
      if (previous) await this.db.deletePendingSubjective(previous.id);
      await this.db.savePendingSubjective(today, perceivedEffort, subjectiveNotes);
      return { status: "pending", date: today, latest: null };
    }

    let latest: Activity | null;
    if (target?.kind === "new") {
      latest = (await activities.fetchActivities(REPORT_LOOKBACK_DAYS)).find((a) => a.intervals_id === target.intervalsId) ?? null;
      if (!latest) throw new Error("找不到這筆活動，可能已在 Intervals.icu 刪除。請重新整理後再選一次。");
    } else {
      latest = await activities.fetchLatestActivity();
      if (!latest || latest.date !== today) {
        await this.db.savePendingSubjective(today, perceivedEffort, subjectiveNotes);
        return { status: "pending", date: today, latest };
      }
    }

    const saved = await this.db.saveWorkoutChecked(latest, perceivedEffort, subjectiveNotes || null);
    if (saved.status === "duplicate") {
      // 和已存的一筆是同一趟：體感存到保留的那筆並重新分析
      const { workout, summary } = await this.addSubjective(saved.id, perceivedEffort, subjectiveNotes);
      return { status: "saved", activity: workoutAsActivity(workout), workoutId: workout.id, summary };
    }
    const workoutId = saved.id;
    let summary: string | null = null;
    try {
      summary = await generateWorkoutSummary(llm, {
        ...latest,
        perceived_effort: perceivedEffort,
        subjective_notes: subjectiveNotes,
        recovery: await recoveryNoteFor(this.db, latest.date),
        plan: await planNoteFor(this.db, this.today(), workoutId),
        weather: await runWeatherNote(this.runtime.weather, latest),
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
        plan: await planNoteFor(this.db, this.today(), workoutId),
        weather: await runWeatherNote(this.runtime.weather, existing),
      });
      await this.db.saveWorkoutSummary(workoutId, summary);
    } catch (e) {
      this.logger.warn(`Summary generation failed for workout_id=${workoutId}: ${String(e)}`);
    }
    return { workout: (await this.db.getWorkout(workoutId))!, summary };
  }

  /**
   * 手動新增一筆跑步（規格 12.36「沒有手錶也能用」）：存檔後和跑後回報一樣產生分析（同一個出口：跑後摘要的模型）.
   * 分析失敗時紀錄照樣存著，summary 為 null
   */
  async addManualWorkout(input: ManualWorkoutInput): Promise<{ workout: Workout; summary: string | null }> {
    const clean = checkManualWorkout(input, this.today());
    const id = await this.db.addManualWorkout(clean);
    return this.addSubjective(id, clean.perceived_effort, clean.subjective_notes ?? "");
  }

  /** 改手動新增的那一筆，並重新分析 */
  async updateManualWorkout(id: number, input: ManualWorkoutInput): Promise<{ workout: Workout; summary: string | null }> {
    const clean = checkManualWorkout(input, this.today());
    if (!(await this.db.updateManualWorkout(id, clean))) throw new Error("只能改手動新增的紀錄");
    return this.addSubjective(id, clean.perceived_effort, clean.subjective_notes ?? "");
  }

  /** 刪掉手動新增的那一筆 */
  async deleteManualWorkout(id: number): Promise<void> {
    if (!(await this.db.deleteManualWorkout(id))) throw new Error("只能刪除手動新增的紀錄");
  }

  /** 手動合併：dupId 是 keepId 的重複（教練動態問「是不是同一趟」時選了合併） */
  async mergeWorkouts(keepId: number, dupId: number): Promise<void> {
    if (keepId === dupId) throw new Error("不能和自己合併");
    for (const id of [keepId, dupId]) {
      if (!(await this.db.getWorkout(id))) throw new Error(`找不到這筆訓練紀錄（id=${id}）`);
    }
    await this.db.mergeWorkouts(keepId, dupId);
  }

  /** 「不是同一趟」：拆開併進這筆的紀錄，之後不再合併；回傳拆開的筆數 */
  splitDuplicates(workoutId: number): Promise<number> {
    return this.db.splitDuplicates(workoutId);
  }

  /** 「不是同一趟」：教練動態不再詢問這兩筆 */
  markDistinct(a: number, b: number): Promise<void> {
    return this.db.markDistinct(a, b);
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
  async feed(): Promise<FeedItem[]> {
    const [weather, raceWeather] = await Promise.all([this.weatherForecast(), this.raceForecasts()]);
    return buildFeed(this.db, this.today(), this.settings, weather, raceWeather);
  }

  /**
   * 看板的「比賽日的天氣」（規格 12.31）：賽前三天內、有地點的賽事的逐時預報（race id → 逐時）；
   * 取不到的略過（最多等 WEATHER_WAIT_MS），不丟錯
   */
  private async raceForecasts(): Promise<Map<number, WeatherHour[]>> {
    const out = new Map<number, WeatherHour[]>();
    const source = this.runtime.raceWeather;
    if (!source) return out;
    const races = (await this.db.getUpcomingRaces(RACE_WEATHER_FEED_DAYS)).filter((r) => racePlaceOf(r) !== null);
    await Promise.all(
      races.map(async (race) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const hours = await Promise.race([
            source.forecast(racePlaceOf(race)!),
            new Promise<null>((resolve) => {
              timer = setTimeout(() => resolve(null), WEATHER_WAIT_MS);
            }),
          ]);
          if (hours) out.set(race.id, hours);
        } catch (e) {
          this.logger.warn(`Race weather fetch failed: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          clearTimeout(timer);
        }
      }),
    );
    return out;
  }

  /** 啟用中的課表，目標依現在的訓練數值換算（網頁版的計畫頁） */
  activePlan(): Promise<ActivePlan | null> {
    return activePlan(this.db, this.today());
  }

  /** 已經排好、還沒開始的下週課表 */
  nextPlan(): Promise<ActivePlan | null> {
    return nextPlan(this.db, this.today());
  }

  /** 課表頁的「之前的週」（規格 12.34）：新的在前，先列 limit 週 */
  pastPlanWeeks(limit?: number): Promise<{ weeks: PastWeek[]; more: boolean }> {
    return pastPlanWeeks(this.db, this.today(), { limit, multisport: featureOn(this.settings, "multisport") });
  }

  /** 最近 N 天的跑步卡片（紀錄頁、跑後回報的結果），新的在前 */
  runCards(days = 30): Promise<RunCard[]> {
    return runCards(this.db, this.today(), days);
  }

  /** 紀錄頁頁首的累積（只增不減） */
  /** 最近 N 天的騎車卡片（多運動） */
  /**
   * 騎車的分析（多運動，規格 12.31）：產生並存下一趟騎車的分析；不是騎車或開關關著時回傳 null.
   * 用跑後摘要的模型
   */
  async analyzeRide(intervalsId: string): Promise<string | null> {
    if (!featureOn(this.settings, "multisport")) return null;
    const a = await this.db.getOtherActivity(intervalsId);
    if (!a) throw new Error("找不到這筆活動，可能已在 Intervals.icu 刪除。");
    if (sportOfType(a.type) !== "ride") return null;
    return analyzeRide({ db: this.db, llm: this.runtime.llm, weather: this.runtime.weather, today: this.today() }, intervalsId);
  }

  /** 最近幾週每週跑步與騎車的量（紀錄頁的騎車週趨勢，多運動） */
  weeklyVolume(weeks = 10): Promise<WeekVolume[]> {
    return weeklyVolumeOf(this.db, this.today(), weeks);
  }

  rideCards(days = 30): Promise<RideCard[]> {
    return rideCards(this.db, this.today(), days);
  }

  /** 騎車的累積（多運動） */
  rideAccumulation(): Promise<RideAccumulation> {
    return rideAccumulation(this.db, this.today());
  }

  accumulation(): Promise<Accumulation> {
    return accumulation(this.db, this.today(), this.settings.timeZone);
  }

  /** 選手在計畫頁調整一堂課：移到別天、跳過、改用替代、恢復；回傳結果（含調整後的檢查） */
  changeSession(id: number, action: SessionAction, options: { date?: string | null; reason?: string } = {}): Promise<string> {
    return changeSession(this.db, this.today(), id, action, { ...options, multisport: featureOn(this.settings, "multisport") });
  }

  /** 選手自己改短或換成輕鬆（規格 12.34 第 3 點 B） */
  selfChangeSession(id: number, request: SelfChangeRequest): Promise<string> {
    return selfChangeSession(this.db, this.today(), id, request, { multisport: featureOn(this.settings, "multisport") });
  }

  /** 自己改課的原因；null 是取消 */
  selfChangeReason(id: number, reason: SelfChangeReason | null): Promise<SelfChange> {
    return selfChangeReason(this.db, id, reason);
  }

  // ---------------------------------------------------------------------------
  // 賽事（規則見 races.ts，和教練的工具一樣）
  // ---------------------------------------------------------------------------

  /** 修改賽事；賽後只能改名稱與備註 */
  editRace(id: number, fields: RaceUpdate): Promise<Race> {
    return editRace(this.db, this.today(), id, fields);
  }

  /** 記錄或修改成績：完賽或沒有完賽 */
  recordRaceResult(id: number, result: Parameters<typeof recordRaceResult>[3]): Promise<Race> {
    return recordRaceResult(this.db, this.today(), id, result);
  }

  /** 不參加了／沒有出賽 */
  markRaceNotStarted(id: number, reason: string, note?: string): Promise<Race> {
    return markRaceNotStarted(this.db, id, reason, note);
  }

  /** 比賽當天的手錶紀錄（記錄成績時的提示） */
  async raceActivity(id: number): Promise<{ time: string; distanceKm: number | null } | null> {
    const race = await this.db.getRace(id);
    return race ? raceActivity(this.db, race) : null;
  }

  /** 只有選手能刪除賽事（網頁版的按鈕）；教練的工具沒有刪除 */
  deleteRace(id: number): Promise<boolean> {
    return this.db.deleteRace(id);
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
        start_time: race.start_time ?? null,
        ...placeFields(race.place ?? null, race.place?.label),
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
