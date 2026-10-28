import { createContext, useContext } from "react";

import type { Coach } from "@running-coach/core";

import type { BrowserDb } from "./db/driver";
import type { DeviceSyncState } from "./device-sync";
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
  /** 切到分頁（關閉面板），或打開說明、設定的面板（底下的分頁不變） */
  goTo(target: Tab | Panel, draft?: string): void;
  /** 前往跑後回報；指定 workoutId 時預先選好那一筆 */
  /** 前往跑後回報並預先選好：跑步是 workout id，騎車等其他運動是 intervals_id（多運動） */
  openReport(target?: number | string): void;
  /** 多裝置同步（規格 12.10） */
  deviceSync: DeviceSyncState;
  /** 從配對連結（#pair=配對碼）打開時的配對碼；設定頁的同步區塊用完後清掉 */
  pairFromLink: string | null;
  clearPairFromLink(): void;
  /** 「新裝置加入」的提醒點了查看時遞增：設定頁的同步區塊捲到畫面上（規格 12.27） */
  devicesFocus: number;
  showDevices(): void;
  /** 打開設定，直接到某一項（設定的第一層是清單，點進去才是欄位，規格 12.28） */
  openSettings(section?: SettingsSection): void;
  /** 畫面下方的小提示（存好了、同步完成），三秒後消失 */
  toast(text: string): void;
}

/** 設定的各項（第一層清單的每一列） */
export type SettingsSection = "ai" | "records" | "weather" | "sync" | "lock" | "data" | "testmode" | "reset" | "status";

export type Tab = "chat" | "report" | "history" | "plan" | "profile";
/** 蓋在目前畫面上的面板（規格 12.17）：關閉後回到打開前的樣子 */
export type Panel = "help" | "settings";

export const AppContext = createContext<AppState | null>(null);

export function useApp(): AppState {
  const state = useContext(AppContext);
  if (!state) throw new Error("AppContext 尚未提供");
  return state;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
