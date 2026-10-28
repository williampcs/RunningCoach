/// <reference types="vite/client" />

/** 建置時注入（vite.config.ts）：版本、commit、建置日期 */
declare const __APP_BUILD__: { version: string; commit: string; date: string };

interface ImportMetaEnv {
  /** 訂閱代理的預設網址 */
  readonly VITE_PROXY_URL?: string;
  /** 多裝置同步服務的網址（規格 12.10）；沒有時設定頁顯示「還沒設定」 */
  readonly VITE_SYNC_URL?: string;
  /** staging 的建置才有（規格 12.19）：標示「Staging」 */
  readonly VITE_STAGING?: string;
  /** 正式的網址（Variables 的 WEB_URL）；從其他網址打開時顯示搬家的提示（規格 12.19） */
  readonly VITE_WEB_URL?: string;
  /** 功能開關（規格 12.25）：逗號分隔的名稱或 all；staging 的建置不論設定都全開 */
  readonly VITE_FEATURES?: string;
  /** 開發用：把 Intervals.icu 指向本機的模擬服務 */
  readonly VITE_INTERVALS_BASE_URL?: string;
  /** 開發用：把 Open-Meteo 指向本機的模擬服務（{base}/v1/forecast…） */
  readonly VITE_WEATHER_BASE_URL?: string;
}
