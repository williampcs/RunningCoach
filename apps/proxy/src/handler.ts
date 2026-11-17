/**
 * 薄代理 — 驗證帳號、檢查每天的次數與預算、把請求轉給 LLM 供應商、累計用量（免費試用的內測，規格 12.39）.
 *
 * 對外介面與 Anthropic Messages API 相容：客戶端只需把 baseURL 指向這裡，
 * 並以代理發給的憑證取代 API key。請求與回應內容只在記憶體中經過，不寫入儲存、不寫入日誌。
 *
 * 帳號從邀請碼兌換來（POST /v1/redeem）：作者用管理端點產生邀請碼給朋友，一碼用一次，憑證只回傳一次.
 * 帳號的復原密鑰（規格 12.44 第 1 步）：裝置產生後放進選手加密的同步；新裝置用它換自己的憑證（POST /v1/recover）.
 * 代理只存雜湊，不知道同步空間；同步服務只看到密文.
 */
import { MemoryRateLimiter, hashSource, sourceIp, type RateLimiter } from "@running-coach/core/rate-limit";

import { emptyUsage, meterSseStream, usageFromJson, type MeterResult } from "./metering";
import { costMicroUsd, usdToMicro, type ModelPrice, type Policy, type TokenUsage } from "./policy";
import type { Account, AccountStore, DailyKind, Invite } from "./store";

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
  /**
   * 每分鐘次數的計數. Workers 用 D1 的（所有執行個體共用，SqlRateLimiter）；沒有給時用這個執行個體記憶體裡的（本機、測試）
   */
  rateLimiter?: RateLimiter;
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

/** 網頁版看 error.type 決定怎麼說明（apps/web/src/trial.ts） */
export type LimitErrorType = "daily_limit" | "daily_auto_limit" | "account_budget" | "beta_budget";

type Json = Record<string, unknown>;

function errorResponse(status: number, type: string, message: string, extra?: Json, headers?: HeadersInit): Response {
  return Response.json({ type: "error", error: { type, message, ...extra } }, { status, headers });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
}

// 邀請碼：去掉容易看錯的字（0 O 1 I L）的 31 個字元，12 個字約 59 bits，分三段方便唸與輸入
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const CODE_LENGTH = 12;
// 連結碼（在另一台裝置使用）：8 個字（約 40 bits），10 分鐘內用一次，兌換的次數有限制
const LINK_CODE_LENGTH = 8;

/** 隨機的碼，每 4 個字一段 */
function newCode(length: number): string {
  const chars: string[] = [];
  while (chars.length < length) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      // 拒絕取樣，避免取餘數造成的偏差
      if (byte < 248 && chars.length < length) chars.push(CODE_ALPHABET[byte % CODE_ALPHABET.length]!);
    }
  }
  return Array.from({ length: length / 4 }, (_, i) => chars.slice(i * 4, i * 4 + 4).join("")).join("-");
}

const newInviteCode = () => `RC-${newCode(CODE_LENGTH)}`;

function normalize(input: string, length: number): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length !== length || [...compact].some((c) => !CODE_ALPHABET.includes(c))) return null;
  return compact;
}

/** 貼上的邀請碼：大小寫、空白、連字號都不計較；格式不對時回傳 null */
export function normalizeInviteCode(input: string): string | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  // 前面的 RC 是固定的字首（12 個字的碼本身也可能以 RC 開頭，所以只在多兩個字時拿掉）
  return normalize(compact.length === CODE_LENGTH + 2 && compact.startsWith("RC") ? compact.slice(2) : compact, CODE_LENGTH);
}

// 帳號的復原密鑰：32 bytes（256 bits）隨機，只在產生時回傳一次
const RECOVERY_SECRET = /^rcs_[0-9a-f]{64}$/;
const ACCOUNT_ID = /^acct_[\w-]{1,64}$/;

/** 連結碼：XXXX-XXXX */
export function normalizeLinkCode(input: string): string | null {
  return normalize(input, LINK_CODE_LENGTH);
}

function presentedToken(request: Request): string | null {
  const apiKey = request.headers.get("x-api-key")?.trim();
  if (apiKey) return apiKey;
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get("authorization") ?? "");
  return match?.[1]?.trim() || null;
}

/** 教練會送的內容區塊：文字、工具呼叫與結果、模型回的思考（原封不動送回）. 圖片、文件等其他的一律拒絕 */
const MESSAGE_BLOCKS = new Set(["text", "tool_use", "tool_result", "thinking", "redacted_thinking"]);

const isObject = (value: unknown): value is Json => typeof value === "object" && value !== null && !Array.isArray(value);

/** 只能是文字的地方（system、工具結果的內容）：字串或文字區塊的陣列 */
function textOnly(value: unknown, where: string): string | null {
  if (typeof value === "string") return null;
  if (!Array.isArray(value)) return `${where} 必須是字串或陣列`;
  for (const block of value) {
    if (!isObject(block) || block.type !== "text") return `${where} 只接受文字區塊`;
  }
  return null;
}

/** 檢查 system 與 messages 的內容區塊類型（只看類型，不讀內容） */
function validateContent(body: Json): string | null {
  if (body.system !== undefined) {
    const problem = textOnly(body.system, "system");
    if (problem) return problem;
  }
  for (const message of body.messages as unknown[]) {
    if (!isObject(message) || (message.role !== "user" && message.role !== "assistant")) return "messages 的每一則要有 role（user 或 assistant）";
    if (typeof message.content === "string") continue;
    if (!Array.isArray(message.content)) return "messages 的 content 必須是字串或陣列";
    for (const block of message.content as unknown[]) {
      if (!isObject(block) || typeof block.type !== "string" || !MESSAGE_BLOCKS.has(block.type)) {
        return `不支援的內容類型：${isObject(block) ? String(block.type) : typeof block}`;
      }
      if (block.type === "tool_result" && block.content !== undefined) {
        const problem = textOnly(block.content, "tool_result 的 content");
        if (problem) return problem;
      }
    }
  }
  return null;
}

/** 快取一律用預設的 5 分鐘：拿掉 cache_control 的其他設定（例如 ttl），計費和預扣照 5 分鐘的價格 */
function normalizeCacheControl(body: Json): void {
  const fix = (holder: unknown) => {
    if (isObject(holder) && holder.cache_control !== undefined) holder.cache_control = { type: "ephemeral" };
  };
  fix(body);
  if (Array.isArray(body.system)) body.system.forEach(fix);
  if (Array.isArray(body.tools)) body.tools.forEach(fix);
  for (const message of body.messages as unknown[]) {
    if (!isObject(message) || !Array.isArray(message.content)) continue;
    for (const block of message.content as unknown[]) {
      fix(block);
      if (isObject(block) && Array.isArray(block.content)) block.content.forEach(fix);
    }
  }
}

/** 回傳拒絕原因；通過時回傳 null */
function validateBody(body: Json, policy: Policy): string | null {
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) return `不支援的欄位：${key}`;
  }
  if (typeof body.model !== "string") return "model 必須是字串";
  if (policy.forceModel === null && !(body.model in policy.models)) {
    return `不支援的模型：${String(body.model)}（可用：${Object.keys(policy.models).join("、")}）`;
  }
  if (typeof body.max_tokens !== "number" || !Number.isInteger(body.max_tokens) || body.max_tokens < 1) {
    return "max_tokens 必須是正整數";
  }
  if (!Array.isArray(body.messages)) return "messages 必須是陣列";
  const content = validateContent(body);
  if (content) return content;
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools)) return "tools 必須是陣列";
    for (const tool of body.tools as Json[]) {
      // 只接受客戶端自行執行的工具；伺服器端工具（網頁搜尋、程式執行等）另外計費
      if (tool?.type !== undefined && tool.type !== "custom") return `不支援的工具類型：${String(tool.type)}`;
    }
  }
  return null;
}

/**
 * 這次請求算不算新的一則：最後一則是選手的文字才算；最後一則只有工具結果的是工具迴圈的下一輪，不重複算.
 * 只看 content 的型別，不讀、不留內容
 */
export function isNewTurn(messages: unknown[]): boolean {
  const last = messages.at(-1) as Json | undefined;
  if (!last || last.role !== "user") return false;
  if (!Array.isArray(last.content)) return true;
  return !(last.content as Json[]).every((block) => block?.type === "tool_result");
}

/**
 * 預扣的用量與花費：輸出照套用政策後的 max_tokens；輸入照轉發的請求有幾個位元組估（一個 token 至少一個位元組，所以不會少估），
 * 而且照輸入、快取寫入、快取讀取裡最貴的價格算
 */
export function reservation(price: ModelPrice, requestBytes: number, maxTokens: number): { usage: TokenUsage; cost: number } {
  const inputPrice = Math.max(price.input, price.cacheWrite ?? price.input * 1.25, price.cacheRead ?? price.input * 0.1);
  const usage: TokenUsage = { input: requestBytes, output: maxTokens, cacheRead: 0, cacheWrite: 0 };
  return { usage, cost: costMicroUsd({ input: inputPrice, output: price.output, cacheRead: 0, cacheWrite: 0 }, usage) };
}

const scale = (usage: TokenUsage, factor: number): TokenUsage => ({
  input: usage.input * factor,
  output: usage.output * factor,
  cacheRead: usage.cacheRead * factor,
  cacheWrite: usage.cacheWrite * factor,
});

/** 套用政策：固定的模型、固定的思考強度或關掉思考、輸出上限、快取的時間 */
function applyPolicy(body: Json, policy: Policy): void {
  normalizeCacheControl(body);
  if (policy.forceModel !== null) body.model = policy.forceModel;
  if ((body.max_tokens as number) > policy.maxOutputTokens) body.max_tokens = policy.maxOutputTokens;
  if (policy.disableThinking) {
    const config = body.output_config as Json | undefined;
    if (config && typeof config === "object") {
      const { effort: _effort, ...rest } = config;
      if (Object.keys(rest).length) body.output_config = rest;
      else delete body.output_config;
    }
    body.thinking = { type: "disabled" };
  }
  if (policy.forceEffort !== null) {
    // 和直連時核心送的一樣：output_config.effort，不送 thinking（模型預設 adaptive）
    const config = body.output_config && typeof body.output_config === "object" ? (body.output_config as Json) : {};
    body.output_config = { ...config, effort: policy.forceEffort };
    delete body.thinking;
  }
}

export function createProxy(deps: ProxyDeps): (request: Request) => Promise<Response> {
  const { store, policy } = deps;
  const fetchImpl = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => undefined);
  const upstreamUrl = `${deps.upstream.baseUrl.replace(/\/+$/, "")}/v1/messages`;

  // 每分鐘次數：Workers 上每個請求可能在不同的執行個體，計數要放在共用的地方（worker.ts 給 D1 的）
  const limiter = deps.rateLimiter ?? new MemoryRateLimiter(() => now().getTime());
  const overLimit = async (key: string, limit: number) => !(await limiter.take(`proxy:${key}`, { limit, windowMs: 60_000 }));
  /** 兌換邀請碼、連結碼與取回共用每個來源 IP 的次數；IP 只以雜湊計數，不寫進儲存的其他地方或日誌 */
  const overRedeemLimit = async (request: Request) => overLimit(`redeem:${await hashSource(sourceIp(request))}`, policy.redeemsPerMinute);

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

  // 每天與每月都照政策的時區（台灣）：午夜重置、每月 1 日恢復
  const offsetMs = policy.timeZoneOffsetMinutes * 60_000;
  const localDate = (date: Date) => new Date(date.getTime() + offsetMs).toISOString().slice(0, 10);
  const day = () => localDate(now());
  const period = () => day().slice(0, 7);
  const offsetText = (() => {
    const sign = policy.timeZoneOffsetMinutes < 0 ? "-" : "+";
    const abs = Math.abs(policy.timeZoneOffsetMinutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  })();
  /** 明天的午夜（當地），例：2026-11-11T00:00:00+08:00 */
  const nextDayStart = () => {
    const [y, m, d] = day().split("-").map(Number) as [number, number, number];
    return `${new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)}T00:00:00${offsetText}`;
  };
  const nextPeriodStart = () => {
    const [y, m] = period().split("-").map(Number) as [number, number];
    return `${new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10)}T00:00:00${offsetText}`;
  };

  const budgetOf = (account: Account) => account.monthlyBudgetMicroUsd ?? usdToMicro(policy.defaultMonthlyBudgetUsd);
  const totalBudget = policy.totalMonthlyBudgetUsd === null ? null : usdToMicro(policy.totalMonthlyBudgetUsd);
  const dailyLimit: Record<DailyKind, number> = {
    chat: policy.dailyMessages,
    auto: policy.dailyAuto,
    compress: policy.dailyCompress,
    tool: policy.dailyToolTurns ?? policy.dailyMessages * 10,
  };

  /** 帳號加上這次用的是哪一台的憑證 */
  type Authed = Account & { tokenId: string };

  async function authenticate(request: Request): Promise<Authed | Response> {
    const token = presentedToken(request);
    if (!token) return errorResponse(401, "authentication_error", "缺少試用憑證");
    const found = await store.findByTokenHash(await sha256Hex(token));
    if (!found) return errorResponse(401, "authentication_error", "試用憑證無效（這台可能已被移除，或帳號已刪除），請重新輸入邀請碼或連結碼");
    if (found.account.status !== "active") return errorResponse(403, "permission_error", "這個試用帳號已停用");
    // 最後使用的時間（裝置清單用）：一小時內用過的不再寫，少一些寫入
    const last = found.token.lastUsedAt ? Date.parse(found.token.lastUsedAt) : 0;
    if (now().getTime() - last > 3_600_000) await store.touchToken(found.token.id, now());
    return { ...found.account, tokenId: found.token.id };
  }

  /** 這個月的預算還夠嗎；不夠時回傳拒絕的回應 */
  async function budgetProblem(account: Account): Promise<Response | null> {
    const currentPeriod = period();
    if (totalBudget !== null && (await store.getTotal(currentPeriod)).costMicroUsd >= totalBudget) {
      return errorResponse(403, "beta_budget", "這個月的免費額度用完了，下個月 1 日恢復", { resets_at: nextPeriodStart() });
    }
    if ((await store.getUsage(account.id, currentPeriod)).costMicroUsd >= budgetOf(account)) {
      return errorResponse(403, "account_budget", "你這個月的免費額度用完了，下個月 1 日恢復", { resets_at: nextPeriodStart() });
    }
    return null;
  }

  async function handleMessages(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    if (await overLimit(`acct:${account.id}`, policy.requestsPerMinute)) {
      return errorResponse(429, "rate_limit_error", "請求太頻繁，請稍後再試", undefined, { "retry-after": "30" });
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
    applyPolicy(body, policy);
    const model = body.model as string;

    const budget = await budgetProblem(account);
    if (budget) return budget;

    // 每天的次數（規格 12.39）：客戶端用 x-coach-meter 說這次是哪一種，沒有帶的照對話算；
    // 對話裡不是新的一則的（工具迴圈的接續）另外算，上限比較寬
    const meter = request.headers.get("x-coach-meter");
    const kind: DailyKind = meter === "auto" || meter === "compress" ? meter : isNewTurn(body.messages as unknown[]) ? "chat" : "tool";
    const today = day();
    if (!(await store.reserveDaily(account.id, today, kind, dailyLimit[kind]))) {
      const resets_at = nextDayStart();
      if (kind === "chat" || kind === "tool") {
        return errorResponse(403, "daily_limit", `今天的 ${policy.dailyMessages} 則用完了，明天 00:00 恢復`, { resets_at, limit: policy.dailyMessages });
      }
      return errorResponse(403, "daily_auto_limit", "今天自動分析的次數用完了，明天 00:00 恢復", { resets_at, limit: dailyLimit[kind] });
    }
    const release = () => store.releaseDaily(account.id, today, kind);

    // 計費：先預扣、後結算（規格 12.39）. 送出前先記下這次最多可能的花費，拿到上游最後的用量再改成實際的
    const currentPeriod = period();
    const price = policy.models[model]!;
    const forwarded = JSON.stringify(body);
    const reserved = reservation(price, new TextEncoder().encode(forwarded).length, body.max_tokens as number);
    let reservedOk: Awaited<ReturnType<AccountStore["reserveUsage"]>>;
    try {
      reservedOk = await store.reserveUsage(account.id, currentPeriod, reserved.usage, reserved.cost, budgetOf(account), totalBudget);
    } catch (e) {
      await release();
      throw e;
    }
    if (reservedOk !== "ok") {
      await release();
      return reservedOk === "beta_budget"
        ? errorResponse(403, "beta_budget", "這個月的免費額度用完了，下個月 1 日恢復", { resets_at: nextPeriodStart() })
        : errorResponse(403, "account_budget", "你這個月的免費額度用完了，下個月 1 日恢復", { resets_at: nextPeriodStart() });
    }
    const keep = (promise: Promise<void>): Promise<void> => {
      const write = promise.catch((e) => log(`usage write failed for ${account.id}: ${e instanceof Error ? e.message : String(e)}`));
      deps.waitUntil?.(write);
      return write;
    };
    /** 上游回錯誤、沒有產生回覆：退回預扣 */
    const refund = () => keep(store.adjustUsage(account.id, currentPeriod, scale(reserved.usage, -1), -reserved.cost, -1));

    let upstream: Response;
    try {
      upstream = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": deps.upstream.apiKey,
          "anthropic-version": request.headers.get("anthropic-version") ?? "2023-06-01",
        },
        body: forwarded,
      });
    } catch (e) {
      await Promise.all([release(), refund()]);
      throw e;
    }

    const headers = new Headers();
    for (const name of PASS_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    /**
     * 結算：拿到最後的用量就改成實際的（多退少補）；沒拿到的（下游中斷、上游出錯、串流提早結束）維持預扣的輸出，
     * 已知的輸入照實際的. Worker 在這之前被取消的，就停在預扣的數字
     */
    const settle = ({ usage, final, inputKnown, upstreamError }: MeterResult): Promise<void> => {
      // 上游以 error 事件結束（例如過載）：上游停在那裡，照讀到的最後數字算，不照最多的輸出
      const known = final || upstreamError === true;
      const actual: TokenUsage = known ? usage : inputKnown ? { ...usage, output: reserved.usage.output } : reserved.usage;
      const cost = known || inputKnown ? costMicroUsd(price, actual) : reserved.cost;
      log(
        `${account.id} ${model} ${upstream.status} ${kind} in=${actual.input + actual.cacheRead + actual.cacheWrite}` +
          ` out=${actual.output} cost_microusd=${cost}${final ? "" : upstreamError ? " (upstream error)" : " (estimated)"}`,
      );
      const delta: TokenUsage = {
        input: actual.input - reserved.usage.input,
        output: actual.output - reserved.usage.output,
        cacheRead: actual.cacheRead - reserved.usage.cacheRead,
        cacheWrite: actual.cacheWrite - reserved.usage.cacheWrite,
      };
      return keep(store.adjustUsage(account.id, currentPeriod, delta, cost - reserved.cost));
    };

    if (!upstream.ok || !upstream.body) {
      log(`${account.id} ${model} ${upstream.status}`);
      // 沒有產生回覆：不扣這一次
      await Promise.all([release(), refund()]);
      return new Response(upstream.body, { status: upstream.status, headers });
    }
    if (upstream.headers.get("content-type")?.includes("text/event-stream")) {
      return new Response(
        meterSseStream(upstream.body, (result) => void settle(result)),
        { status: upstream.status, headers },
      );
    }
    let text: string;
    try {
      text = await upstream.text();
    } catch (e) {
      await settle({ usage: emptyUsage(), final: false, inputKnown: false });
      throw e;
    }
    await settle(usageFromJson(text));
    return new Response(text, { status: upstream.status, headers });
  }

  /** 網頁版顯示「今天還剩 N 則」與用完的說明 */
  async function handleUsage(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    const currentPeriod = period();
    const [used, daily, total] = await Promise.all([store.getUsage(account.id, currentPeriod), store.getDaily(account.id, day()), store.getTotal(currentPeriod)]);
    const paused =
      totalBudget !== null && total.costMicroUsd >= totalBudget ? "beta_budget" : used.costMicroUsd >= budgetOf(account) ? "account_budget" : null;
    return Response.json({
      // 這台用的帳號（同步裡的復原密鑰記在哪個帳號下，規格 12.44）
      account_id: account.id,
      period: currentPeriod,
      requests: used.requests,
      input_tokens: used.input + used.cacheRead + used.cacheWrite,
      output_tokens: used.output,
      cost_usd: used.costMicroUsd / 1_000_000,
      budget_usd: budgetOf(account) / 1_000_000,
      model: policy.forceModel,
      thinking: !policy.disableThinking,
      // 思考強度（固定時）；null 表示照請求的或不思考（看 thinking）
      effort: policy.disableThinking ? null : policy.forceEffort,
      today: {
        day: day(),
        messages_used: daily.chat,
        messages_limit: policy.dailyMessages,
        auto_used: daily.auto,
        auto_limit: policy.dailyAuto,
        resets_at: nextDayStart(),
      },
      paused,
      paused_until: paused ? nextPeriodStart() : null,
    });
  }

  /** 給一台裝置新的憑證；憑證只在回應裡出現這一次，之後只存雜湊 */
  async function issueToken(accountId: string, deviceName: string | null): Promise<string> {
    const token = `rc_${randomHex(32)}`;
    await store.addToken(accountId, `tok_${randomHex(8)}`, await sha256Hex(token), deviceName, now());
    return token;
  }

  /** 裝置名稱：網頁版給的粗略名稱，只留短短一行 */
  const deviceNameOf = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ").slice(0, 40) : null);

  /** 兌換邀請碼：不用登入；成功時建立帳號，憑證只在這裡回傳一次 */
  async function handleRedeem(request: Request): Promise<Response> {
    // 每個來源 IP 每分鐘的次數；兌換邀請碼、連結碼與取回共用
    if (await overRedeemLimit(request)) {
      return errorResponse(429, "rate_limit_error", "試太多次了，請一分鐘後再試", undefined, { "retry-after": "60" });
    }
    const input = (await request.json().catch(() => ({}))) as Json;
    const code = typeof input.code === "string" ? normalizeInviteCode(input.code) : null;
    if (!code) return errorResponse(400, "invalid_invite", "邀請碼的格式不對（像 RC-XXXX-XXXX-XXXX）");

    const accountId = `acct_${randomHex(8)}`;
    const claimed = await store.claimInvite(await sha256Hex(code), accountId, now());
    if (typeof claimed === "string") {
      log(`redeem rejected: ${claimed}`);
      const message = { unknown: "找不到這個邀請碼，請確認有沒有打錯", used: "這個邀請碼已經用過了", revoked: "這個邀請碼已停用", expired: "這個邀請碼已過期" }[claimed];
      return errorResponse(400, "invalid_invite", message, { reason: claimed });
    }
    let token: string;
    try {
      await store.createAccount(accountId, claimed.monthlyBudgetMicroUsd, claimed.id, now());
      await store.addIdentity(accountId, "invite", await sha256Hex(code), now());
      token = await issueToken(accountId, deviceNameOf(input.device_name));
    } catch (e) {
      await store.deleteAccount(accountId);
      await store.unclaimInvite(claimed.id);
      throw e;
    }
    log(`redeem ok: ${accountId} from ${claimed.id}`);
    return Response.json(
      { account_id: accountId, token, model: policy.forceModel, daily_messages: policy.dailyMessages, daily_auto: policy.dailyAuto },
      { status: 201 },
    );
  }

  /** 在另一台裝置使用：已登入的這台要一個短效的連結碼（用一次、policy.linkCodeMinutes 分鐘） */
  async function handleCreateLinkCode(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    const code = newCode(LINK_CODE_LENGTH);
    const expiresAt = new Date(now().getTime() + policy.linkCodeMinutes * 60_000);
    await store.createLinkCode(await sha256Hex(normalizeLinkCode(code)!), account.id, now(), expiresAt);
    return Response.json({ code, expires_at: expiresAt.toISOString() }, { status: 201 });
  }

  /** 另一台輸入連結碼：拿到自己的憑證（同一個帳號、同一份額度） */
  async function handleLink(request: Request): Promise<Response> {
    if (await overRedeemLimit(request)) {
      return errorResponse(429, "rate_limit_error", "試太多次了，請一分鐘後再試", undefined, { "retry-after": "60" });
    }
    const input = (await request.json().catch(() => ({}))) as Json;
    const code = typeof input.code === "string" ? normalizeLinkCode(input.code) : null;
    if (!code) return errorResponse(400, "invalid_link", "連結碼的格式不對（像 XXXX-XXXX）");
    const claimed = await store.claimLinkCode(await sha256Hex(code), now());
    if (claimed === "unknown" || claimed === "used" || claimed === "expired") {
      log(`link rejected: ${claimed}`);
      const message = {
        unknown: "找不到這個連結碼，請確認有沒有打錯",
        used: "這個連結碼已經用過了，請在已經登入的那台再按一次「在另一台裝置使用」",
        expired: "這個連結碼已過期，請在已經登入的那台再按一次「在另一台裝置使用」",
      }[claimed];
      return errorResponse(400, "invalid_link", message, { reason: claimed });
    }
    const account = await store.getAccount(claimed);
    if (!account) return errorResponse(400, "invalid_link", "這個試用帳號已經刪除了", { reason: "unknown" });
    if (account.status !== "active") return errorResponse(403, "permission_error", "這個試用帳號已停用");
    const token = await issueToken(account.id, deviceNameOf(input.device_name));
    log(`link ok: ${account.id}`);
    return Response.json(
      { account_id: account.id, token, model: policy.forceModel, daily_messages: policy.dailyMessages, daily_auto: policy.dailyAuto },
      { status: 201 },
    );
  }

  /**
   * 帳號的復原密鑰（規格 12.44 第 1 步）：產生一把新的（舊的作廢），只在這裡回傳一次，之後只存雜湊.
   * 身分：這台的憑證；或沒有憑證的裝置（例如自己的 API key、在同步裡換了金鑰的那台）用目前的那一把
   * （{account, secret}，和取回共用每個 IP 的頻率限制）
   */
  async function handleRecoverySecret(request: Request): Promise<Response> {
    let accountId: string;
    if (presentedToken(request)) {
      const account = await authenticate(request);
      if (account instanceof Response) return account;
      accountId = account.id;
    } else {
      const checked = await checkRecovery(request);
      if (checked instanceof Response) return checked;
      accountId = checked.account.id;
    }
    const secret = `rcs_${randomHex(32)}`;
    await store.setRecoveryHash(accountId, await sha256Hex(secret));
    log(`recovery secret set: ${accountId}`);
    return Response.json({ account_id: accountId, secret }, { status: 201 });
  }

  /**
   * 檢查 {account, secret}：錯了一律回「不對」（不透露帳號存不存在、有沒有復原密鑰）；對了但帳號暫停時拒絕.
   * 每個 IP 每分鐘的次數和兌換、連結碼共用
   */
  async function checkRecovery(request: Request): Promise<{ account: Account; input: Json } | Response> {
    if (await overRedeemLimit(request)) {
      return errorResponse(429, "rate_limit_error", "試太多次了，請一分鐘後再試", undefined, { "retry-after": "60" });
    }
    const input = (await request.json().catch(() => ({}))) as Json;
    const wrong = () => {
      log("recover rejected");
      return errorResponse(400, "invalid_recovery", "取回免費試用的資料不對（可能已經換新或帳號已刪除），請在已經用著免費試用的那台再同步一次，或用連結碼");
    };
    if (typeof input.account !== "string" || !ACCOUNT_ID.test(input.account) || typeof input.secret !== "string" || !RECOVERY_SECRET.test(input.secret)) {
      return wrong();
    }
    const [stored, presented] = [await store.getRecoveryHash(input.account), await sha256Hex(input.secret)];
    if (!stored || stored !== presented) return wrong();
    const account = await store.getAccount(input.account);
    if (!account) return wrong();
    if (account.status !== "active") return errorResponse(403, "permission_error", "這個試用帳號已停用");
    return { account, input };
  }

  /** 新的裝置用同步裡的復原密鑰拿到自己的憑證（同一個帳號、同一份額度；每台一個，可以單獨移除） */
  async function handleRecover(request: Request): Promise<Response> {
    const checked = await checkRecovery(request);
    if (checked instanceof Response) return checked;
    const { account, input } = checked;
    const token = await issueToken(account.id, deviceNameOf(input.device_name));
    log(`recover ok: ${account.id}`);
    return Response.json(
      { account_id: account.id, token, model: policy.forceModel, daily_messages: policy.dailyMessages, daily_auto: policy.dailyAuto },
      { status: 201 },
    );
  }

  /** 這個帳號的裝置（設定裡列出來，可以移除某一台） */
  async function handleDevices(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    const devices = await store.listTokens(account.id);
    return Response.json({
      devices: devices.map((d) => ({ id: d.id, name: d.deviceName, created_at: d.createdAt, last_used_at: d.lastUsedAt, current: d.id === account.tokenId })),
    });
  }

  async function handleRevokeDevice(request: Request, tokenId: string): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    if (!(await store.revokeToken(account.id, tokenId, now()))) return errorResponse(404, "not_found_error", "找不到這台裝置");
    log(`device revoked: ${account.id} ${tokenId}`);
    return Response.json({ revoked: true });
  }

  /** 選手自己刪除試用帳號：帳號、所有裝置的憑證、每天的次數、每月的用量一起刪 */
  async function handleDeleteAccount(request: Request): Promise<Response> {
    const account = await authenticate(request);
    if (account instanceof Response) return account;
    await store.revokeAllTokens(account.id, now());
    await store.deleteAccount(account.id);
    log(`account deleted by owner: ${account.id}`);
    return Response.json({ deleted: true });
  }

  // ---------------------------------------------------------------------------
  // 管理端點：作者產生邀請碼、看用量、停用帳號（tools/proxy-admin.ts）
  // ---------------------------------------------------------------------------

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
    const [used, daily] = await Promise.all([store.getUsage(account.id, currentPeriod), store.getDaily(account.id, day())]);
    return {
      id: account.id,
      status: account.status,
      invite_id: account.inviteId,
      created_at: account.createdAt,
      monthly_budget_usd: budgetOf(account) / 1_000_000,
      usage: { period: currentPeriod, requests: used.requests, cost_usd: used.costMicroUsd / 1_000_000 },
      today: { messages: daily.chat, auto: daily.auto, compress: daily.compress, tool_turns: daily.tool },
    };
  }

  function inviteView(invite: Invite) {
    const status = invite.revoked
      ? "revoked"
      : invite.redeemedAt
        ? "used"
        : invite.expiresAt && invite.expiresAt <= now().toISOString()
          ? "expired"
          : "unused";
    return {
      id: invite.id,
      status,
      label: invite.label,
      monthly_budget_usd: (invite.monthlyBudgetMicroUsd ?? usdToMicro(policy.defaultMonthlyBudgetUsd)) / 1_000_000,
      expires_at: invite.expiresAt,
      created_at: invite.createdAt,
      redeemed_at: invite.redeemedAt,
      account_id: invite.accountId,
    };
  }

  /** 到期日：YYYY-MM-DD 表示那一天結束（當地時間）；也接受完整的 ISO 時間 */
  function expiresInput(value: unknown): string | null | Response {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "string") {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        const end = new Date(`${value}T23:59:59.999${offsetText}`);
        if (!Number.isNaN(end.getTime())) return end.toISOString();
      } else {
        const at = new Date(value);
        if (!Number.isNaN(at.getTime())) return at.toISOString();
      }
    }
    return errorResponse(400, "invalid_request_error", "expires_at 要是 YYYY-MM-DD 或 ISO 時間");
  }

  async function handleAdmin(request: Request, path: string): Promise<Response> {
    if (!deps.adminToken) return errorResponse(404, "not_found_error", "找不到這個端點");
    const presented = presentedToken(request);
    // 比對雜湊，避免逐字元比較洩漏憑證內容
    if (!presented || (await sha256Hex(presented)) !== (await sha256Hex(deps.adminToken))) {
      return errorResponse(401, "authentication_error", "管理憑證無效");
    }

    const input = request.method === "GET" || request.method === "DELETE" ? {} : ((await request.json().catch(() => ({}))) as Json);

    if (path === "/admin/summary" && request.method === "GET") {
      const currentPeriod = period();
      const [total, accounts, invites] = await Promise.all([store.getTotal(currentPeriod), store.listAccounts(), store.listInvites()]);
      return Response.json({
        period: currentPeriod,
        cost_usd: total.costMicroUsd / 1_000_000,
        requests: total.requests,
        total_budget_usd: totalBudget === null ? null : totalBudget / 1_000_000,
        paused: totalBudget !== null && total.costMicroUsd >= totalBudget,
        accounts: accounts.length,
        active_accounts: accounts.filter((a) => a.status === "active").length,
        unused_invites: invites.map(inviteView).filter((i) => i.status === "unused").length,
        policy: {
          model: policy.forceModel,
          thinking: !policy.disableThinking,
          effort: policy.disableThinking ? null : policy.forceEffort,
          daily_messages: policy.dailyMessages,
          daily_auto: policy.dailyAuto,
          monthly_budget_usd: policy.defaultMonthlyBudgetUsd,
        },
      });
    }

    if (path === "/admin/invites") {
      if (request.method === "GET") return Response.json({ invites: (await store.listInvites()).map(inviteView) });
      if (request.method !== "POST") return errorResponse(405, "invalid_request_error", "不支援的方法");
      const count = input.count === undefined ? 1 : input.count;
      if (typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 50) {
        return errorResponse(400, "invalid_request_error", "count 要是 1–50 的整數");
      }
      const budget = budgetInput(input.monthly_budget_usd);
      if (budget instanceof Response) return budget;
      const expiresAt = expiresInput(input.expires_at);
      if (expiresAt instanceof Response) return expiresAt;
      if (input.label !== undefined && input.label !== null && (typeof input.label !== "string" || input.label.length > 60)) {
        return errorResponse(400, "invalid_request_error", "label 要是 60 字以內的文字");
      }
      const label = typeof input.label === "string" && input.label.trim() ? input.label.trim() : null;
      const created: { id: string; code: string; expires_at: string | null }[] = [];
      for (let i = 0; i < count; i++) {
        const code = newInviteCode();
        const id = `inv_${randomHex(6)}`;
        await store.createInvite(
          { id, label, monthlyBudgetMicroUsd: budget ?? null, expiresAt, createdAt: now().toISOString() },
          await sha256Hex(normalizeInviteCode(code)!),
        );
        created.push({ id, code, expires_at: expiresAt });
      }
      // 邀請碼只在這裡回傳一次，之後只存雜湊；不寫進日誌
      log(`invites created: ${created.length}`);
      return Response.json({ invites: created }, { status: 201 });
    }

    const inviteMatch = /^\/admin\/invites\/([\w-]+)$/.exec(path);
    if (inviteMatch) {
      if (request.method !== "PATCH") return errorResponse(405, "invalid_request_error", "不支援的方法");
      if (input.revoked !== true) return errorResponse(400, "invalid_request_error", "只能停用：{\"revoked\": true}");
      const id = inviteMatch[1]!;
      if (!(await store.revokeInvite(id))) return errorResponse(404, "not_found_error", `找不到邀請碼 ${id}`);
      const invite = (await store.listInvites()).find((i) => i.id === id)!;
      return Response.json(inviteView(invite));
    }

    if (path === "/admin/accounts") {
      if (request.method === "GET") {
        return Response.json({ accounts: await Promise.all((await store.listAccounts()).map(accountView)) });
      }
      if (request.method !== "POST") return errorResponse(405, "invalid_request_error", "不支援的方法");
      // 不經邀請碼直接建立（作者自己測試用）
      const budget = budgetInput(input.monthly_budget_usd);
      if (budget instanceof Response) return budget;
      const id = `acct_${randomHex(8)}`;
      await store.createAccount(id, budget ?? null, null, now());
      const token = await issueToken(id, deviceNameOf(input.device_name));
      // 憑證只在這裡回傳一次，之後只存雜湊
      return Response.json({ id, token }, { status: 201 });
    }

    const match = /^\/admin\/accounts\/([\w-]+)(\/rotate-token)?$/.exec(path);
    if (!match) return errorResponse(404, "not_found_error", "找不到這個端點");
    const id = match[1]!;
    const notFound = () => errorResponse(404, "not_found_error", `找不到帳號 ${id}`);

    if (match[2]) {
      if (request.method !== "POST") return errorResponse(405, "invalid_request_error", "不支援的方法");
      // 撤銷這個帳號所有裝置的憑證，發一個新的
      if (!(await store.getAccount(id))) return notFound();
      await store.revokeAllTokens(id, now());
      return Response.json({ id, token: await issueToken(id, null) });
    }
    if (request.method === "DELETE") {
      await store.revokeAllTokens(id, now());
      return (await store.deleteAccount(id)) ? Response.json({ id, deleted: true }) : notFound();
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
    if (path === "/v1/redeem" && request.method === "POST") return handleRedeem(request);
    if (path === "/v1/account" && request.method === "DELETE") return handleDeleteAccount(request);
    if (path === "/v1/link-codes" && request.method === "POST") return handleCreateLinkCode(request);
    if (path === "/v1/link" && request.method === "POST") return handleLink(request);
    if (path === "/v1/recovery-secret" && request.method === "POST") return handleRecoverySecret(request);
    if (path === "/v1/recover" && request.method === "POST") return handleRecover(request);
    if (path === "/v1/devices" && request.method === "GET") return handleDevices(request);
    const device = /^\/v1\/devices\/([\w-]+)$/.exec(path);
    if (device && request.method === "DELETE") return handleRevokeDevice(request, device[1]!);
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
          "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
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

/** 刪掉過期的用量紀錄（每天的次數留 dailyRetentionDays 天、每月的用量留 monthlyRetentionMonths 個月）；每天執行一次 */
export async function purgeOld(store: AccountStore, policy: Policy, now = new Date()): Promise<{ daily: number; monthly: number }> {
  const local = new Date(now.getTime() + policy.timeZoneOffsetMinutes * 60_000);
  const oldestDay = new Date(local.getTime() - policy.dailyRetentionDays * 86_400_000).toISOString().slice(0, 10);
  const oldestPeriod = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() - (policy.monthlyRetentionMonths - 1), 1)).toISOString().slice(0, 7);
  return store.purge(oldestDay, oldestPeriod, now);
}
