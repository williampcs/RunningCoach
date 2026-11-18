/**
 * 人機驗證（Cloudflare Turnstile，規格 12.10）：開始同步（建立同步空間）與開配對碼之前顯示，多數情況幾秒內自動通過.
 * site key 在建置時由 VITE_TURNSTILE_SITE_KEY 給（GitHub 的 Variables）；沒有時不顯示，直接進行（本機、模擬服務、E2E）.
 * 通過後拿到的 token 只能用一次，交給同步服務驗證.
 */
import { useEffect, useRef, useState } from "react";

const SITE_KEY = (import.meta.env.VITE_TURNSTILE_SITE_KEY ?? "").trim();
const SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

/** 這個建置有沒有人機驗證 */
export const HUMAN_CHECK_ON = SITE_KEY !== "";

/** 驗證的用途：同步服務會確認 token 是給這一步的 */
export type HumanAction = "create-space" | "pair";

interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/** 載入 Turnstile 的腳本（只載一次）；載不到時下次再試 */
function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_URL;
    script.async = true;
    script.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("no turnstile")));
    script.onerror = () => reject(new Error("load failed"));
    document.head.appendChild(script);
  }).catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

/**
 * 顯示 Turnstile 的方塊；通過時呼叫 onToken（一次）. 失敗、過期時顯示說明與「重試」；取消由外面的按鈕處理
 */
export function HumanCheck({ action, onToken }: { action: HumanAction; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const done = useRef(onToken);
  done.current = onToken;
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    let widget: string | null = null;
    let api: TurnstileApi | null = null;
    setError(null);
    loadTurnstile()
      .then((loaded) => {
        if (!alive || !box.current) return;
        api = loaded;
        widget = loaded.render(box.current, {
          sitekey: SITE_KEY,
          action,
          theme: "auto",
          language: "zh-tw",
          size: "flexible",
          callback: (token: string) => alive && done.current(token),
          "error-callback": () => {
            if (alive) setError("人機驗證沒有完成。請按「重試」；一直不行的話，換個網路或稍後再試。");
            // 交給我們顯示說明，不讓 Turnstile 自己一直重試
            return true;
          },
          "expired-callback": () => alive && setError("人機驗證過期了，請按「重試」。"),
        });
      })
      .catch(() => alive && setError("無法載入人機驗證（可能被瀏覽器的擋廣告功能擋住，或網路不穩）。請按「重試」。"));
    return () => {
      alive = false;
      if (api && widget !== null) {
        try {
          api.remove(widget);
        } catch {
          // 已經移除
        }
      }
    };
  }, [action, attempt]);

  return (
    <div className="human-check">
      <p className="small muted">先確認你不是機器人，通常幾秒內會自動完成。</p>
      <div ref={box} className="human-check-box" />
      {error && (
        <div className="notice error">
          <span>{error}</span>
          <button className="text" onClick={() => setAttempt((n) => n + 1)}>
            重試
          </button>
        </div>
      )}
    </div>
  );
}
