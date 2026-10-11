/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 訂閱代理的預設網址 */
  readonly VITE_PROXY_URL?: string;
  /** 開發用：把 Intervals.icu 指向本機的模擬服務 */
  readonly VITE_INTERVALS_BASE_URL?: string;
}
