/// <reference types="vite/client" />

/** 建置時注入（vite.config.ts）：版本、commit、建置日期 */
declare const __APP_BUILD__: { version: string; commit: string; date: string };

interface ImportMetaEnv {
  /** 訂閱代理的預設網址 */
  readonly VITE_PROXY_URL?: string;
  /** 多裝置同步服務的網址（規格 12.10）；沒有時設定頁顯示「還沒設定」 */
  readonly VITE_SYNC_URL?: string;
  /** 舊網址的建置才有：網頁版搬到的新網址（規格 12.13）；有的話顯示「已搬家」與清除這個網址的資料 */
  readonly VITE_MOVED_TO?: string;
  /** 預覽版的建置才有：顯示「預覽版」，不連同步服務 */
  readonly VITE_PREVIEW?: string;
  /** 開發用：把 Intervals.icu 指向本機的模擬服務 */
  readonly VITE_INTERVALS_BASE_URL?: string;
}
