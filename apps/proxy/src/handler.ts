/**
 * 薄代理 — 驗證訂閱、檢查額度、把請求原樣轉給 LLM 供應商、累計用量.
 *
 * 對外介面與 Anthropic Messages API 相容：客戶端只需把 baseURL 指向這裡，
 * 並以代理發給的憑證取代 API key。請求與回應內容只在記憶體中經過，不寫入儲存、不寫入日誌。
 */
import { meterSseStream, usageFromJson } from "./metering";
import { costMicroUsd, usdToMicro, type Policy, type TokenUsage } from "./policy";
import type { Account, AccountStore } from "./store";

export interface ProxyDeps {
  store: AccountStore;
  policy: Policy;
  upstream: { baseUrl: string; apiKey: string };
  /** 管理端點的憑證；未設定時停用 /admin */
  adminToken?: string;
  /** 允許跨來源呼叫的網頁來源；["*"] 表示全部 */
  allowedOrigins: string[];
  fetch?: typeof fetch;
  now?: () => Date;
  /** 平台會在回應送出後中止執行時（Workers），用來延長背景寫入的存活時間 */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** 只會收到帳號、模型、狀態碼與 token 數，不含任何請求或回應內容 */
  log?: (line: string) => void;
}

// 允許轉發的請求欄位。其餘欄位（加價的 speed、service_tier、container 等）一律拒絕
const ALLOWED_FIELDS = new Set([
  "model",
  "max_tokens",
  "system",
  "messages",
  "tools",
  "tool_choice",
  "output_config",
  "thinking",
  "cache_control",
  "stop_sequences",
  "stream",
]);

const PASS_RESPONSE_HEADERS = ["content-type", "request-id", "retry-after"];

type Json = Record<string, unknown>;

function errorResponse(status: number, type: string, message: string, headers?: HeadersInit): Response {
  return Response.json({ type: "error", error: { type, message } }, { status, headers });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

function presentedToken(request: Request): string | null {
  const apiKey = request.headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1]?.trim() || null;
}

/** 回傳拒絕原因；通過時回傳 null */
function validateBody(body: Json, policy: Policy): string | null {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return `不支援的欄位：${key}`;
  }
  if (typeof body.model !== "string" || !(body.model in policy.models)) {
    return `不支援的模型：${String(body.model)}（可用：${Object.keys(policy.models).join("、")}）`;
  }
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return "max_tokens 必須是正整數";
  }
  if (body.max_tokens > policy.maxOutputTokens) {
    return `max_tokens 超過上限 ${policy.maxOutputTokens}`;
  }
  if (!Array.isArray(body.messages)) return "messages 必須是陣列";
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools 必須是陣列";
    for (const tool of body.tools as Json[]) {
      // 只接受客戶端自行執行的工具；伺服器端工具（網頁搜尋、程式執行等）另外計費
      if (tool?.type !== undefined && tool.type !== "custom") return `不支援的工具類型：${String(tool.type)}`;
    }
  }
  return null;
}

export function createProxy(deps: ProxyDeps): (request: Request) => Promise<Response> {
  const { store, policy } = deps;
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const upstreamUrl = `${deps.upstream.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  // 每分鐘請求數：以執行個體的記憶體計數，屬盡力而為；多個體部署時應改用平台的限流機制
  const windows = new Map<string, { minute: number; count: number }>();
  function overRateLimit(accountId: string): boolean {
    const minute = Math.floor(now().getTime() / 60_000);
    const window = windows.get(accountId);
    if (!window || window.minute !== minute) {
      windows.set(accountId, { minute, count: 1 });
      return false;
    }
    window.count += 1;
    return window.count > policy.requestsPerMinute;
  }

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (!deps.allowedOrigins.includes("*") && !deps.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-expose-headers": "request-id, retry-after",
      vary: "Origin",
    };
  }

  const period = () => now().toISOString().slice(0, 7);
  const budgetOf = (account: Account) =>
    account.monthlyBudgetMicroUsd ?? usdToMicro(policy.defaultMonthlyBudgetUsd);

  async function authenticate(request: Request): Promise<Account | Response> {
    const token = presentedToken(request);
    if (!token) return errorResponse(401, "authentication_error", "缺少訂閱憑證");
    const account = await store.findByTokenHash(await sha256Hex(token));
    if (!account) return errorResponse(401, "authentication_error", "訂閱憑證無效");
    if (account.status !== "active") return errorResponse(403, "permission_error", "訂閱已停用");
    return account;
  }

  async function handleMessages(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    if (overRateLimit(account.id)) {
      return errorResponse(429, "rate_limit_error", "請求太頻繁，請稍後再試", { "retry-after": "30" });
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).length > policy.maxBodyBytes) {
      return errorResponse(413, "request_too_large", "請求內容過大");
    }
    let body: Json;
    try {
      body = JSON.parse(raw) as Json;
    } catch {
      return errorResponse(400, "invalid_request_error", "請求內容不是有效的 JSON");
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return errorResponse(400, "invalid_request_error", "請求內容必須是 JSON 物件");
    }
    const rejection = validateBody(body, policy);
    if (rejection) return errorResponse(400, "invalid_request_error", rejection);
    const model = body.model as string;

    const currentPeriod = period();
    const used = await store.getUsage(account.id, currentPeriod);
    if (used.costMicroUsd >= budgetOf(account)) {
      return errorResponse(403, "permission_error", "本月額度已用完，下個月會自動恢復");
    }

    const upstream = await fetchImpl(upstreamUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": deps.upstream.apiKey,
        "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    const headers = new Headers();
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    const record = (usage: TokenUsage): Promise<void> => {
      const cost = costMicroUsd(policy.models[model]!, usage);
      log(
        `${account.id} ${model} ${upstream.status} in=${usage.input + usage.cacheRead + usage.cacheWrite}` +
          ` out=${usage.output} cost_microusd=${cost}`,
      );
      const write = store
        .addUsage(account.id, currentPeriod, usage, cost)
        .catch((e) => log(`usage write failed for ${account.id}: ${e instanceof Error ? e.message : String(e)}`));
      deps.waitUntil?.(write);
      return write;
    };

    if (!upstream.ok || !upstream.body) {
      log(`${account.id} ${model} ${upstream.status}`);
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(
        meterSseStream(upstream.body, (usage) => void record(usage)),
        { status: upstream.status, headers },
      );
    }
    const text = await upstream.text();
    await record(usageFromJson(text));
    return new Response(text, { status: upstream.status, headers });
  }

  async function handleUsage(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    const currentPeriod = period();
    const used = await store.getUsage(account.id, currentPeriod);
    return Response.json({
      period: currentPeriod,
      requests: used.requests,
      input_tokens: used.input + used.cacheRead + used.cacheWrite,
      output_tokens: used.output,
      cost_usd: used.costMicroUsd / 1_000_000,
      budget_usd: budgetOf(account) / 1_000_000,
    });
  }

  // ---------------------------------------------------------------------------
  // 管理端點：供帳號與金流服務（不在本 repo）建立帳號、調整狀態與預算
  // ---------------------------------------------------------------------------

  async function issueToken(): Promise<{ token: string; hash: string }> {
    const token = `rc_${randomHex(32)}`;
    return { token, hash: await sha256Hex(token) };
  }

  function budgetInput(value: unknown): number | null | undefined | Response {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
      return errorResponse(400, "invalid_request_error", "monthly_budget_usd 必須是不小於 0 的數字或 null");
    }
    return usdToMicro(value);
  }

  async function accountView(account: Account) {
    const currentPeriod = period();
    const used = await store.getUsage(account.id, currentPeriod);
    return {
      id: account.id,
      status: account.status,
      monthly_budget_usd: budgetOf(account) / 1_000_000,
      usage: { period: currentPeriod, requests: used.requests, cost_usd: used.costMicroUsd / 1_000_000 },
    };
  }

  async function handleAdmin(request: Request, path: string): Promise<Response> {
    if (!deps.adminToken) return errorResponse(404, "not_found_error", "找不到這個端點");
    const presented = presentedToken(request);
    // 比對雜湊，避免逐字元比較洩漏憑證內容
    if (!presented || (await sha256Hex(presented)) !== (await sha256Hex(deps.adminToken))) {
      return errorResponse(401, "authentication_error", "管理憑證無效");
    }

    const input = request.method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Json);
    if (path === "/admin/accounts" && request.method === "POST") {
      const budget = budgetInput(input.monthly_budget_usd);
      if (budget instanceof Response) return budget;
      const id = `acct_${randomHex(8)}`;
      const { token, hash } = await issueToken();
      await store.createAccount(id, hash, budget ?? null);
      // 憑證只在這裡回傳一次，之後只存雜湊
      return Response.json({ id, token }, { status: 201 });
    }

    const match = /^\/admin\/accounts\/([\w-]+)(\/rotate-token)?$/.exec(path);
    if (!match) return errorResponse(404, "not_found_error", "找不到這個端點");
    const id = match[1]!;
    const notFound = () => errorResponse(404, "not_found_error", `找不到帳號 ${id}`);

    if (match[2]) {
      if (request.method !== "POST") return errorResponse(405, "invalid_request_error", "不支援的方法");
      const { token, hash } = await issueToken();
      return (await store.updateAccount(id, { tokenHash: hash })) ? Response.json({ id, token }) : notFound();
    }
    if (request.method === "PATCH") {
      const budget = budgetInput(input.monthly_budget_usd);
      if (budget instanceof Response) return budget;
      if (input.status !== undefined && input.status !== "active" && input.status !== "suspended") {
        return errorResponse(400, "invalid_request_error", "status 必須是 active 或 suspended");
      }
      const exists = await store.updateAccount(id, {
        status: input.status as Account["status"] | undefined,
        monthlyBudgetMicroUsd: budget,
      });
      if (!exists) return notFound();
    } else if (request.method !== "GET") {
      return errorResponse(405, "invalid_request_error", "不支援的方法");
    }
    const account = await store.getAccount(id);
    return account ? Response.json(await accountView(account)) : notFound();
  }

  async function route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname.replace(/\/+$/, "") || "/";
    if (path === "/healthz") return Response.json({ ok: true });
    if (path === "/v1/messages" && request.method === "POST") return handleMessages(request);
    if (path === "/v1/usage" && request.method === "GET") return handleUsage(request);
    if (path.startsWith("/admin/")) return handleAdmin(request, path);
    return errorResponse(404, "not_found_error", "找不到這個端點");
  }

  return async (request) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...cors,
          "access-control-allow-methods": "GET, POST, PATCH, OPTIONS",
          // Anthropic SDK 會帶多個自訂標頭，照瀏覽器要求的清單放行
          "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "",
          "access-control-max-age": "86400",
        },
      });
    }

    let response: Response;
    try {
      response = await route(request);
    } catch (e) {
      log(`unhandled error: ${e instanceof Error ? e.message : String(e)}`);
      response = errorResponse(502, "api_error", "代理發生錯誤，請稍後再試");
    }
    for (const [name, value] of Object.entries(cors)) response.headers.set(name, value);
    return response;
  };
}
