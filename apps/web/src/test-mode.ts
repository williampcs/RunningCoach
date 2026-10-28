/**
 * 測試模式：用假的跑步紀錄測試教練在各種情況下的反應.
 *
 * - 使用另一個資料庫檔案，正式的對話與訓練紀錄不受影響
 * - 活動來源換成假資料，不連線 Intervals.icu（App 本來就只讀取 Intervals.icu，不會寫入）
 * - 可以模擬「今天」的日期；LLM 照常使用使用者的設定
 */
import {
  daysBetween,
  fakeRunSettings,
  generateActivities,
  generateWellness,
  localDate,
  type Activity,
  type FakeSpec,
  type RunSettings,
  type WellnessDay,
} from "@running-coach/core";

import { featureEnabled } from "./environment";

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

/**
 * 存著的測試模式設定 → 這次用的. 功能開關 testmode 關著（正式版）時一律是關著的：
 * 之前開過測試模式的瀏覽器回到正式的資料庫；存著的設定與測試的資料庫都不刪，開關開回來時還在
 */
export function effectiveTestMode(stored: Partial<TestMode> | null, available: boolean): TestMode {
  if (!stored || !available) return OFF;
  return { ...OFF, ...stored, custom: stored.custom ?? [] };
}

export function loadTestMode(available = featureEnabled("testmode")): TestMode {
  try {
    return effectiveTestMode(JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<TestMode> | null, available);
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

/** 測試模式下的恢復資料：隨情境產生 */
export function testWellness(state: TestMode): WellnessDay[] {
  return state.spec ? generateWellness(state.spec) : [];
}

/** 測試模式下的跑步設定（閾值心率與區間）：隨裝置產生 */
export function testRunSettings(state: TestMode): RunSettings | null {
  return state.spec ? fakeRunSettings(state.spec) : null;
}

/** 模擬日期與實際日期相差的毫秒數；保留實際的時刻，只移動日期 */
export function clockOffsetMs(state: TestMode, timeZone: string): number {
  if (!state.enabled || !state.today) return 0;
  return daysBetween(localDate(new Date(), timeZone), state.today) * 86_400_000;
}
