/**
 * 人機驗證（Cloudflare Turnstile，規格 12.10）：建立同步空間與開配對碼之前，網頁版先通過 Turnstile 拿到一次性的 token，
 * 同步服務從 Worker 送到 Turnstile 的 siteverify 確認. 沒有設定時（本機、模擬服務、E2E）不驗證；
 * 有開但沒有 secret 時一律回「暫時無法使用」，不會默默跳過.
 * 正式的設定（hostnames）：token 要是在這個環境的網頁拿到的（hostname），而且是給這一步的（action 完全相同）.
 *
 * 只送 secret 與 token，不送使用者的 IP；不記錄 token.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 網頁版放 token 的標頭 */
export const HUMAN_HEADER = "x-turnstile";

export interface TurnstileConfig {
  /** 空的表示有開人機驗證、但 secret 沒有設定好：一律 unavailable */
  secret: string;
  /**
   * 這個環境的網頁的主機名稱（正式與 staging 各自只有自己的）. 有給時：siteverify 回的 hostname 要在裡面、action 要完全相同；
   * 給了空的清單時一律 unavailable. 沒給時（本機、模擬服務）只在有回 action 時比對
   */
  hostnames?: string[];
  /** 測試時可以換掉 */
  fetch?: typeof fetch;
  url?: string;
}

/** ok：通過；missing：沒有 token；failed：驗證沒有通過（過期、用過、錯的）；unavailable：驗證服務連不上或設定錯了 */
export type HumanCheck = "ok" | "missing" | "failed" | "unavailable";

/** Turnstile 的 token 最長 2048 個字 */
const TOKEN = /^[A-Za-z0-9._:-]{1,2048}$/;

export async function verifyTurnstile(config: TurnstileConfig, token: string | null, action: string): Promise<HumanCheck> {
  if (!config.secret) return "unavailable";
  if (config.hostnames && config.hostnames.length === 0) return "unavailable";
  if (!token) return "missing";
  if (!TOKEN.test(token)) return "failed";
  const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  let result: { success?: unknown; action?: unknown; hostname?: unknown; "error-codes"?: unknown };
  try {
    const response = await fetchImpl(config.url ?? TURNSTILE_VERIFY_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: config.secret, response: token }).toString(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return "unavailable";
    result = (await response.json()) as typeof result;
  } catch {
    return "unavailable";
  }
  const codes = Array.isArray(result["error-codes"]) ? result["error-codes"].map(String) : [];
  // secret 沒設定好：不是使用者的問題
  if (codes.some((c) => c.includes("secret"))) return "unavailable";
  if (result.success !== true) return "failed";
  if (config.hostnames) {
    // 別的網頁（例如另一個環境）拿到的、給別的步驟拿到的 token 都不能用
    if (typeof result.hostname !== "string" || !config.hostnames.includes(result.hostname.toLowerCase())) return "failed";
    if (result.action !== action) return "failed";
    return "ok";
  }
  // 本機與模擬服務：Turnstile 有回 action 時才比
  if (typeof result.action === "string" && result.action !== "" && result.action !== action) return "failed";
  return "ok";
}
