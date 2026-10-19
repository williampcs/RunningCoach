import { createContext, useContext } from "react";

import type { Coach } from "@running-coach/core";

import type { BrowserDb } from "./db/driver";
import type { AppSettings } from "./settings";
import type { TestMode } from "./test-mode";

export interface AppState {
  coach: Coach;
  db: BrowserDb;
  settings: AppSettings;
  /** LLM 設定不完整時的說明；完整時為 null */
  llmProblem: string | null;
  /** 啟用密碼鎖時要先加密，所以是非同步的 */
  updateSettings(settings: AppSettings): Promise<void>;
  testMode: TestMode;
  /** 測試模式下改變假資料或模擬日期；啟用或停用時重新載入頁面 */
  updateTestMode(next: TestMode): void;
  /** 有活動來源可以同步：填了 Intervals.icu 的 key，或在測試模式 */
  activitiesReady: boolean;
  /** 資料有變動（對話、同步、匯入）時遞增，各頁據此重新讀取 */
  revision: number;
  touch(): void;
  /** 匯入資料庫後重新初始化 */
  reload(): Promise<void>;
  goTo(tab: Tab, draft?: string): void;
  /** 前往跑後回報；指定 workoutId 時預先選好那一筆 */
  openReport(workoutId?: number): void;
}

export type Tab = "chat" | "report" | "plan" | "profile" | "settings";

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error("AppContext 尚未提供");
  return state;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
