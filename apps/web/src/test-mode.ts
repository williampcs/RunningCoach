/**
 * 測試模式：用假的跑步紀錄測試教練在各種情況下的反應.
 *
 * - 使用另一個資料庫檔案，正式的對話與訓練紀錄不受影響
 * - 活動來源換成假資料，不連線 Intervals.icu（App 本來就只讀取 Intervals.icu，不會寫入）
 * - 可以模擬「今天」的日期；LLM 照常使用使用者的設定
 */
import { daysBetween, generateActivities, localDate, type Activity, type FakeSpec } from "@running-coach/core";

const KEY = "running-coach.test-mode.v1";
export const TEST_DB_FILE = "/coach-test.db";

export interface TestMode {
  enabled: boolean;
  /** 最近一次產生資料的設定；null 表示還沒產生 */
  spec: FakeSpec | null;
  /** 手動新增的單筆紀錄 */
  custom: Activity[];
  /** 模擬的今天（YYYY-MM-DD）；null 表示用實際日期 */
  today: string | null;
}

const OFF: TestMode = { enabled: false, spec: null, custom: [], today: null };

export function loadTestMode(): TestMode {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TestMode> | null;
    return stored ? { ...OFF, ...stored, custom: stored.custom ?? [] } : OFF;
  } catch {
    return OFF;
  }
}

export function saveTestMode(state: TestMode): void {
  localStorage.setItem(KEY, JSON.stringify(state));
}

/** 測試模式下活動來源的內容：產生的情境，加上手動新增的單筆 */
export function testActivities(state: TestMode): Activity[] {
  return [...(state.spec ? generateActivities(state.spec) : []), ...state.custom];
}

/** 模擬日期與實際日期相差的毫秒數；保留實際的時刻，只移動日期 */
export function clockOffsetMs(state: TestMode, timeZone: string): number {
  if (!state.enabled || !state.today) return 0;
  return daysBetween(localDate(new Date(), timeZone), state.today) * 86_400_000;
}
