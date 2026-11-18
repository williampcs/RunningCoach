/**
 * 人機驗證（Cloudflare Turnstile，規格 12.10）：建立同步空間與開配對碼之前，網頁版先通過 Turnstile 拿到一次性的 token，
 * 同步服務從 Worker 送到 Turnstile 的 siteverify 確認. 沒有設定 secret 時（本機、模擬服務、E2E）不驗證.
 *
 * 只送 secret 與 token，不送使用者的 IP；不記錄 token.
 */

export const TURNSTILE_VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/** 網頁版放 token 的標頭 */
export const HUMAN_HEADER = "x-turnstile";

export interface TurnstileConfig {
  secret: string;
  /** 測試時可以換掉 */
  fetch?: typeof fetch;
  url?: string;
}

/** ok：通過；missing：沒有 token；failed：驗證沒有通過（過期、用過、錯的）；unavailable：驗證服務連不上或設定錯了 */
export type HumanCheck = "ok" | "missing" | "failed" | "unavailable";

/** Turnstile 的 token 最長 2048 個字 */
const TOKEN = /^[A-Za-z0-9._:-]{1,2048}$/;

export async function verifyTurnstile(config: TurnstileConfig, token: string | null, action: string): Promise<HumanCheck> {
  if (!token) return "missing";
  if (!TOKEN.test(token)) return "failed";
  const fetchImpl = config.fetch ?? ((input, init) => fetch(input, init));
  let result: { success?: unknown; action?: unknown; "error-codes"?: unknown };
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
  // 給別的步驟拿到的 token 不能拿來用（Turnstile 有回 action 時才比）
  if (typeof result.action === "string" && result.action !== "" && result.action !== action) return "failed";
  return "ok";
}
