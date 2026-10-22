/**
 * 同步服務的 HTTP 介面（規格 12.10）. 只經手加密後的資料：
 * - 同步空間：以同步金鑰導出的 id 與憑證存取；伺服器只存憑證的雜湊
 * - 配對：新裝置與舊裝置交換臨時公開金鑰與加密後的同步金鑰；以配對碼存取，十分鐘失效
 * 不記錄 IP、標頭或內容；回應不快取.
 */
import type { SyncStore } from "./store";

export interface SyncDeps {
  store: SyncStore;
  /** 允許的網頁來源；"*" 表示全部 */
  allowedOrigins: string[];
  /** 產生配對碼用的亂數；測試時可以替換 */
  random?: (bytes: number) => Uint8Array;
  /** 整個服務的上限（建立空間與配對碼不需要帳號，避免被灌爆）；測試時可以調小 */
  limits?: Partial<ServiceLimits>;
}

export interface ServiceLimits {
  spaces: number;
  bytes: number;
  pairSlots: number;
}

const DEFAULT_LIMITS: ServiceLimits = { spaces: 500, bytes: 2_000_000_000, pairSlots: 200 };

/** 單筆紀錄的上限（base64url 的長度，約 1 MB） */
const MAX_BLOB = 1_400_000;
/** 一次請求的上限 */
const MAX_BODY = 4_000_000;
const MAX_PUSH = 200;
const MAX_PULL = 500;
/** 每個同步空間的上限 */
const MAX_RECORDS = 100_000;
const MAX_BYTES = 100_000_000;
const PAIR_TTL_MS = 10 * 60_000;

const SPACE = /^[0-9a-f]{32}$/;
const RECORD_ID = /^[A-Za-z0-9_-]{16,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** 配對碼：Crockford base32，去掉容易看錯的 I、L、O、U */
const SLOT_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const SLOT = /^[0-9A-HJKMNP-TV-Z]{8}$/;

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new HttpError(413, "內容太大");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "內容太大");
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch {
    // 下面統一回錯誤
  }
  throw new HttpError(400, "內容不是 JSON 物件");
}

const isKey = (value: unknown, max = 200): value is string => typeof value === "string" && value.length <= max && BASE64URL.test(value);

export function createSyncHandler(deps: SyncDeps): (request: Request) => Promise<Response> {
  const random = deps.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const limits = { ...DEFAULT_LIMITS, ...deps.limits };

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (!deps.allowedOrigins.includes("*") && !deps.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-max-age": "86400",
      vary: "Origin",
    };
  }

  /** 驗證同步空間的憑證；空間不存在是 404 */
  async function authorize(request: Request, space: string): Promise<void> {
    const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,64})$/)?.[1];
    if (!token) throw new HttpError(401, "缺少憑證");
    const stored = await deps.store.spaceToken(space);
    if (stored === null) throw new HttpError(404, "同步空間不存在");
    if (stored !== (await sha256Hex(token))) throw new HttpError(403, "憑證不符");
  }

  async function route(request: Request): Promise<Response | Record<string, unknown>> {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const method = request.method;
    if (parts[0] !== "v1") throw new HttpError(404, "找不到");

    // /v1/spaces/:space[/changes]
    if (parts[1] === "spaces" && parts[2]) {
      const space = parts[2];
      if (!SPACE.test(space)) throw new HttpError(400, "同步空間的 id 格式不對");
      // PUT：確認憑證；?create=1 時不存在就建立（只有「開始同步」的第一台會這樣做，
      // 其他時候空間不存在是 404，不會把已經刪除的空間默默建回來）
      if (parts.length === 3 && method === "PUT") {
        const token = request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,64})$/)?.[1];
        if (!token) throw new HttpError(401, "缺少憑證");
        const hash = await sha256Hex(token);
        const stored = await deps.store.spaceToken(space);
        if (stored !== null) {
          if (stored !== hash) throw new HttpError(403, "憑證不符");
          return { created: false };
        }
        if (url.searchParams.get("create") !== "1") throw new HttpError(404, "同步空間不存在");
        if ((await deps.store.totals()).spaces >= limits.spaces) throw new HttpError(503, "同步服務已滿");
        const created = await deps.store.createSpace(space, hash);
        if (!created && (await deps.store.spaceToken(space)) !== hash) throw new HttpError(403, "憑證不符");
        return { created };
      }
      await authorize(request, space);
      if (parts.length === 3 && method === "DELETE") {
        await deps.store.deleteSpace(space);
        return { deleted: true };
      }
      if (parts[3] === "changes" && parts.length === 4 && method === "GET") {
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        const limit = Math.min(MAX_PULL, Math.max(1, Number(url.searchParams.get("limit")) || MAX_PULL));
        const items = await deps.store.changes(space, since, limit);
        return { items, more: items.length === limit };
      }
      if (parts[3] === "changes" && parts.length === 4 && method === "POST") {
        const body = await readJson(request);
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items || items.length > MAX_PUSH) throw new HttpError(400, `items 要是陣列，最多 ${MAX_PUSH} 筆`);
        const usage = await deps.store.spaceUsage(space);
        const incoming = items.reduce((sum: number, item) => sum + String((item as Record<string, unknown>)?.blob ?? "").length, 0);
        if (usage.records + items.length > MAX_RECORDS || usage.bytes + incoming > MAX_BYTES) throw new HttpError(413, "同步空間已滿");
        if ((await deps.store.totals()).bytes + incoming > limits.bytes) throw new HttpError(503, "同步服務已滿");
        const applied: { id: string; seq: number }[] = [];
        const conflicts: string[] = [];
        for (const raw of items) {
          const item = raw as Record<string, unknown>;
          const id = item.id;
          const base = item.base;
          const blob = item.blob;
          if (typeof id !== "string" || !RECORD_ID.test(id)) throw new HttpError(400, "紀錄 id 格式不對");
          if (typeof base !== "number" || !Number.isInteger(base) || base < 0) throw new HttpError(400, "base 要是非負整數");
          if (typeof blob !== "string" || blob.length > MAX_BLOB || !BASE64URL.test(blob)) throw new HttpError(400, "blob 格式不對或太大");
          const seq = await deps.store.put(space, id, base, blob);
          if (seq === null) conflicts.push(id);
          else applied.push({ id, seq });
        }
        return { applied, conflicts };
      }
      throw new HttpError(405, "不支援的方法");
    }

    // /v1/pair[/:slot[/hello|/nonce|/box]]
    if (parts[1] === "pair") {
      if (parts.length === 2 && method === "POST") {
        const body = await readJson(request);
        if (!isKey(body.pub)) throw new HttpError(400, "pub 格式不對");
        if (!isKey(body.commitment, 100)) throw new HttpError(400, "commitment 格式不對");
        if ((await deps.store.activeSlots()) >= limits.pairSlots) throw new HttpError(503, "暫時無法建立配對碼，請稍後再試");
        for (let attempt = 0; attempt < 5; attempt++) {
          const slot = [...random(8)].map((b) => SLOT_ALPHABET[b % 32]).join("");
          if (await deps.store.createSlot(slot, body.pub, body.commitment, PAIR_TTL_MS)) return { slot, ttlSeconds: PAIR_TTL_MS / 1000 };
        }
        throw new HttpError(503, "暫時無法建立配對碼");
      }
      const slot = parts[2]?.toUpperCase();
      if (!slot || !SLOT.test(slot)) throw new HttpError(400, "配對碼格式不對");
      if (parts.length === 3 && method === "GET") {
        const found = await deps.store.getSlot(slot);
        if (!found) throw new HttpError(404, "配對碼不存在或已過期");
        return { ...found };
      }
      if (parts.length === 3 && method === "DELETE") {
        await deps.store.deleteSlot(slot);
        return { deleted: true };
      }
      if (parts.length === 4 && method === "POST" && (parts[3] === "hello" || parts[3] === "nonce" || parts[3] === "box")) {
        const body = await readJson(request);
        const value = parts[3] === "hello" ? body.pub : parts[3] === "nonce" ? body.nonce : body.box;
        if (!isKey(value, 4000)) throw new HttpError(400, "格式不對");
        const ok =
          parts[3] === "hello"
            ? await deps.store.setSlotHello(slot, value)
            : parts[3] === "nonce"
              ? await deps.store.setSlotNonce(slot, value)
              : await deps.store.setSlotBox(slot, value);
        if (!ok) throw new HttpError(409, "配對碼已被使用、順序不對或已過期");
        return { ok: true };
      }
      throw new HttpError(405, "不支援的方法");
    }

    throw new HttpError(404, "找不到");
  }

  return async (request) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const headers = { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    try {
      const body = await route(request);
      return new Response(JSON.stringify(body), { status: 200, headers });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "伺服器錯誤";
      return new Response(JSON.stringify({ error: message }), { status, headers });
    }
  };
}
