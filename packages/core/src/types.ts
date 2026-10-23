/** 核心對外的介面與資料型別 — 核心不直接碰平台，由各外殼提供實作. */

export type SqlValue = string | number | null;
export type Row = Record<string, SqlValue>;

/** 儲存驅動：只負責執行 SQL。交易與序列化由核心的 Db 處理. */
export interface SqlDriver {
  /** 執行一或多個不帶參數的敘述 */
  exec(sql: string): Promise<void>;
  run(sql: string, params?: SqlValue[]): Promise<{ lastInsertRowid: number; changes: number }>;
  all(sql: string, params?: SqlValue[]): Promise<Row[]>;
}

export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** 正規化後的活動資料（系統統一口徑） */
export interface Activity {
  intervals_id?: string | null;
  strava_id?: string | null;
  source?: string;
  date: string;
  type: string;
  distance_km: number | null;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace: string | null;
  elevation_m: number | null;
  calories: number | null;
  training_load: number | null;
  raw_json: string | null;
}

/** 活動來源（Intervals.icu、之後的健康 App） */
export interface ActivitySource {
  fetchLatestActivity(): Promise<Activity | null>;
  fetchActivities(days: number): Promise<Activity[]>;
  /** 最近 N 天的恢復資料（手錶經 Intervals.icu 提供）；不支援的來源不實作 */
  fetchWellness?(days: number): Promise<WellnessDay[]>;
  /** 最近 N 天跑步以外的活動類型（例如 Walk、Ride），同步不到跑步時用來說明；不支援的來源不實作 */
  fetchOtherActivityTypes?(days: number): Promise<string[]>;
  /**
   * 一段期間（含頭尾的日期）的跑步，匯入完整歷史用；unavailable 是來源列出、但不提供內容的活動數
   * （Intervals.icu 不經 API 提供從 Strava 匯入的活動）。不支援的來源不實作
   */
  fetchRunsBetween?(oldest: string, newest: string): Promise<{ runs: Activity[]; unavailable: number }>;
  /** 最近 N 天跑步以外的運動（騎車、游泳、肌力訓練等），教練排課與判斷疲勞時參考；不支援的來源不實作 */
  fetchOtherActivities?(days: number): Promise<OtherActivity[]>;
  /** 跑步的閾值與心率區間（Intervals.icu 的運動設定）；不支援的來源不實作 */
  fetchRunSettings?(): Promise<RunSettings | null>;
  /** 最近 N 天跑步的最佳配速曲線；不支援的來源不實作 */
  fetchPaceCurve?(days: number): Promise<PaceCurveSummary | null>;
}

/** 跑步以外的運動：只記教練用得到的欄位 */
export interface OtherActivity {
  intervals_id: string;
  date: string;
  /** Intervals.icu 的類型，例：Ride、WeightTraining */
  type: string;
  duration_min: number | null;
  distance_km: number | null;
  avg_hr: number | null;
  training_load: number | null;
  raw_json?: string | null;
}

/** 跑步的運動設定，只留教練用得到的欄位；沒設定的是 null */
export interface RunSettings {
  /** 閾值心率 */
  lthr: number | null;
  max_hr: number | null;
  /** 各心率區間的上限，由低到高 */
  hr_zones: number[] | null;
  /** 閾值配速，m/s */
  threshold_pace: number | null;
}

/** 一段期間的最佳配速曲線：臨界速度，以及標準距離的最佳成績 */
export interface PaceCurveSummary {
  days: number;
  /** 臨界速度，m/s；沒有擬合時為 null */
  critical_speed: number | null;
  /** D′，公尺 */
  d_prime: number | null;
  efforts: BestEffort[];
}

export interface BestEffort {
  distance_m: number;
  secs: number;
  /** 來自標為比賽的活動 */
  race: boolean;
  date: string | null;
}

/** 一天的恢復資料；欄位視手錶與設定而定，可能缺 */
export interface WellnessDay {
  date: string;
  resting_hr: number | null;
  /** rMSSD，毫秒（Garmin 等） */
  hrv: number | null;
  /** SDNN，毫秒：Apple「健康」只記錄這種，數值與 rMSSD 不能互相比較 */
  hrv_sdnn: number | null;
  sleep_secs: number | null;
  sleep_score: number | null;
  readiness: number | null;
  raw_json?: string | null;
}

/** 選手每天的身體狀況自評，1–5 分 */
export interface DailyCheckin {
  date: string;
  /** 精神：1 很差 – 5 很好 */
  energy: number;
  /** 痠痛：1 沒有 – 5 很痠 */
  soreness: number;
  /** 睡眠：1 很差 – 5 很好 */
  sleep: number;
  notes: string | null;
}

export interface Race {
  id: number;
  name: string;
  date: string;
  distance_km: number;
  target_time: string | null;
  confirmed: number;
  result_time: string | null;
  notes: string | null;
  cancelled: number;
  created_at: string;
}

export interface Workout {
  id: number;
  intervals_id: string | null;
  strava_id: string | null;
  date: string;
  type: string;
  distance_km: number | null;
  duration_min: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  avg_pace: string | null;
  elevation_m: number | null;
  calories: number | null;
  training_load: number | null;
  perceived_effort: number | null;
  subjective_notes: string | null;
  source: string | null;
  synced_at: string;
  /** 活動來源的原始資料（JSON） */
  raw_json?: string | null;
  /** 和另一筆是同一趟時，保留的那筆的 id（不在列表上） */
  duplicate_of?: number | null;
  /** 在 Intervals.icu 已刪除或類型不再是跑步的時間（不在列表上） */
  removed_at?: string | null;
  /** getRecentWorkouts：併進這筆的重複紀錄數 */
  duplicate_count?: number;
  /** LEFT JOIN workout_summaries */
  summary?: string | null;
}

export interface TrainingPlan {
  id: number;
  week_label: string;
  content: string;
  created_at: string;
  is_active: number;
  /** 結構化的課表才有（schema 7）；舊的文字課表是 null */
  week_start?: string | null;
  style?: "fixed" | "flexible" | null;
  /** 這次排或改課表的原因 */
  reason?: string | null;
  /** 往後幾週的週期大綱 */
  outline?: string | null;
  /** 檢查器的提醒與教練寫的理由 */
  notes?: string | null;
}

export interface ConversationRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** 傳送時間（UTC，例：2026-10-10T03:06:37Z） */
  timestamp?: string;
  /** 教練回覆前讀過的資料（getRecentConversations 才有） */
  sources?: string[];
  /** 已整理進對話摘要：畫面上還看得到，教練不再直接帶入 */
  archived?: boolean;
  /** 選手回覆的是哪一則 */
  reply_to?: ReplyRef | null;
}

/** 回覆的訊息：存下當時的摘錄，跨裝置也對得上（各台的 id 不同） */
export interface ReplyRef {
  role: "user" | "assistant";
  /** 被回覆那則的傳送時間 */
  timestamp: string;
  /** 被回覆那則的前段文字 */
  text: string;
}

/** 記住的事：每次對話都帶給教練，選手看得到、改得了 */
export interface Memory {
  id: number;
  content: string;
  /** 誰記的 */
  source: "user" | "coach";
  created_at: string;
  updated_at: string;
}

export interface SummaryRow {
  id: number;
  content: string;
  covers_up_to_id: number | null;
  created_at: string;
}

export interface PendingSubjective {
  id: number;
  date: string;
  perceived_effort: number | null;
  subjective_notes: string | null;
  created_at: string;
}

export interface CoachSettings {
  /** IANA 時區，例：Asia/Taipei */
  timeZone: string;
  /** 教練在哪裡回覆：網頁版或 Discord bot（功能說明與操作方式不同） */
  shell: "web" | "discord";
  conversationMax: number;
  conversationKeep: number;
  conversationMsgMaxChars: number;
  /** 最新的幾則對話（含剛送出的訊息）完整帶入，不受 conversationMsgMaxChars 限制 */
  conversationFullRecent: number;
  raceLookaheadDays: number;
  /** 已結束但尚未記錄成績的賽事，保留在賽事清單中的天數 */
  raceLookbackDays: number;
  toolCallMaxRounds: number;
  /** 輸出上限含思考 token */
  maxResponseTokens: number;
}

export const DEFAULT_SETTINGS: CoachSettings = {
  timeZone: "Asia/Taipei",
  shell: "discord",
  conversationMax: 20,
  conversationKeep: 10,
  conversationMsgMaxChars: 600,
  conversationFullRecent: 3,
  raceLookaheadDays: 90,
  raceLookbackDays: 14,
  toolCallMaxRounds: 5,
  maxResponseTokens: 16000,
};
