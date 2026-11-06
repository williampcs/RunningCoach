/**
 * 用 Intervals.icu 登入（規格 12.37，OAuth）：
 * 1. 按「用 Intervals.icu 登入」→ 帶著 client_id、回呼網址（網站的根目錄）、權限範圍與隨機的 state 到 Intervals.icu 同意.
 * 2. Intervals.icu 轉回來時網址帶 ?code=…&state=…：打開 App 時（任何外部請求之前）就從網址清掉，state 對得上才用.
 * 3. 把 code 送到我們的同步服務換成 token（要 client_secret；只轉送、不存，apps/sync/src/intervals-token.ts）.
 * 4. token 和 API key 一樣存在這台的設定（密碼鎖開著時加密），不同步；之後瀏覽器直接帶 Bearer 向 Intervals.icu 讀資料.
 * 中斷連結：呼叫 Intervals.icu 的 disconnect-app，再刪掉這台的 token；呼叫失敗也照樣刪，並請使用者到 Intervals.icu 移除.
 */

/** Intervals.icu 的授權頁（VITE_INTERVALS_OAUTH_URL 只給 E2E 指向模擬上游） */
export const INTERVALS_AUTHORIZE_URL = import.meta.env.VITE_INTERVALS_OAUTH_URL || "https://intervals.icu/oauth/authorize";

/** 只要讀：活動（含串流、配速曲線）、恢復資料、運動設定（閾值、區間） */
export const INTERVALS_SCOPES = "ACTIVITY:READ,WELLNESS:READ,SETTINGS:READ";

const CLIENT_ID = (import.meta.env.VITE_INTERVALS_CLIENT_ID ?? "").trim();
const STATE_KEY = "zone2mate.intervals-login.state";
/** 從哪裡按的登入：回來時打開同一個地方（設定的「訓練紀錄」；精靈本身會從停下的那一步繼續） */
const FROM_KEY = "zone2mate.intervals-login.from";

export type LoginFrom = "wizard" | "settings";

/** 這次建置有設定 client_id，也有同步服務（換 token 的地方）時才能用登入；沒有時照舊用 API key */
export function intervalsLoginConfigured(syncUrl: string): boolean {
  return CLIENT_ID !== "" && syncUrl.trim() !== "";
}

/** 回呼網址：網站的根目錄（要和在 Intervals.icu 登記的一字不差） */
export function redirectUri(): string {
  return `${location.origin}${import.meta.env.BASE_URL}`;
}

function randomState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function authorizeUrl(state: string): string {
  const url = new URL(INTERVALS_AUTHORIZE_URL);
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", INTERVALS_SCOPES);
  url.searchParams.set("state", state);
  return url.toString();
}

/** 到 Intervals.icu 同意 */
export function startIntervalsLogin(from: LoginFrom): void {
  const state = randomState();
  try {
    sessionStorage.setItem(STATE_KEY, state);
    sessionStorage.setItem(FROM_KEY, from);
  } catch {
    // 存不了 state 就換不成 token（回來時對不上），會顯示錯誤
  }
  location.assign(authorizeUrl(state));
}

export type LoginCallback =
  | { kind: "code"; code: string; from: LoginFrom }
  | { kind: "denied"; from: LoginFrom }
  | { kind: "invalid"; from: LoginFrom };

/**
 * 網址上的回呼 → 結果，並把 code 與 state 從網址清掉（不留在歷史紀錄，也不會被之後的請求帶出去）.
 * 不是回呼時回傳 null、不動網址
 */
export function readLoginCallback(loc: { search: string; pathname: string; hash: string } = location): LoginCallback | null {
  const params = new URLSearchParams(loc.search);
  const code = params.get("code");
  const error = params.get("error");
  const state = params.get("state");
  if (!state || (!code && !error)) return null;
  for (const key of ["code", "state", "error", "error_description", "scope"]) params.delete(key);
  const rest = params.toString();
  history.replaceState(history.state, "", `${loc.pathname}${rest ? `?${rest}` : ""}${loc.hash}`);
  let expected: string | null = null;
  let from: LoginFrom = "settings";
  try {
    expected = sessionStorage.getItem(STATE_KEY);
    from = sessionStorage.getItem(FROM_KEY) === "wizard" ? "wizard" : "settings";
    sessionStorage.removeItem(STATE_KEY);
    sessionStorage.removeItem(FROM_KEY);
  } catch {
    // 讀不到就當成對不上
  }
  if (!expected || expected !== state) return { kind: "invalid", from };
  if (error || !code) return { kind: "denied", from };
  return { kind: "code", code, from };
}

/** 打開 App 時讀到的回呼（main.tsx 在任何請求之前讀）；畫面用完後清掉 */
let pending: LoginCallback | null = null;

export function captureLoginCallback(): void {
  if (typeof location === "undefined") return;
  pending = readLoginCallback();
}

export function peekLoginCallback(): LoginCallback | null {
  return pending;
}

export function takeLoginCallback(): LoginCallback | null {
  const value = pending;
  pending = null;
  return value;
}

export interface IntervalsAccount {
  accessToken: string;
  athleteId: string | null;
  athleteName: string | null;
}

export class IntervalsLoginError extends Error {}

const EXCHANGE_ERRORS: Record<string, string> = {
  not_configured: "登入還沒設定好（同步服務沒有 Intervals.icu 的設定），先用 API key 連接。",
  origin: "這個網址不能用登入，先用 API key 連接。",
  invalid_code: "Intervals.icu 的授權過期了，再按一次「用 Intervals.icu 登入」。",
  upstream: "Intervals.icu 暫時連不上，稍後再試。",
};

/** 把 code 送到同步服務換成 token */
export async function exchangeLoginCode(syncUrl: string, code: string, fetchImpl: typeof fetch = fetch): Promise<IntervalsAccount> {
  let response: Response;
  try {
    response = await fetchImpl(`${syncUrl.replace(/\/$/, "")}/v1/intervals/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, redirect_uri: redirectUri() }),
    });
  } catch {
    throw new IntervalsLoginError("連不上換 token 的服務，確認網路後再試一次。");
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    // 下面統一處理
  }
  if (!response.ok || typeof data.access_token !== "string") {
    const key = typeof data.error === "string" ? data.error : "";
    throw new IntervalsLoginError(EXCHANGE_ERRORS[key] ?? "登入沒有成功，再試一次，或先用 API key 連接。");
  }
  return {
    accessToken: data.access_token,
    athleteId: typeof data.athlete_id === "string" ? data.athlete_id : null,
    athleteName: typeof data.athlete_name === "string" ? data.athlete_name : null,
  };
}

/** 請 Intervals.icu 取消這個 App 的授權；成功回 true（失敗時呼叫端照樣刪掉這台的 token） */
export async function disconnectIntervals(accessToken: string, baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/disconnect-app`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    });
    return response.ok;
  } catch {
    return false;
  }
}
