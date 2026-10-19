/// <reference types="vite/client" />

/** 建置時注入（vite.config.ts）：版本、commit、建置日期 */
declare const __APP_BUILD__: { version: string; commit: string; date: string };

interface ImportMetaEnv {
  /** 訂閱代理的預設網址 */
  readonly VITE_PROXY_URL?: string;
  /** 開發用：把 Intervals.icu 指向本機的模擬服務 */
  readonly VITE_INTERVALS_BASE_URL?: string;
}
