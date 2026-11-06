/**
 * 用 Intervals.icu 登入（規格 12.37，OAuth）的換 token：網頁拿到授權碼（code）後送到這裡，
 * 我們帶上 client_secret 向 Intervals.icu 換成 access token，原樣交回網頁.
 *
 * - 只轉送：不存 token、不存授權碼、不寫任何 log（Worker 也關閉了觀測日誌）；回應不快取.
 * - 只接受允許的網頁來源（和同步服務同一份 ALLOWED_ORIGINS）；授權碼只會送到我們登記的回呼網址，
 *   兩分鐘內有效、只能用一次，所以拿到這個端點也換不到別人的 token.
 * - 錯誤回應只說哪一類（沒有設定、來源不對、授權碼不對、Intervals.icu 連不上），不轉送 Intervals.icu 的原文.
 * - 沒有設定 client_id 與 client_secret 時回 404（網頁的登入按鈕也不會出現）.
 */

/** Intervals.icu 換 token 的網址 */
export const INTERVALS_TOKEN_URL = "https://intervals.icu/api/oauth/token";

export const INTERVALS_TOKEN_PATH = "/v1/intervals/token";

export interface IntervalsTokenDeps {
  clientId?: string;
  clientSecret?: string;
  /** 允許的網頁來源；"*" 表示全部（只給本機開發） */
  allowedOrigins: string[];
  /** 換 token 的網址（模擬上游用） */
  tokenUrl?: string;
  fetch?: typeof fetch;
}

/** 回給網頁的內容 */
export interface IntervalsTokenResult {
  access_token: string;
  athlete_id: string | null;
  athlete_name: string | null;
  scope: string | null;
}

const CODE = /^[A-Za-z0-9._~-]{4,512}$/;
const MAX_BODY = 4096;

/** 這個請求是換 token 的嗎（模擬服務放在 /sync 底下，所以看結尾） */
export function isIntervalsTokenPath(pathname: string): boolean {
  return pathname.endsWith(INTERVALS_TOKEN_PATH);
}

function allowed(origin: string | null, deps: IntervalsTokenDeps): origin is string {
  return !!origin && (deps.allowedOrigins.includes("*") || deps.allowedOrigins.includes(origin));
}

function json(status: number, body: unknown, origin: string | null): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}),
    },
  });
}

/** 回呼網址只能是允許的來源的根目錄（和網頁送去授權時的一樣） */
function redirectOk(value: unknown, origin: string): value is string {
  return typeof value === "string" && value === `${origin}/`;
}

export async function handleIntervalsToken(request: Request, deps: IntervalsTokenDeps): Promise<Response> {
  const origin = request.headers.get("origin");
  const corsOrigin = allowed(origin, deps) ? origin : null;
  if (request.method === "OPTIONS") {
    if (!corsOrigin) return new Response(null, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: {
        "access-control-allow-origin": corsOrigin,
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "86400",
        vary: "Origin",
      },
    });
  }
  if (!deps.clientId || !deps.clientSecret) return json(404, { error: "not_configured" }, corsOrigin);
  if (!corsOrigin) return json(403, { error: "origin" }, null);
  if (request.method !== "POST") return json(405, { error: "method" }, corsOrigin);

  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) return json(413, { error: "too_large" }, corsOrigin);
  const text = await request.text();
  if (text.length > MAX_BODY) return json(413, { error: "too_large" }, corsOrigin);
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return json(400, { error: "invalid_request" }, corsOrigin);
  }
  if (!body || typeof body !== "object" || typeof body.code !== "string" || !CODE.test(body.code)) {
    return json(400, { error: "invalid_request" }, corsOrigin);
  }
  const form = new URLSearchParams({ client_id: deps.clientId, client_secret: deps.clientSecret, code: body.code });
  if (body.redirect_uri !== undefined) {
    if (!redirectOk(body.redirect_uri, corsOrigin)) return json(400, { error: "invalid_request" }, corsOrigin);
    form.set("redirect_uri", body.redirect_uri);
  }

  let response: Response;
  try {
    response = await (deps.fetch ?? fetch)(deps.tokenUrl ?? INTERVALS_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
      body: form.toString(),
    });
  } catch {
    return json(502, { error: "upstream" }, corsOrigin);
  }
  // 4xx：授權碼過期、用過、不是給這個 App 的；其他：Intervals.icu 那邊的問題
  if (!response.ok) return json(response.status >= 400 && response.status < 500 ? 400 : 502, { error: response.status < 500 ? "invalid_code" : "upstream" }, corsOrigin);
  let data: Record<string, unknown>;
  try {
    data = (await response.json()) as Record<string, unknown>;
  } catch {
    return json(502, { error: "upstream" }, corsOrigin);
  }
  if (typeof data.access_token !== "string" || !data.access_token) return json(502, { error: "upstream" }, corsOrigin);
  const athlete = (data.athlete && typeof data.athlete === "object" ? data.athlete : {}) as Record<string, unknown>;
  const result: IntervalsTokenResult = {
    access_token: data.access_token,
    athlete_id: typeof athlete.id === "string" || typeof athlete.id === "number" ? String(athlete.id) : null,
    athlete_name: typeof athlete.name === "string" ? athlete.name : null,
    scope: typeof data.scope === "string" ? data.scope : null,
  };
  return json(200, result, corsOrigin);
}
