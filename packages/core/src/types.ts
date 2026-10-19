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
}

/** 一天的恢復資料；欄位視手錶與設定而定，可能缺 */
export interface WellnessDay {
  date: string;
  resting_hr: number | null;
  /** rMSSD，毫秒 */
  hrv: number | null;
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
  /** LEFT JOIN workout_summaries */
  summary?: string | null;
}

export interface TrainingPlan {
  id: number;
  week_label: string;
  content: string;
  created_at: string;
  is_active: number;
}

export interface ConversationRow {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** 傳送時間（UTC，例：2026-10-10T03:06:37Z） */
  timestamp?: string;
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
  conversationMax: 20,
  conversationKeep: 10,
  conversationMsgMaxChars: 600,
  conversationFullRecent: 3,
  raceLookaheadDays: 90,
  raceLookbackDays: 14,
  toolCallMaxRounds: 5,
  maxResponseTokens: 16000,
};
