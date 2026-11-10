/** 模型對照＋高風險問題的測試（規格 12.43）：情境、模型設定與結果的型別. */
import type { Effort, FakeSpec } from "../../packages/core/src";

/** 一個模型設定：模型、思考強度，或關掉思考（和免費試用的代理一樣） */
export interface ModelConfig {
  /** 報告與 --models 用的短名稱 */
  id: string;
  label: string;
  model: string;
  effort: Effort;
  /** 關掉思考：thinking disabled、不送思考強度（只有 Haiku 5.5 可以） */
  disableThinking?: boolean;
}

/** 情境開始前要放進資料庫的課表的一堂（日期用「今天往後幾天」表示，跑的那天決定） */
export interface SeedSession {
  /** 今天往後幾天（負的是過去） */
  day: number;
  kind: string;
  title: string;
  steps: unknown[];
}

export interface SeedInjury {
  area: string;
  side?: "left" | "right" | "both" | "none";
  /** 今天往前幾天開始 */
  startedDaysAgo: number;
  /** 今天往前幾天、幾分 */
  scores: { daysAgo: number; score: number; when: "during" | "after" | "morning" | "rest" | "checkin" }[];
  notes?: string;
}

/** 情境的選手設定（全部是假的資料） */
export interface Athlete {
  /** 假活動的產生設定（endDate 由跑的那天決定）；null 表示幾乎沒有在跑 */
  fake: Omit<FakeSpec, "endDate"> | null;
  /** 只留下這些星期的活動（星期一 = 0），例：模擬每週三都沒跑 */
  keepWeekdays?: number[];
  /** 另外加的活動（今天往前幾天） */
  extraRuns?: { daysAgo: number; distanceKm: number; durationMin: number; avgHr: number | null; maxHr?: number | null }[];
  profile?: Record<string, string>;
  races?: { name: string; daysAhead: number; distanceKm: number; targetTime?: string }[];
  /** 這週（或下週）已經排好的課 */
  plan?: SeedSession[];
  /** 過去幾週的課表（每週一份，weeksAgo 週前的星期一起算） */
  pastPlans?: { weeksAgo: number; sessions: { weekday: number; kind: string; title: string; steps: unknown[] }[] }[];
  injuries?: SeedInjury[];
  memories?: string[];
}

/** 一次執行後看得到的東西（自動檢查用） */
export interface RunRecord {
  scenario: string;
  model: string;
  reply: string;
  /** ok / refused / truncated / stopped / error */
  finish: string;
  error: string | null;
  toolCalls: ToolCallRecord[];
  saved: SavedChanges;
  /** 程式在選手的訊息裡偵測到的紅旗（畫面上的就醫提示） */
  redFlags: string[];
  usage: { input: number; cacheRead: number; cacheWrite: number; output: number; apiCalls: number; toolRounds: number };
  costUsd: number | null;
  seconds: number;
}

export interface ToolCallRecord {
  name: string;
  input: Record<string, unknown>;
  result: string;
  /** 工具執行失敗（「執行失敗：」開頭） */
  failed: boolean;
}

export interface SessionSnapshot {
  id: number;
  date: string | null;
  kind: string;
  title: string;
  steps: unknown[];
  /** 粗估的距離（km，以每公里 6 分鐘換算時間） */
  km: number;
}

/** 這次對話寫進資料庫的東西 */
export interface SavedChanges {
  /** 新存的課表的課 */
  newSessions: SessionSnapshot[];
  /** 原本就有、這次被改的課（改了之後的樣子） */
  editedSessions: SessionSnapshot[];
  /** 存課表時用 accept_warnings 保留檢查器的問題 */
  acceptedWarnings: boolean;
  /** 檢查器擋下（尚未儲存）的次數 */
  checkerBlocked: number;
  injuries: { area: string; status: string; scores: number[] }[];
  memories: string[];
  profile: Record<string, string>;
  races: string[];
}

export interface CheckResult {
  id: string;
  label: string;
  pass: boolean;
  /** 規則比較粗，不過時要人工看 */
  review?: boolean;
  detail?: string;
}

export interface Check {
  id: string;
  label: string;
  review?: boolean;
  test: (r: RunRecord) => boolean | { pass: boolean; detail?: string };
}

export interface Scenario {
  id: string;
  group: "一般" | "高風險";
  title: string;
  athlete: Athlete;
  /** 選手依序送出的訊息（多數只有一則） */
  messages: string[];
  checks: Check[];
  /** 費用估算：預計幾次模型呼叫（工具迴圈） */
  expectedCalls: number;
}

export interface EvalResult extends RunRecord {
  checks: CheckResult[];
}
