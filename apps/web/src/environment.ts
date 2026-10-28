import { parseFeatures, type Feature } from "@running-coach/core";

/**
 * 這次建置是哪個環境（規格 12.19）：
 * - staging（`VITE_STAGING`）：`v2` 推上去自動部署，連 staging 自己的同步服務，資料和正式版分開。
 * - 正式版：`VITE_WEB_URL` 是正式的網址；從其他網址（例如舊的 pages.dev）打開時顯示搬家的提示。
 */
export const IS_STAGING = import.meta.env.VITE_STAGING === "1";

/** 開著的功能（規格 12.25）：staging 一律全開；正式版只開 VITE_FEATURES 列出來的（預設全關） */
export const FEATURES_ON: Feature[] = parseFeatures(import.meta.env.VITE_FEATURES, { staging: IS_STAGING });

export const featureEnabled = (feature: Feature) => FEATURES_ON.includes(feature);

/** 正式的網址（只取來源，結尾沒有 /）；沒有設定或格式不對時為 null */
export function canonicalOrigin(webUrl: string | undefined): string | null {
  const value = webUrl?.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.origin : null;
  } catch {
    return null;
  }
}

/** 目前的網址不是正式的網址時，回傳要搬去的網址；staging、沒設定正式網址、已經在正式網址時為 null */
export function movedTo(currentOrigin: string, webUrl: string | undefined, staging: boolean): string | null {
  if (staging) return null;
  const canonical = canonicalOrigin(webUrl);
  if (!canonical || canonical === currentOrigin) return null;
  return canonical;
}

/** 這個網址要搬到哪裡（規格 12.19）：舊網址 running-coach-bgb.pages.dev 和新網址是同一份建置 */
export const MOVED_TO =
  typeof location === "undefined" ? null : movedTo(location.origin, import.meta.env.VITE_WEB_URL, IS_STAGING);
