import { useCallback, useEffect, useState } from "react";

/** 建置時輸出的版本檔（vite.config.ts 的 versionFile），和網頁本身的 BUILD（version.ts）同一次建置 */
export const VERSION_FILE = "version.json";
// 前景時多久讀一次（規格 12.18）
const CHECK_INTERVAL_MS = 30 * 60_000;
const DISMISSED_KEY = "running-coach:update-dismissed";

/**
 * 伺服器上的版本和自己不同時，回傳伺服器上的 commit；相同、讀不到或格式不對都回傳 null（不提示、不報錯）.
 * 不用快取：Cloudflare Pages 也設了 no-store（_headers），這裡再加 cache: "no-store"
 */
export async function newerCommit(current: string, fetcher: typeof fetch = fetch, url = VERSION_FILE): Promise<string | null> {
  try {
    const res = await fetcher(url, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { commit?: unknown };
    const commit = typeof body?.commit === "string" ? body.commit.trim() : "";
    return commit && commit !== current ? commit : null;
  } catch {
    return null;
  }
}

function readDismissed(): string | null {
  try {
    return localStorage.getItem(DISMISSED_KEY);
  } catch {
    return null;
  }
}

/**
 * 有新版本時回傳它的 commit：App 打開時、回到前景時、前景中每 30 分鐘檢查一次.
 * 不自動重新載入（打到一半的字會不見），由使用者點提示；關掉後同一個版本不再提示.
 * 本機開發沒有版本檔（commit 也是 dev），不檢查。current 是網頁本身的 commit（BUILD.commit）
 */
export function useNewVersion(current: string): { commit: string | null; dismiss: () => void } {
  const [latest, setLatest] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(readDismissed);
  useEffect(() => {
    if (import.meta.env.DEV || current === "dev") return;
    let stopped = false;
    const check = () => {
      if (document.visibilityState !== "visible") return;
      void newerCommit(current, fetch, `${import.meta.env.BASE_URL}${VERSION_FILE}`).then((commit) => {
        // 讀不到時保留上次的結果：離線一下不讓提示消失
        if (!stopped && commit) setLatest(commit);
      });
    };
    check();
    document.addEventListener("visibilitychange", check);
    const timer = setInterval(check, CHECK_INTERVAL_MS);
    return () => {
      stopped = true;
      document.removeEventListener("visibilitychange", check);
      clearInterval(timer);
    };
  }, [current]);
  const dismiss = useCallback(() => {
    if (!latest) return;
    try {
      localStorage.setItem(DISMISSED_KEY, latest);
    } catch {
      // 存不了就只在這次開著的期間不提示
    }
    setDismissed(latest);
  }, [latest]);
  return { commit: latest && latest !== dismissed ? latest : null, dismiss };
}

export type StorageProtection = "persisted" | "not-persisted" | "unsupported";

/** 要求瀏覽器不要在空間不足或閒置時自動清掉這個網站的資料（規格 12.18）；不支援就略過 */
export async function requestPersistentStorage(): Promise<void> {
  try {
    if (!navigator.storage?.persist) return;
    if (await navigator.storage.persisted?.()) return;
    await navigator.storage.persist();
  } catch {
    // 不支援或被拒絕都不影響使用
  }
}

/** 設定頁「資料」顯示的狀態 */
export async function storageProtection(): Promise<StorageProtection> {
  try {
    if (!navigator.storage?.persisted) return "unsupported";
    return (await navigator.storage.persisted()) ? "persisted" : "not-persisted";
  } catch {
    return "unsupported";
  }
}
