/**
 * 同步服務的 HTTP 介面（規格 12.10）. 只經手加密後的資料：
 * - 同步空間：以同步金鑰導出的 id 與憑證存取；伺服器只存憑證的雜湊
 * - 配對：新裝置與舊裝置交換臨時公開金鑰與加密後的同步金鑰；以配對碼存取，十分鐘失效
 * - 裝置（規格 12.27）：空間有登記的裝置之後（裝置模式），每個請求要用那台自己的金鑰簽章，
 *   舊的憑證只能用來登記新裝置. 移除某台＝換金鑰：留下的裝置搬到新的空間，舊空間只回答「搬到哪裡」與「已被移除」.
 *   沒有登記過裝置的空間照舊（舊版的用戶端）
 * 不記錄 IP、標頭或內容；回應不快取.
 */
import { DEVICE_ID, isP256Point, SIGNATURE_WINDOW_MS, bodyHash, signedMessage, verifySignature, verifyStatement } from "@running-coach/core/device";

import type { DeviceRow, SyncStore } from "./store";

export interface SyncDeps {
  store: SyncStore;
  /** 允許的網頁來源；"*" 表示全部 */
  allowedOrigins: string[];
  /** 產生配對碼用的亂數；測試時可以替換 */
  random?: (bytes: number) => Uint8Array;
  /** 整個服務的上限（建立空間與配對碼不需要帳號，避免被灌爆）；測試時可以調小 */
  limits?: Partial<ServiceLimits>;
  /** 冷卻期：加入多久之後才能移除別台、換金鑰、刪除雲端的資料（規格 12.27，24 小時）；測試時可以縮短 */
  cooldownMs?: number;
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
export const COOLDOWN_MS = 24 * 3600_000;
/**
 * 既有的空間升級成裝置模式後多久內，用舊憑證登記的算「升級前就在同步」（不受冷卻期限制）.
 * 拿到復原碼的人在這段時間登記也一樣，所以盡量短；晚於這段時間才打開的裝置當成新裝置（冷卻期＋提醒）
 */
const LEGACY_WINDOW_MS = 3 * 24 * 3600_000;
/** 每個空間最多幾台 */
const MAX_DEVICES = 20;
const MAX_LABEL = 1000;

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
    /** 用戶端依這些欄位判斷狀態（例如 state: "removed"）；不顯示 message */
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** 誰在呼叫：舊的憑證（沒有登記裝置的空間），或登記過的某台 */
type Caller = { kind: "token" } | { kind: "device"; device: DeviceRow };

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function readText(request: Request): Promise<string> {
  if (request.method === "GET" || request.method === "HEAD") return "";
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > MAX_BODY) throw new HttpError(413, "內容太大");
  const text = await request.text();
  if (text.length > MAX_BODY) throw new HttpError(413, "內容太大");
  return text;
}

function parseJson(text: string): Record<string, unknown> {
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
  const cooldownMs = deps.cooldownMs ?? COOLDOWN_MS;
  const store = deps.store;
  const nowMs = () => store.now().getTime();

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (!deps.allowedOrigins.includes("*") && !deps.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": "authorization, content-type, x-device, x-time, x-nonce, x-signature",
      "access-control-max-age": "86400",
      vary: "Origin",
    };
  }

  const bearer = (request: Request) => request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_-]{40,64})$/)?.[1] ?? null;

  /** 舊的憑證（從同步金鑰導出）；空間不存在是 404 */
  async function checkToken(request: Request, space: string): Promise<void> {
    const token = bearer(request);
    if (!token) throw new HttpError(401, "缺少憑證");
    const stored = await store.spaceToken(space);
    if (stored === null) throw new HttpError(404, "同步空間不存在");
    if (stored !== (await sha256Hex(token))) throw new HttpError(403, "憑證不符");
  }

  /** 從 /v1/ 開始的路徑與查詢字串（模擬服務放在 /sync 底下） */
  function signedPath(url: URL): string {
    const at = url.pathname.indexOf("/v1/");
    return `${at >= 0 ? url.pathname.slice(at) : url.pathname}${url.search}`;
  }

  /**
   * 檢查簽章：時間在前後 5 分鐘內、亂數沒用過、簽章對得上這把公開金鑰.
   * 時間不對時回傳伺服器的時間，用戶端校正後再送
   */
  async function checkSignature(request: Request, url: URL, text: string, deviceId: string, signPub: string): Promise<void> {
    const time = Number(request.headers.get("x-time"));
    const nonce = request.headers.get("x-nonce") ?? "";
    const signature = request.headers.get("x-signature") ?? "";
    if (!Number.isSafeInteger(time) || !/^[A-Za-z0-9_-]{16,64}$/.test(nonce) || !/^[A-Za-z0-9_-]{40,200}$/.test(signature)) {
      throw new HttpError(401, "簽章格式不對");
    }
    const now = nowMs();
    if (Math.abs(now - time) > SIGNATURE_WINDOW_MS) throw new HttpError(401, "裝置的時間不對", { state: "clock", serverTime: now });
    const message = signedMessage({ method: request.method, path: signedPath(url), device: deviceId, time, nonce, bodyHash: await bodyHash(text) });
    if (!(await verifySignature(signPub, message, signature))) throw new HttpError(403, "簽章不符");
    // 簽章對了才記亂數：別人送不出這台的亂數，也就塞不滿
    if (!(await store.useNonce(`${deviceId}.${nonce}`, now + 2 * SIGNATURE_WINDOW_MS))) throw new HttpError(401, "重複的請求");
  }

  /**
   * 誰在呼叫. 有 x-device 標頭的是登記過的裝置（要簽章）；沒有的是舊的憑證，只在沒有登記裝置的空間有效.
   * 換過金鑰的空間：留下的裝置拿到給它的新同步金鑰（state: moved），被移除的拿到證明（state: removed）
   */
  async function authenticate(request: Request, url: URL, space: string, text: string): Promise<Caller> {
    const deviceId = request.headers.get("x-device");
    if (deviceId !== null) {
      if (!DEVICE_ID.test(deviceId)) throw new HttpError(401, "裝置 id 格式不對");
      if ((await store.spaceToken(space)) === null) throw new HttpError(404, "同步空間不存在");
      const device = await store.device(space, deviceId);
      if (!device) throw new HttpError(403, "這台沒有登記在這個同步空間", { state: "unknown_device" });
      await checkSignature(request, url, text, deviceId, device.signPub);
      const move = await store.move(space);
      const signed = move ? { signer: move.signer, statement: move.statement, signature: move.signature } : {};
      if (device.removedAt !== null) throw new HttpError(410, "這台已從同步移除", { state: "removed", proof: device.proof, ...signed });
      if (move !== null) throw new HttpError(410, "同步金鑰已經換了", { state: "moved", space: move.movedTo, box: device.box, ...signed });
      await store.touchDevice(space, deviceId);
      return { kind: "device", device };
    }
    await checkToken(request, space);
    if ((await store.movedTo(space)) !== null) throw new HttpError(410, "這組同步金鑰已經換掉了", { state: "rekeyed" });
    if (await store.spaceMode(space)) throw new HttpError(403, "這個同步空間要用登記過的裝置", { state: "devices_required" });
    return { kind: "token" };
  }

  /** 加入未滿冷卻期的裝置不能移除別台、換金鑰、刪除雲端的資料 */
  // 升級前就在同步的也一樣：拿到復原碼的人也可能在升級的那幾天登記（「升級前就在同步」只是清單上的標示）
  function cooldownUntil(device: DeviceRow): number {
    return device.joinedAt + cooldownMs;
  }

  function requireCooldown(caller: Caller): void {
    if (caller.kind !== "device") return;
    const until = cooldownUntil(caller.device);
    if (nowMs() < until) throw new HttpError(403, "這台加入還不到 24 小時", { state: "cooldown", until });
  }

  function publicDevice(d: DeviceRow) {
    return { id: d.id, signPub: d.signPub, boxPub: d.boxPub, label: d.label, joinedAt: d.joinedAt, lastSeenAt: d.lastSeenAt, legacy: d.legacy };
  }

  async function deviceList(space: string, self: DeviceRow) {
    const devices = (await store.devices(space)).filter((d) => d.removedAt === null);
    return { devices: devices.map(publicDevice), self: self.id, cooldownUntil: cooldownUntil(self), serverTime: nowMs() };
  }

  /**
   * 登記這台：要有舊的憑證（證明知道同步金鑰：配對與用復原碼還原都會拿到）並用這台的私鑰簽章（證明持有）.
   * 空間第一次有裝置登記時升級成裝置模式；之後 3 天內用舊憑證登記的算「升級前就在同步」（不受冷卻期限制），
   * 因為升級前所有拿到同步金鑰的裝置本來就分不出來
   */
  async function register(request: Request, url: URL, space: string, text: string) {
    await checkToken(request, space);
    if ((await store.movedTo(space)) !== null) throw new HttpError(410, "這組同步金鑰已經換掉了", { state: "rekeyed" });
    const body = parseJson(text);
    const { id, signPub, boxPub } = body;
    const label = body.label;
    if (typeof id !== "string" || !DEVICE_ID.test(id)) throw new HttpError(400, "裝置 id 格式不對");
    if (!isP256Point(signPub) || !isP256Point(boxPub)) throw new HttpError(400, "公開金鑰格式不對");
    if (!isKey(label, MAX_LABEL)) throw new HttpError(400, "裝置紀錄格式不對");
    if (request.headers.get("x-device") !== id) throw new HttpError(401, "缺少這台的簽章");
    await checkSignature(request, url, text, id, signPub);
    const existing = await store.device(space, id);
    if (existing) {
      if (existing.signPub !== signPub || existing.boxPub !== boxPub || existing.removedAt !== null) throw new HttpError(409, "裝置 id 已經被使用");
      return deviceList(space, existing);
    }
    const now = nowMs();
    let mode = await store.spaceMode(space);
    if (!mode) {
      await store.setSpaceMode(space, { devicesAt: now, legacyUntil: now + LEGACY_WINDOW_MS });
      mode = await store.spaceMode(space);
    }
    const active = (await store.devices(space)).filter((d) => d.removedAt === null);
    if (active.length >= MAX_DEVICES) throw new HttpError(413, `一個同步空間最多 ${MAX_DEVICES} 台`);
    await store.addDevice(space, { id, signPub, boxPub, label: label as string, legacy: now < (mode?.legacyUntil ?? 0) });
    const added = await store.device(space, id);
    if (!added || added.signPub !== signPub) throw new HttpError(409, "裝置 id 已經被使用");
    return deviceList(space, added);
  }

  /**
   * 換金鑰. 換金鑰的那台先建立新的空間（裝置模式）、在新空間登記自己、把重新加密的資料送過去，最後才呼叫這裡：
   * 中途斷掉時什麼都沒換，下次重新來過. 檢查冷卻期、清單完整、簽過的聲明和這次的內容一致
   */
  async function rekey(space: string, caller: Caller, text: string) {
    if (caller.kind !== "device") throw new HttpError(403, "換金鑰要用登記過的裝置", { state: "devices_required" });
    requireCooldown(caller);
    // 剛換過金鑰的空間一分鐘內不能再換（不讓一台一直換、把服務的空間佔滿）
    const movedIn = await store.movedInAt(space);
    if (movedIn !== null && nowMs() - movedIn < 60_000) throw new HttpError(429, "剛換過金鑰，請等一分鐘再試", { state: "too_soon" });
    const body = parseJson(text);
    const newSpace = body.space;
    const token = body.token;
    if (typeof newSpace !== "string" || !SPACE.test(newSpace) || newSpace === space) throw new HttpError(400, "新的同步空間 id 格式不對");
    if (typeof token !== "string" || !/^[A-Za-z0-9_-]{40,64}$/.test(token)) throw new HttpError(400, "新的憑證格式不對");
    const keep = Array.isArray(body.keep) ? (body.keep as Record<string, unknown>[]) : null;
    const remove = Array.isArray(body.remove) ? (body.remove as Record<string, unknown>[]) : null;
    if (!keep || !remove) throw new HttpError(400, "keep 與 remove 要是陣列");
    const active = new Set((await store.devices(space)).filter((d) => d.removedAt === null).map((d) => d.id));
    const seen = new Set<string>();
    for (const k of keep) {
      if (typeof k?.id !== "string" || !active.has(k.id) || seen.has(k.id)) throw new HttpError(400, "留下的裝置不對");
      if (!isKey(k.label, MAX_LABEL) || typeof k.box !== "string" || !/^[A-Za-z0-9_.-]{1,1000}$/.test(k.box)) throw new HttpError(400, "留下的裝置的資料格式不對");
      seen.add(k.id);
    }
    for (const r of remove) {
      if (typeof r?.id !== "string" || !active.has(r.id) || seen.has(r.id)) throw new HttpError(400, "移除的裝置不對");
      if (r.proof !== null && !isKey(r.proof, 100)) throw new HttpError(400, "移除的證明格式不對");
      seen.add(r.id);
    }
    // 每台都要說清楚是留下還是移除：清單是舊的（中間有新裝置加入）就重來，不會默默漏掉
    if (seen.size !== active.size) throw new HttpError(409, "裝置清單已經變了，請重新整理再試", { state: "devices_changed" });
    if (!seen.has(caller.device.id) || remove.some((r) => r.id === caller.device.id)) throw new HttpError(400, "換金鑰的這台要留下");
    // 聲明要是這台簽的、內容和這次的一致（用戶端還會再檢查一次，這裡先擋掉亂送的）
    const statement = await verifyStatement(caller.device.signPub, body.statement, body.signature);
    const sameIds = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
    if (
      !statement ||
      statement.from !== space ||
      statement.to !== newSpace ||
      !sameIds(statement.keep, keep.map((k) => String(k.id))) ||
      !sameIds(statement.remove, remove.map((r) => String(r.id)))
    ) {
      throw new HttpError(400, "換金鑰的聲明不對");
    }
    // 新的空間：要是這台先建立的（憑證對得上、還沒搬過、裡面只有這台）
    const stored = await store.spaceToken(newSpace);
    if (stored === null) throw new HttpError(400, "新的同步空間還沒建立");
    if (stored !== (await sha256Hex(token)) || (await store.movedTo(newSpace)) !== null) throw new HttpError(409, "新的同步空間不能用", { state: "rekey_conflict" });
    if ((await store.devices(newSpace)).some((d) => d.id !== caller.device.id)) throw new HttpError(409, "新的同步空間不能用", { state: "rekey_conflict" });
    try {
      await store.rekey(space, {
        newSpace,
        caller: caller.device.id,
        keep: keep.map((k) => ({ id: String(k.id), label: String(k.label), box: String(k.box) })),
        remove: remove.map((r) => ({ id: String(r.id), proof: r.proof === null ? null : String(r.proof) })),
        statement: String(body.statement),
        signature: String(body.signature),
      });
    } catch {
      // 同時有另一台在換金鑰
      throw new HttpError(409, "換金鑰失敗：可能另一台剛換過，請重新整理再試", { state: "rekey_conflict" });
    }
    return { space: newSpace };
  }

  async function route(request: Request): Promise<Response | Record<string, unknown>> {
    const url = new URL(request.url);
    const parts = url.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
    const method = request.method;
    if (parts[0] !== "v1") throw new HttpError(404, "找不到");

    // /v1/spaces/:space[/changes|/devices[/:id[/label]]|/rekey]
    if (parts[1] === "spaces" && parts[2]) {
      const space = parts[2];
      if (!SPACE.test(space)) throw new HttpError(400, "同步空間的 id 格式不對");
      const text = await readText(request);
      // PUT：確認憑證；?create=1 時不存在就建立（只有「開始同步」的第一台會這樣做，
      // 其他時候空間不存在是 404，不會把已經刪除的空間默默建回來）. &devices=1：新的空間一開始就是裝置模式
      if (parts.length === 3 && method === "PUT") {
        const token = bearer(request);
        if (!token) throw new HttpError(401, "缺少憑證");
        const hash = await sha256Hex(token);
        const stored = await store.spaceToken(space);
        if (stored !== null) {
          if (stored !== hash) throw new HttpError(403, "憑證不符");
          if ((await store.movedTo(space)) !== null) throw new HttpError(410, "這組同步金鑰已經換掉了", { state: "rekeyed" });
          return { created: false };
        }
        if (url.searchParams.get("create") !== "1") throw new HttpError(404, "同步空間不存在");
        if ((await store.totals()).spaces >= limits.spaces) throw new HttpError(503, "同步服務已滿");
        const created = await store.createSpace(space, hash);
        if (!created && (await store.spaceToken(space)) !== hash) throw new HttpError(403, "憑證不符");
        if (created && url.searchParams.get("devices") === "1") await store.setSpaceMode(space, { devicesAt: nowMs(), legacyUntil: nowMs() });
        return { created };
      }
      if (parts[3] === "devices" && parts.length === 4 && method === "POST") return register(request, url, space, text);

      const caller = await authenticate(request, url, space, text);
      if (parts.length === 3 && method === "DELETE") {
        // 換金鑰沒有完成時，換金鑰的那台刪掉它剛建立、只有它自己的新空間：不受冷卻期限制
        const created = await store.spaceCreatedAt(space);
        const others = (await store.devices(space)).filter((d) => caller.kind !== "device" || d.id !== caller.device.id);
        const abandoned = caller.kind === "device" && others.length === 0 && created !== null && nowMs() - created < 3600_000;
        if (!abandoned) requireCooldown(caller);
        await store.deleteSpace(space);
        return { deleted: true };
      }
      if (parts[3] === "devices") {
        if (caller.kind !== "device") throw new HttpError(403, "這個同步空間還沒有登記裝置", { state: "devices_required" });
        if (parts.length === 4 && method === "GET") return deviceList(space, caller.device);
        const target = parts[4] ?? "";
        if (!DEVICE_ID.test(target)) throw new HttpError(400, "裝置 id 格式不對");
        // 任何一台都可以替任何一台改名（名稱以同步金鑰加密，伺服器看不到）
        if (parts.length === 6 && parts[5] === "label" && method === "PUT") {
          const label = parseJson(text).label;
          if (!isKey(label, MAX_LABEL)) throw new HttpError(400, "裝置紀錄格式不對");
          if (!(await store.setLabel(space, target, label))) throw new HttpError(404, "找不到這台");
          return { ok: true };
        }
        // 只能移除自己（停止這台的同步）；移除別台要換金鑰
        if (parts.length === 5 && method === "DELETE") {
          if (target !== caller.device.id) throw new HttpError(403, "移除別台要換金鑰");
          await store.deleteDevice(space, target);
          return { deleted: true };
        }
        throw new HttpError(405, "不支援的方法");
      }
      if (parts[3] === "rekey" && parts.length === 4 && method === "POST") return rekey(space, caller, text);
      if (parts[3] === "changes" && parts.length === 4 && method === "GET") {
        const since = Math.max(0, Number(url.searchParams.get("since")) || 0);
        const limit = Math.min(MAX_PULL, Math.max(1, Number(url.searchParams.get("limit")) || MAX_PULL));
        const items = await store.changes(space, since, limit);
        return { items, more: items.length === limit };
      }
      if (parts[3] === "changes" && parts.length === 4 && method === "POST") {
        const body = parseJson(text);
        const items = Array.isArray(body.items) ? body.items : null;
        if (!items || items.length > MAX_PUSH) throw new HttpError(400, `items 要是陣列，最多 ${MAX_PUSH} 筆`);
        const usage = await store.spaceUsage(space);
        const incoming = items.reduce((sum: number, item) => sum + String((item as Record<string, unknown>)?.blob ?? "").length, 0);
        if (usage.records + items.length > MAX_RECORDS || usage.bytes + incoming > MAX_BYTES) throw new HttpError(413, "同步空間已滿");
        if ((await store.totals()).bytes + incoming > limits.bytes) throw new HttpError(503, "同步服務已滿");
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
          const seq = await store.put(space, id, base, blob);
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
        const body = parseJson(await readText(request));
        if (!isKey(body.pub)) throw new HttpError(400, "pub 格式不對");
        if (!isKey(body.commitment, 100)) throw new HttpError(400, "commitment 格式不對");
        if ((await store.activeSlots()) >= limits.pairSlots) throw new HttpError(503, "暫時無法建立配對碼，請稍後再試");
        for (let attempt = 0; attempt < 5; attempt++) {
          const slot = [...random(8)].map((b) => SLOT_ALPHABET[b % 32]).join("");
          if (await store.createSlot(slot, body.pub, body.commitment, PAIR_TTL_MS)) return { slot, ttlSeconds: PAIR_TTL_MS / 1000 };
        }
        throw new HttpError(503, "暫時無法建立配對碼");
      }
      const slot = parts[2]?.toUpperCase();
      if (!slot || !SLOT.test(slot)) throw new HttpError(400, "配對碼格式不對");
      if (parts.length === 3 && method === "GET") {
        const found = await store.getSlot(slot);
        if (!found) throw new HttpError(404, "配對碼不存在或已過期");
        return { ...found };
      }
      if (parts.length === 3 && method === "DELETE") {
        await store.deleteSlot(slot);
        return { deleted: true };
      }
      if (parts.length === 4 && method === "POST" && (parts[3] === "hello" || parts[3] === "nonce" || parts[3] === "box")) {
        const body = parseJson(await readText(request));
        const value = parts[3] === "hello" ? body.pub : parts[3] === "nonce" ? body.nonce : body.box;
        if (!isKey(value, 4000)) throw new HttpError(400, "格式不對");
        const ok =
          parts[3] === "hello"
            ? await store.setSlotHello(slot, value)
            : parts[3] === "nonce"
              ? await store.setSlotNonce(slot, value)
              : await store.setSlotBox(slot, value);
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
      const extra = e instanceof HttpError ? e.extra : {};
      return new Response(JSON.stringify({ ...extra, error: message }), { status, headers });
    }
  };
}
