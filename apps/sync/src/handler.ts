/**
 * 同步服務的 HTTP 介面（規格 12.10）. 只經手加密後的資料：
 * - 同步空間：以同步金鑰導出的 id 與憑證存取；伺服器只存憑證的雜湊
 * - 配對：新裝置與舊裝置交換臨時公開金鑰與加密後的同步金鑰；以配對碼存取，十分鐘失效
 * - 裝置（規格 12.27）：空間有登記的裝置之後（裝置模式），每個請求要用那台自己的金鑰簽章，
 *   舊的憑證只能用來登記新裝置. 移除某台：馬上標成已移除（之後拒絕它），再換金鑰（可以跨好幾天）：
 *   留下的裝置搬到新的空間，舊空間只回答「搬到哪裡」與「已被移除」.
 *   沒有登記過裝置的空間照舊（舊版的用戶端）
 * 依來源限制建立空間、配對碼、配對的每一步與送出的頻率：同一個來源以好幾層計數（IPv6 的 /64、/56、/48，IPv4 的位址與 /24），
 * 每一層有自己的上限（IP 只以雜湊計數，時間窗過了就刪）；不記錄 IP、標頭或內容；回應不快取.
 * 建立同步空間與開配對碼之前要通過人機驗證（Turnstile，有設定時）. 整個服務每天估算寫入的列數，接近上限時先停止新的空間與配對.
 * 有內容的請求只接受 application/json.
 */
import { DEVICE_ID, isP256Point, SIGNATURE_WINDOW_MS, bodyHash, signedMessage, verifySignature, verifyStatement } from "@running-coach/core/device";

import {
  requestSourceLevels,
  sourceHasher,
  takeEntries,
  tieredEntries,
  type RateEntry,
  type RateLimiter,
  type RateRule,
  type SourceHasher,
  type SourceLevel,
  type SourceTier,
  type TieredRules,
} from "@running-coach/core/rate-limit";

import { RECORD_OVERHEAD, type DeviceRow, type SyncStore } from "./store";
import { HUMAN_HEADER, verifyTurnstile, type TurnstileConfig } from "./turnstile";

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
  /** 依來源的頻率限制；沒有給時不限制（本機的模擬服務） */
  rateLimiter?: RateLimiter;
  rateLimits?: Partial<SyncRateLimits>;
  /** 人機驗證（Turnstile）的設定；沒有給時不驗證（本機、模擬服務、E2E） */
  turnstile?: TurnstileConfig;
  /**
   * 整個服務每天（UTC）估算最多寫入幾列（Cloudflare 免費方案整個帳號每天 10 萬列，staging、正式、同步與代理共用）.
   * 用到一半時停止新的空間與配對碼，用完時連送出也停止（換金鑰的新空間不受一半的限制）. 沒有 rateLimiter 時不計
   */
  dailyWrites?: number;
  /** 只會收到數量（服務已滿、被限制的是哪一種），沒有 IP 或內容 */
  log?: (line: string) => void;
  /**
   * 來源與網段的代碼用的金鑰（Worker 的 secret RATE_LIMIT_HASH_KEY）：有的話用 HMAC，沒有金鑰算不出、也反推不回 IP.
   * 沒有給時（本機、模擬服務、測試）用沒有金鑰的雜湊. 換了金鑰之後，計數與網段的代碼都重新開始算
   */
  hashKey?: string;
}

/**
 * 每個來源的頻率限制（規格 12.10）：每一種、每一層（TieredRules）可以有好幾個時間窗.
 * 先只讀檢查每一層；有一條超過時這次都不算. 建立空間、開配對碼與配對的每一步，寬的層（/56、/48、IPv4 的 /24）
 * 只在通過人機驗證（或換金鑰的簽章）、配對碼存在時才算：同一段位址的鄰居不能不經驗證就把整段用完
 */
export interface SyncRateLimits {
  /** 建立同步空間（開始同步、換金鑰） */
  createSpace: TieredRules;
  /** 建立配對碼 */
  createPair: TieredRules;
  /** 查詢配對碼時找不到的次數；找得到的（等另一台時每 2 秒查一次）不算 */
  pairMiss: TieredRules;
  /** 配對的每一步：hello、nonce、box 與取消 */
  pairStep: TieredRules;
  /** 送出紀錄的次數 */
  push: TieredRules;
  /** 送出紀錄的位元組（內容加上每筆的固定額外；換金鑰的複製不算） */
  pushBytes: TieredRules;
  /** 每個來源每天估算的寫入列數；沒有給時照整個服務每天的上限（dailyWrites）乘上 SOURCE_WRITE_SHARE */
  writes?: TieredRules;
  /** 每個同步空間每天估算的寫入列數；沒有給時照 dailyWrites 乘上 SPACE_WRITE_SHARE */
  spaceWrites?: number;
  /** 每個同步空間每天送出的位元組；沒有給時 SPACE_DAILY_BYTES */
  spaceBytes?: number;
  /** 換金鑰的複製每天估算的寫入列數（整個服務一起）；沒有給時 dailyWrites 乘上 REKEY_WRITE_SHARE */
  rekeyWrites?: number;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 同一組規則套到 IPv6 與 IPv4 對應的層：narrow 是 /64 與 IPv4 的位址，wide 是 /56，widest 是 /48 與 IPv4 的 /24 */
const tiers = (narrow: Record<string, RateRule>, wide: Record<string, RateRule> | null, widest: Record<string, RateRule>): TieredRules => ({
  "v6/48": widest,
  ...(wide ? { "v6/56": wide } : {}),
  "v6/64": narrow,
  "v4/24": widest,
  "v4/32": narrow,
});

const per = (limit: number, windowMs: number): RateRule => ({ limit, windowMs });

/**
 * 預設的上限（規格 12.10 有理由）：一般人開始同步一兩次、配對幾次；同一個家庭、學校、手機網路共用一段位址時，
 * 寬的層讓好幾個人同時用也不受影響
 */
export const DEFAULT_RATE_LIMITS: SyncRateLimits = {
  createSpace: tiers({ hour: per(5, HOUR), day: per(10, DAY) }, { hour: per(10, HOUR), day: per(20, DAY) }, { hour: per(20, HOUR), day: per(40, DAY) }),
  createPair: tiers({ tenMinutes: per(10, 10 * MINUTE), day: per(30, DAY) }, { tenMinutes: per(15, 10 * MINUTE), day: per(60, DAY) }, { tenMinutes: per(20, 10 * MINUTE), day: per(100, DAY) }),
  pairMiss: tiers({ hour: per(20, HOUR) }, { hour: per(40, HOUR) }, { hour: per(60, HOUR) }),
  pairStep: tiers({ hour: per(30, HOUR) }, { hour: per(45, HOUR) }, { hour: per(60, HOUR) }),
  push: { "v6/64": { minute: per(120, MINUTE) }, "v4/32": { minute: per(120, MINUTE) } },
  pushBytes: tiers({ day: per(25_000_000, DAY) }, { day: per(40_000_000, DAY) }, { day: per(60_000_000, DAY) }),
};

/** 每個來源每天能用掉整個服務每天寫入額度（dailyWrites）的比例：/64 與 IPv4 的位址、/56、/48 與 IPv4 的 /24 */
export const SOURCE_WRITE_SHARE = { narrow: 0.1, wide: 0.15, widest: 0.2 };
/** 每個同步空間每天：送出的位元組、能用掉寫入額度的比例（換金鑰的複製不算） */
export const SPACE_DAILY_BYTES = 15_000_000;
export const SPACE_WRITE_SHARE = 0.1;
/** 每台裝置每天最多開幾次換金鑰的新空間（不用人機驗證的那條路；中途失敗重試也算） */
export const REKEY_CREATIONS_PER_DAY = 4;
/** 換金鑰的複製：新空間最多比舊空間多這麼多（重新加密的大小差一點），超過的照一般的送出計算 */
const REKEY_SLACK = { bytes: 1_000_000, records: 50 };
/**
 * 換金鑰的複製有自己的一份每日額度：整個服務每天寫入額度的 25%，從整個服務的額度切出來（一般的送出最多用剩下的 75%），
 * 用完不影響一般的送出、新空間與配對
 */
export const REKEY_WRITE_SHARE = 0.25;
/** 同一個舊空間每天最多複製幾筆：舊空間的筆數加上寬容（中途斷掉重試一次還夠）. 重開換金鑰不會讓複製量加倍 */
const rekeyCopyAllowance = (records: number) => records + Math.max(REKEY_SLACK.records, Math.ceil(records * 0.25));
const REKEY_WRITES_KEY = "sync:rekey-writes";
/**
 * 換到一半的新空間多久沒有進度就放棄（清掉）：每天的額度用完時隔天接著做，所以要保留好幾天；
 * 使用者一直沒有再打開換金鑰的那台時，不讓它一直佔著容量
 */
export const STALE_REKEY_MS = 7 * DAY;

/** 依來源計數的種類 */
type SourceKind = "createSpace" | "createPair" | "pairMiss" | "pairStep" | "push" | "pushBytes";

/** 窄的層：每個請求一定算；其他（寬的層）視情況 */
const NARROW_TIERS = new Set<SourceTier>(["v6/64", "v4/32", "unknown"]);
type TierScope = "all" | "narrow" | "wide";
const inScope = (levels: SourceLevel[], scope: TierScope) =>
  scope === "all" ? levels : levels.filter((l) => NARROW_TIERS.has(l.tier) === (scope === "narrow"));

const sourceWriteRules = (dailyWrites: number): TieredRules =>
  tiers(
    { day: per(Math.floor(dailyWrites * SOURCE_WRITE_SHARE.narrow), DAY) },
    { day: per(Math.floor(dailyWrites * SOURCE_WRITE_SHARE.wide), DAY) },
    { day: per(Math.floor(dailyWrites * SOURCE_WRITE_SHARE.widest), DAY) },
  );

/** 整個服務每天估算的寫入列數上限（正式；staging 由部署設定調小） */
export const DEFAULT_DAILY_WRITES = 40_000;
/** 用到這個比例後不再建立新的空間與配對碼，留給已經在同步的 */
const NEW_SHARE = 0.5;
/** 估算的寫入列數：建立空間（空間、裝置模式、登記這台與計數）、配對碼（配對碼的每一步與計數）、送出（每筆 3 列，加上計數、大小、簽章的亂數） */
const WRITE_COST = { space: 12, pair: 12, pushBase: 10, perRecord: 3 };
const WRITES_KEY = "sync:daily-writes";

/** 沒有紀錄也沒有登記裝置的空間，建立多久之後清掉 */
export const EMPTY_SPACE_TTL_MS = DAY;

export interface ServiceLimits {
  spaces: number;
  bytes: number;
  pairSlots: number;
  /** 同一個網段（IPv4 的 /24、IPv6 的 /48）建立的同步空間加起來最多多大 */
  networkBytes: number;
}

/**
 * 整個服務的上限：Cloudflare 免費方案每個 D1 最多 500 MB，總容量留下約 200 MB 給簽章的亂數、頻率限制的計數、索引與換金鑰時的暫存.
 * bytes 算的是每筆的內容加上每筆的固定額外（RECORD_OVERHEAD）
 */
export const DEFAULT_LIMITS: ServiceLimits = { spaces: 500, bytes: 300_000_000, pairSlots: 200, networkBytes: 50_000_000 };

/**
 * 建立者的網段（IPv4 的 /24、IPv6 的 /48）的代碼：同一個網段建立的空間有總容量上限. 不存原始的位址；
 * 沒有 IP 時（本機的 Node 版）null，不限. 代碼保存 NETWORK_RETENTION_MS（maintain 清掉）
 */
async function networkOf(request: Request, hash: SourceHasher): Promise<string | null> {
  const level = requestSourceLevels(request).find((l) => l.tier === "v4/24" || l.tier === "v6/48");
  return level ? hash(`sync-network:${level.source}`) : null;
}

/** 網段的代碼保存多久：之後清成 NULL，那個空間不再算進網段的總容量 */
export const NETWORK_RETENTION_MS = 30 * 24 * 3600_000;

/** 單筆紀錄的上限（base64url 的長度，約 1 MB） */
const MAX_BLOB = 1_400_000;
/** 一次請求的上限 */
const MAX_BODY = 4_000_000;
const MAX_PUSH = 200;
const MAX_PULL = 500;
/** 每個同步空間的上限（紀錄的內容加上每筆的固定額外）：重度使用約一年 4,000 筆、5 MB，可以用好幾年 */
export const MAX_SPACE_BYTES = 25_000_000;
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
  const rateLimits = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits };
  const log = deps.log ?? (() => undefined);
  const hashCode = sourceHasher(deps.hashKey);

  const rateLimited = (waitMs: number, what: string): HttpError => {
    log(`rate limited: ${what}`);
    return new HttpError(429, "太頻繁了，請稍後再試", { state: "rate_limited", retryAfter: Math.max(1, Math.ceil(waitMs / 1000)) });
  };
  const windowLeft = (rule: RateRule) => {
    const now = nowMs();
    return (Math.floor(now / rule.windowMs) + 1) * rule.windowMs - now;
  };

  async function sourceEntries(request: Request, kinds: SourceKind[], weights: number[], scope: TierScope): Promise<RateEntry[]> {
    const levels = inScope(requestSourceLevels(request), scope);
    return (await Promise.all(kinds.map((kind, i) => tieredEntries(`sync:${kind}`, levels, rateLimits[kind], weights[i] ?? 1, hashCode)))).flat();
  }

  /**
   * 這個來源（scope 的那幾層）這次還在限制內嗎；超過時回 429（state: rate_limited，retryAfter 是要等幾秒）.
   * 好幾種一起檢查（一個查詢先讀，都沒超過才加）；weights 是每一種這次要加多少（預設 1）
   */
  async function limitSource(request: Request, kinds: SourceKind[], weights: number[] = [], scope: TierScope = "all"): Promise<void> {
    if (!deps.rateLimiter) return;
    const waitMs = await takeEntries(deps.rateLimiter, await sourceEntries(request, kinds, weights, scope), 1, nowMs());
    if (waitMs !== null) throw rateLimited(waitMs, kinds.join(","));
  }

  /** 只查不加：這個來源（每一層）的額度用完時回 429. 查配對碼時先看（用完的不讓它知道配對碼存不存在）；建立前先看寬的層 */
  async function requireSourceRoom(request: Request, kinds: SourceKind[], weights: number[] = []): Promise<void> {
    if (!deps.rateLimiter?.firstOver) return;
    const entries = await sourceEntries(request, kinds, weights, "all");
    const over = await deps.rateLimiter.firstOver(entries);
    if (over >= 0) throw rateLimited(windowLeft(entries[over]!.rule), kinds.join(","));
  }

  /** 加上計數；之後請求沒有用到時可以退回（寫入失敗、衝突） */
  async function takeRefundable(entries: RateEntry[], what: string): Promise<(weight?: number) => Promise<void>> {
    if (!deps.rateLimiter || entries.length === 0) return async () => undefined;
    const limiter = deps.rateLimiter;
    const waitMs = await takeEntries(limiter, entries, 1, nowMs());
    if (waitMs !== null) throw rateLimited(waitMs, what);
    return refunder(entries);
  }

  /** 退回 entries 加上的計數；weight 是要退多少（預設全部，每一條最多退回它自己加上的） */
  function refunder(entries: RateEntry[]): (weight?: number) => Promise<void> {
    const left = entries.map((e) => e.weight ?? 1);
    return async (weight?: number) => {
      const limiter = deps.rateLimiter;
      if (!limiter?.release) return;
      for (const [i, e] of entries.entries()) {
        const back = Math.min(left[i]!, weight ?? left[i]!);
        if (back <= 0) continue;
        left[i]! -= back;
        await limiter.release(e.key, e.rule, back).catch(() => undefined);
      }
    };
  }

  const dailyWrites = deps.dailyWrites ?? DEFAULT_DAILY_WRITES;
  const writeRules = deps.rateLimits?.writes ?? sourceWriteRules(dailyWrites);
  const spaceWrites = deps.rateLimits?.spaceWrites ?? Math.floor(dailyWrites * SPACE_WRITE_SHARE);
  const spaceBytes = deps.rateLimits?.spaceBytes ?? SPACE_DAILY_BYTES;
  const rekeyWrites = deps.rateLimits?.rekeyWrites ?? Math.floor(dailyWrites * REKEY_WRITE_SHARE);
  const untilMidnight = () => {
    const now = nowMs();
    return Math.max(1, Math.ceil(((Math.floor(now / DAY) + 1) * DAY - now) / 1000));
  };
  const rekeyLimited = () => {
    log("sync rekey copy limit");
    return new HttpError(503, "今天換金鑰的量已達上限，明天接著做", { state: "rekey_limit", retryAfter: untilMidnight() });
  };
  /** 換金鑰的複製這兩條計數：整個服務的那一份（列數）與這個舊空間今天的（筆數） */
  const rekeyEntries = (from: string, fromRecords: number, writes: number, records: number): RateEntry[] => [
    { key: REKEY_WRITES_KEY, rule: per(rekeyWrites, DAY), weight: writes },
    { key: `sync:rekey-copy:${from}`, rule: per(rekeyCopyAllowance(fromRecords), DAY), weight: records },
  ];

  /** 換金鑰的複製：扣自己的那一份與這個舊空間今天的；超過時 503（rekey_limit）. 回傳退回沒有寫入的（列數、筆數） */
  async function spendRekeyCopy(from: string, records: number): Promise<(writes: number, records: number) => Promise<void>> {
    const limiter = deps.rateLimiter;
    if (!limiter || records <= 0) return async () => undefined;
    const fromRecords = (await store.spaceUsage(from)).records;
    const entries = rekeyEntries(from, fromRecords, WRITE_COST.pushBase + WRITE_COST.perRecord * records, records);
    if ((await takeEntries(limiter, entries, 1, nowMs())) !== null) throw rekeyLimited();
    const [writesBack, recordsBack] = [refunder([entries[0]!]), refunder([entries[1]!])];
    return async (w, r) => {
      await writesBack(w);
      await recordsBack(r);
    };
  }

  /**
   * 整個服務今天（UTC）估算的寫入列數. fresh：新的空間或配對碼，只能用到一半；其他（送出、換金鑰的新空間）可以用到上限.
   * 超過時回 503（state: daily_limit，retryAfter 是到 UTC 午夜的秒數）.
   * 每個來源（每一層）、每個空間（space）也只能用掉一小部分：超過時回 429（state: rate_limited）.
   * 換金鑰的複製不走這裡（spendRekeyCopy）. 回傳的函式退回沒有用到的列數（寫入失敗、衝突）
   */
  async function spendWrites(
    request: Request,
    weight: number,
    fresh: boolean,
    opts: { space?: string } = {},
  ): Promise<(weight?: number) => Promise<void>> {
    const limiter = deps.rateLimiter;
    if (!limiter || weight <= 0) return async () => undefined;
    const own: RateEntry[] = [
      ...(await tieredEntries("sync:writes", requestSourceLevels(request), writeRules, weight, hashCode)),
      ...(opts.space ? [{ key: `sync:space-writes:${opts.space}`, rule: per(spaceWrites, DAY), weight }] : []),
    ];
    if (own.length && limiter.firstOver) {
      const over = await limiter.firstOver(own);
      if (over >= 0) throw rateLimited(windowLeft(own[over]!.rule), "writes");
    }
    // 一般的寫入最多用到扣掉換金鑰那一份的量；新的空間與配對碼只能用到一半
    const global: RateEntry = {
      key: WRITES_KEY,
      rule: { limit: fresh ? Math.min(Math.floor(dailyWrites * NEW_SHARE), dailyWrites - rekeyWrites) : dailyWrites - rekeyWrites, windowMs: DAY },
      weight,
    };
    if (!(await limiter.take(global.key, global.rule, weight))) {
      log(`sync daily writes limit: ${fresh ? "new spaces and pairing" : "all writes"}`);
      const now = nowMs();
      throw new HttpError(503, "今天的同步量已達上限，明天會恢復", { state: "daily_limit", retryAfter: Math.max(1, Math.ceil(((Math.floor(now / DAY) + 1) * DAY - now) / 1000)) });
    }
    const waitMs = await takeEntries(limiter, own, 1, nowMs());
    if (waitMs !== null) {
      await limiter.release?.(global.key, global.rule, weight);
      throw rateLimited(waitMs, "writes");
    }
    return refunder([global, ...own]);
  }

  /** 人機驗證（有設定 Turnstile 時）：建立同步空間與開配對碼之前 */
  async function requireHuman(request: Request, action: "create-space" | "pair"): Promise<void> {
    // 沒有設定時不驗證；有開但 secret 沒有設定好時 verifyTurnstile 回 unavailable（503），不會默默跳過
    if (!deps.turnstile) return;
    const result = await verifyTurnstile(deps.turnstile, request.headers.get(HUMAN_HEADER), action);
    if (result === "ok") return;
    log(`human check: ${result}`);
    if (result === "unavailable") throw new HttpError(503, "人機驗證暫時無法使用，請稍後再試", { state: "human_check_unavailable" });
    throw new HttpError(403, result === "missing" ? "需要人機驗證" : "人機驗證沒有通過", { state: "human_check", reason: result });
  }

  function corsHeaders(request: Request): Record<string, string> {
    const origin = request.headers.get("origin");
    if (!origin) return {};
    if (!deps.allowedOrigins.includes("*") && !deps.allowedOrigins.includes(origin)) return {};
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
      "access-control-allow-headers": `authorization, content-type, x-device, x-time, x-nonce, x-signature, ${HUMAN_HEADER}`,
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
      // 換金鑰完成之前就先移除的：附移除當時簽的聲明（換好之後的聲明不會列出它）
      if (device.removedAt !== null) throw new HttpError(410, "這台已從同步移除", { state: "removed", proof: device.proof, ...signed, ...(device.removal ?? {}) });
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
   * 換金鑰建立新的空間時（?from=舊空間）：呼叫的是舊空間裡登記過、過了冷卻期的那台（用它的金鑰簽這個請求）→ 回傳那台的 id.
   * 這時新的空間不用人機驗證、不受整個服務的空間數限制，但同一個舊空間同時只有一個換到一半的新空間（一換一：
   * 已經有一個時回 409 rekey_pending，用戶端接著做那一個；?replace=1 才刪掉它重新開始），每台每天最多開
   * REKEY_CREATIONS_PER_DAY 次. 條件不符時回傳 null，照一般的建立
   */
  async function rekeyCreation(request: Request, url: URL, from: string, space: string, text: string): Promise<string | null> {
    if (!SPACE.test(from) || from === space) throw new HttpError(400, "舊的同步空間 id 格式不對");
    const deviceId = request.headers.get("x-device");
    if (deviceId === null || !DEVICE_ID.test(deviceId)) return null;
    const device = await store.device(from, deviceId);
    if (!device || device.removedAt !== null || (await store.movedTo(from)) !== null) return null;
    await checkSignature(request, url, text, deviceId, device.signPub);
    return nowMs() >= cooldownUntil(device) ? deviceId : null;
  }

  /**
   * 登記這台：要有舊的憑證（證明知道同步金鑰：配對與用復原碼還原都會拿到）並用這台的私鑰簽章（證明持有）.
   * 空間第一次有裝置登記時升級成裝置模式；之後 3 天內用舊憑證登記的算「升級前就在同步」（不受冷卻期限制），
   * 因為升級前所有拿到同步金鑰的裝置本來就分不出來
   */
  async function register(request: Request, url: URL, space: string, text: string) {
    await checkToken(request, space);
    if ((await store.movedTo(space)) !== null) throw new HttpError(410, "這組同步金鑰已經換掉了", { state: "rekeyed" });
    const body0 = parseJson(text);
    // 換金鑰還沒完成時不能加入新的裝置：被移除的那台（或只拿到舊復原碼的人）知道舊的同步金鑰，
    // 不能用一個新的裝置 id 再登記回來；換到一半時加入的也不會在使用者確認過的清單裡
    if (typeof body0.id === "string" && !(await store.device(space, body0.id)) && ((await store.pendingRekey(space)) !== null || (await store.hasEarlyRemovals(space)))) {
      throw new HttpError(409, "正在換新的同步金鑰，換好之後才能加入新的裝置", { state: "rekey_pending" });
    }
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
   * 換金鑰. 換金鑰的那台先建立新的空間（裝置模式）、在新空間登記自己、把重新加密的資料送過去（可以跨好幾天），最後才呼叫這裡：
   * 中途斷掉時什麼都沒換，之後接著做. 檢查冷卻期、清單完整、簽過的聲明和這次的內容一致；
   * seq：新空間已經有舊空間到這個序號的資料，舊空間之後又有新的寫入時回 409 rekey_behind（用戶端補送後再試）
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
    const copiedSeq = body.seq === undefined ? null : body.seq;
    if (copiedSeq !== null && (typeof copiedSeq !== "number" || !Number.isSafeInteger(copiedSeq) || copiedSeq < 0)) throw new HttpError(400, "seq 格式不對");
    const behind = () => new HttpError(409, "換金鑰的這段時間舊的空間又有新的資料，補送後再試", { state: "rekey_behind", seq: copiedSeq });
    if (copiedSeq !== null && (await store.maxSeq(space)) > copiedSeq) throw behind();
    try {
      await store.rekey(space, {
        newSpace,
        caller: caller.device.id,
        keep: keep.map((k) => ({ id: String(k.id), label: String(k.label), box: String(k.box) })),
        remove: remove.map((r) => ({ id: String(r.id), proof: r.proof === null ? null : String(r.proof) })),
        statement: String(body.statement),
        signature: String(body.signature),
        copiedSeq,
      });
    } catch {
      // 檢查之後、交易之前舊空間又有寫入
      if (copiedSeq !== null && (await store.maxSeq(space)) > copiedSeq && (await store.movedTo(space)) === null) throw behind();
      // 同時有另一台在換金鑰
      throw new HttpError(409, "換金鑰失敗：可能另一台剛換過，請重新整理再試", { state: "rekey_conflict" });
    }
    return { space: newSpace };
  }

  /**
   * 移除別台（馬上生效，規格 12.10）：換金鑰完成之前，伺服器先把它們標成已移除，之後拒絕它們的讀寫；
   * 它們下次連線拿到移除的證明與這台簽的聲明（from 舊空間、to 換到一半的新空間、keep 只有這台、remove 是它們）.
   * 條件和換金鑰一樣：舊空間裡登記過、過了冷卻期的裝置簽章；要先有換到一半的新空間（移除之後一定接著換金鑰）
   */
  async function removeEarly(space: string, caller: Caller, text: string) {
    if (caller.kind !== "device") throw new HttpError(403, "移除別台要用登記過的裝置", { state: "devices_required" });
    requireCooldown(caller);
    const body = parseJson(text);
    const newSpace = body.space;
    const remove = Array.isArray(body.remove) ? (body.remove as Record<string, unknown>[]) : null;
    if (typeof newSpace !== "string" || !SPACE.test(newSpace)) throw new HttpError(400, "新的同步空間 id 格式不對");
    if (!remove || remove.length === 0 || remove.length > MAX_DEVICES) throw new HttpError(400, "remove 要是陣列");
    if ((await store.rekeyFrom(newSpace)) !== space || (await store.movedInAt(newSpace)) !== null || (await store.pendingRekey(space)) !== newSpace) {
      throw new HttpError(409, "換到一半的新空間不在了，請重新開始", { state: "rekey_conflict" });
    }
    if ((await store.devices(newSpace)).some((d) => d.id !== caller.device.id)) throw new HttpError(409, "新的同步空間不能用", { state: "rekey_conflict" });
    const active = new Set((await store.devices(space)).filter((d) => d.removedAt === null).map((d) => d.id));
    const seen = new Set<string>();
    for (const r of remove) {
      if (typeof r?.id !== "string" || !active.has(r.id) || seen.has(r.id) || r.id === caller.device.id) throw new HttpError(400, "移除的裝置不對");
      if (r.proof !== null && !isKey(r.proof, 100)) throw new HttpError(400, "移除的證明格式不對");
      seen.add(r.id);
    }
    const statement = await verifyStatement(caller.device.signPub, body.statement, body.signature);
    if (
      !statement ||
      statement.from !== space ||
      statement.to !== newSpace ||
      statement.keep.length !== 1 ||
      statement.keep[0] !== caller.device.id ||
      [...statement.remove].sort().join() !== [...seen].sort().join()
    ) {
      throw new HttpError(400, "移除的聲明不對");
    }
    await store.removeDevices(
      space,
      remove.map((r) => ({ id: String(r.id), proof: r.proof === null ? null : String(r.proof) })),
      { signer: caller.device.id, statement: String(body.statement), signature: String(body.signature) },
    );
    return deviceList(space, caller.device);
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
        const from = url.searchParams.get("from");
        // 先只讀檢查每一層（被寬的層擋下時不會用掉窄的），再算窄的層；寬的層等通過人機驗證（或換金鑰的簽章）之後才算
        await requireSourceRoom(request, ["createSpace"]);
        // 換金鑰的簽章先檢查（時間不對時用戶端校正後重送，不重複計數）
        const rekeyDevice = from !== null ? await rekeyCreation(request, url, from, space, text) : null;
        const rekeyFrom = rekeyDevice !== null ? from : null;
        // 已經有換到一半的：接著做那一個（不算這次的次數）
        const pendingConflict = () => new HttpError(409, "已經有一個換到一半的換金鑰", { state: "rekey_pending" });
        if (rekeyFrom !== null && url.searchParams.get("replace") !== "1" && (await store.pendingRekey(rekeyFrom)) !== null) throw pendingConflict();
        await limitSource(request, ["createSpace"], [], "narrow");
        if (rekeyDevice !== null && deps.rateLimiter) {
          // 換金鑰的新空間：舊空間裡過了冷卻期的裝置簽過，不用人機驗證，也不受「新空間只能用到一半」的限制；每台每天有次數上限
          const rule = per(REKEY_CREATIONS_PER_DAY, DAY);
          if (!(await deps.rateLimiter.take(`sync:rekey-create:${rekeyDevice}`, rule))) throw rateLimited(windowLeft(rule), "rekey");
        }
        // 換金鑰的複製可以跨好幾天（每天的額度用完時隔天接著做），所以不用先確認今天搬得完
        if (rekeyFrom === null) await requireHuman(request, "create-space");
        await limitSource(request, ["createSpace"], [], "wide");
        const refund = await spendWrites(request, WRITE_COST.space, rekeyFrom === null);
        let created = false;
        try {
          if (rekeyFrom !== null) {
            // 同一個舊空間只有一個換到一半的新空間：已經有一個時接著做那一個（409 rekey_pending）；
            // 使用者選了重新開始（?replace=1）才刪掉它. 複製的額度算在舊空間上，重新開始不會讓複製量變多
            if (url.searchParams.get("replace") === "1") await store.abandonPendingRekeys(rekeyFrom, space);
            else if ((await store.pendingRekey(rekeyFrom)) !== null) throw pendingConflict();
            created = await store.createSpace(space, hash, limits.spaces, rekeyFrom);
            if (!created && (await store.spaceToken(space)) === null) {
              throw new HttpError(409, "同時有另一個換金鑰在進行，請稍後再試", { state: "rekey_conflict" });
            }
          } else {
            const network = await networkOf(request, hashCode);
            created = await store.createSpace(space, hash, limits.spaces, null, network);
            if (!created && (await store.spaceToken(space)) === null) {
              // 服務已滿：先清掉沒在用的空空間再試一次
              if ((await store.purgeEmptySpaces(EMPTY_SPACE_TTL_MS)) > 0) created = await store.createSpace(space, hash, limits.spaces, null, network);
              if (!created && (await store.spaceToken(space)) === null) {
                log(`sync service full: spaces >= ${limits.spaces}`);
                throw new HttpError(503, "同步服務已滿");
              }
            }
          }
          if (!created && (await store.spaceToken(space)) !== hash) throw new HttpError(403, "憑證不符");
        } finally {
          // 沒有建立（失敗，或並行的同一個請求已經建好）：這次的寫入額度退回
          if (!created) await refund();
        }
        if (created && url.searchParams.get("devices") === "1") await store.setSpaceMode(space, { devicesAt: nowMs(), legacyUntil: nowMs() });
        return { created };
      }
      if (parts[3] === "devices" && parts.length === 4 && method === "POST") return register(request, url, space, text);

      const caller = await authenticate(request, url, space, text);
      if (parts.length === 3 && method === "DELETE") {
        const created = await store.spaceCreatedAt(space);
        const others = (await store.devices(space)).filter((d) => caller.kind !== "device" || d.id !== caller.device.id);
        const movedIn = await store.movedInAt(space);
        const fresh = caller.kind === "device" && others.length === 0 && created !== null && nowMs() - created < 3600_000;
        // ?abandon=1：換金鑰沒有完成時，換金鑰的那台放棄它剛建立的新空間. 只刪這一個、不受冷卻期限制；
        // 換金鑰已經完成（有空間搬進來）時拒絕，不會連帶刪掉舊的空間
        if (url.searchParams.get("abandon") === "1") {
          if (movedIn !== null) throw new HttpError(409, "換金鑰已經完成，不能放棄", { state: "rekey_done" });
          if (caller.kind !== "device" || (!fresh && (await store.rekeyFrom(space)) === null)) throw new HttpError(403, "這個同步空間不是換到一半的新空間");
          await store.deleteSingleSpace(space);
          return { deleted: true };
        }
        // 刪除雲端的資料（連同換金鑰之前的舊空間）：剛換過金鑰的空間不走放棄的捷徑，換好 10 分鐘內也不能刪
        // （舊版的用戶端在換金鑰的結果不明時會送這個）
        if (movedIn !== null && nowMs() - movedIn < 10 * 60_000) throw new HttpError(429, "剛換過金鑰，請稍後再試", { state: "too_soon" });
        if (!(fresh && movedIn === null)) requireCooldown(caller);
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
      if (parts[3] === "remove" && parts.length === 4 && method === "POST") return removeEarly(space, caller, text);
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
        await limitSource(request, ["push"]);
        // 格式不對的整批不寫，也不算位元組與寫入的額度
        const valid = validItems(items);
        const sizeOf = (item: { blob: string }) => item.blob.length + RECORD_OVERHEAD;
        // 這次最多會用到的空間：內容加上每筆的固定額外（更新已經有的那筆時，寫完會照實際的還回去）
        const incoming = valid.reduce((sum, item) => sum + sizeOf(item), 0);
        // 換金鑰的複製（還沒換完的新空間，量不超過舊空間）：不算來源與空間每天的位元組與寫入（只算整個服務的），
        // 整個服務的總量可以暫時多用一個空間的量（舊空間的資料換好就刪掉）
        const copyFrom = await rekeyCopy(space, incoming, valid.length);
        const copy = copyFrom !== null;
        // 先保留這次最多會用到的位元組（這個空間、整個服務、同一個網段建立的空間都放得下才保留），寫完再還回去.
        // 換金鑰的複製不受網段的上限（量不超過舊空間，舊空間的資料換好就刪掉）
        const networkCap = copy ? null : limits.networkBytes;
        if (!(await store.reserveBytes(space, incoming, MAX_SPACE_BYTES, limits.bytes, networkCap))) {
          if ((await store.spaceUsage(space)).bytes + incoming > MAX_SPACE_BYTES) throw new HttpError(413, "同步空間已滿");
          const network = networkCap === null ? null : await store.networkUsage(space);
          if (network !== null && networkCap !== null && network + incoming > networkCap) {
            log(`sync network full`);
            throw new HttpError(413, "這個網路建立的同步空間已達總容量", { state: "network_full" });
          }
          if (!copy || !(await store.reserveBytes(space, incoming, MAX_SPACE_BYTES, limits.bytes + MAX_SPACE_BYTES, null))) {
            log(`sync service full: bytes`);
            throw new HttpError(503, "同步服務已滿");
          }
        }
        const none = async () => undefined;
        let refundBytes: (weight?: number) => Promise<void> = none;
        let refundWrites: (weight?: number) => Promise<void> = none;
        let refundCopy: (writes: number, records: number) => Promise<void> = none;
        let result: Awaited<ReturnType<SyncStore["putMany"]>>;
        try {
          if (!copy && incoming > 0) {
            const bytesEntries = [
              ...(await sourceEntries(request, ["pushBytes"], [incoming], "all")),
              { key: `sync:space-bytes:${space}`, rule: per(spaceBytes, DAY), weight: incoming },
            ];
            refundBytes = await takeRefundable(bytesEntries, "pushBytes");
          }
          if (valid.length > 0) {
            if (copyFrom !== null) refundCopy = await spendRekeyCopy(copyFrom, valid.length);
            else refundWrites = await spendWrites(request, WRITE_COST.pushBase + WRITE_COST.perRecord * valid.length, false, { space });
          }
          result = await store.putMany(space, valid, incoming);
          if (copy && result.applied.length > 0) await store.touchRekeyProgress(space);
        } catch (e) {
          await store.releaseBytes(space, incoming).catch(() => undefined);
          await refundBytes();
          await refundWrites();
          await refundCopy(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER);
          throw e;
        }
        // 沒有寫入的（衝突、同一批重複的 id）退回位元組與寫入的額度
        const applied = new Set(result.applied.map((a) => a.id));
        const counted = new Set<string>();
        let unusedBytes = 0;
        let unusedRecords = 0;
        for (const item of valid) {
          if (applied.has(item.id) && !counted.has(item.id)) {
            counted.add(item.id);
            continue;
          }
          unusedBytes += sizeOf(item);
          unusedRecords += 1;
        }
        if (unusedRecords > 0) {
          await refundBytes(unusedBytes);
          // 整批都沒有寫入時連固定的部分也退回
          await refundWrites(WRITE_COST.perRecord * unusedRecords + (applied.size === 0 ? WRITE_COST.pushBase : 0));
          await refundCopy(WRITE_COST.perRecord * unusedRecords + (applied.size === 0 ? WRITE_COST.pushBase : 0), unusedRecords);
        }
        return result;
      }
      throw new HttpError(405, "不支援的方法");
    }

    // /v1/pair[/:slot[/hello|/nonce|/box]]
    if (parts[1] === "pair") {
      return pairRoute(request, parts, method);
    }

    throw new HttpError(404, "找不到");
  }

  /**
   * 這次送出是換金鑰的複製嗎：還沒換完的新空間（換金鑰建立的、還沒有空間搬進來），送完之後的大小與筆數不超過舊空間（加一點寬容）.
   * 是的話回傳舊空間. 新空間是舊空間裡過了冷卻期的裝置簽過才建立的、同一個舊空間同時只有一個；
   * 複製扣自己的每日額度與這個舊空間每天的筆數（spendRekeyCopy），重開換金鑰不會讓複製量加倍
   */
  async function rekeyCopy(space: string, incoming: number, records: number): Promise<string | null> {
    const from = await store.rekeyFrom(space);
    if (from === null || (await store.movedInAt(space)) !== null) return null;
    const [source, mine] = [await store.spaceUsage(from), await store.spaceUsage(space)];
    return mine.bytes + incoming <= source.bytes + REKEY_SLACK.bytes && mine.records + records <= source.records + REKEY_SLACK.records ? from : null;
  }

  /** 先檢查整批的格式，有一筆不對就整批不寫 */
  function validItems(items: unknown[]): { id: string; base: number; blob: string }[] {
    return items.map((raw) => {
      const item = raw as Record<string, unknown>;
      const { id, base, blob } = item ?? {};
      if (typeof id !== "string" || !RECORD_ID.test(id)) throw new HttpError(400, "紀錄 id 格式不對");
      if (typeof base !== "number" || !Number.isInteger(base) || base < 0) throw new HttpError(400, "base 要是非負整數");
      if (typeof blob !== "string" || blob.length > MAX_BLOB || !BASE64URL.test(blob)) throw new HttpError(400, "blob 格式不對或太大");
      return { id, base, blob };
    });
  }

  async function pairRoute(request: Request, parts: string[], method: string): Promise<Record<string, unknown>> {
    if (parts.length === 2 && method === "POST") {
      const body = parseJson(await readText(request));
      if (!isKey(body.pub)) throw new HttpError(400, "pub 格式不對");
      if (!isKey(body.commitment, 100)) throw new HttpError(400, "commitment 格式不對");
      // 寬的層等通過人機驗證之後才算（先只讀檢查，被寬的層擋下時不會用掉窄的）
      await requireSourceRoom(request, ["createPair"]);
      await limitSource(request, ["createPair"], [], "narrow");
      await requireHuman(request, "pair");
      await limitSource(request, ["createPair"], [], "wide");
      const refund = await spendWrites(request, WRITE_COST.pair, true);
      for (let attempt = 0; attempt < 5; attempt++) {
        const slot = [...random(8)].map((b) => SLOT_ALPHABET[b % 32]).join("");
        if (await store.createSlot(slot, body.pub, body.commitment, PAIR_TTL_MS, limits.pairSlots)) return { slot, ttlSeconds: PAIR_TTL_MS / 1000 };
        if ((await store.activeSlots()) >= limits.pairSlots) {
          await refund();
          log(`sync service full: pair slots >= ${limits.pairSlots}`);
          throw new HttpError(503, "暫時無法建立配對碼，請稍後再試");
        }
      }
      await refund();
      throw new HttpError(503, "暫時無法建立配對碼");
    }
    const slot = parts[2]?.toUpperCase();
    if (!slot || !SLOT.test(slot)) throw new HttpError(400, "配對碼格式不對");
    if (parts.length === 3 && method === "GET") {
      // 找不到的次數用完時，這個來源查任何配對碼都回 429；找得到的不算，等另一台時每 2 秒查一次
      await requireSourceRoom(request, ["pairMiss"]);
      const found = await store.getSlot(slot);
      if (!found) {
        await limitSource(request, ["pairMiss"]);
        throw new HttpError(404, "配對碼不存在或已過期");
      }
      return { ...found };
    }
    // 配對的每一步：窄的層每次都算；寬的層只在配對碼存在、這一步的順序對時才算（每個配對碼最多幾次，而開配對碼要通過人機驗證）
    const countStep = async (valid: boolean) => {
      if (valid) await requireSourceRoom(request, ["pairStep"]);
      await limitSource(request, ["pairStep"], [], "narrow");
      if (valid) await limitSource(request, ["pairStep"], [], "wide");
    };
    if (parts.length === 3 && method === "DELETE") {
      await countStep((await store.getSlot(slot)) !== null);
      await store.deleteSlot(slot);
      return { deleted: true };
    }
    if (parts.length === 4 && method === "POST" && (parts[3] === "hello" || parts[3] === "nonce" || parts[3] === "box")) {
      const current = await store.getSlot(slot);
      const inOrder =
        current !== null &&
        (parts[3] === "hello" ? current.oldPub === null : parts[3] === "nonce" ? current.oldPub !== null && current.nonce === null : current.nonce !== null && current.box === null);
      await countStep(inOrder);
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

  return async (request) => {
    const cors = corsHeaders(request);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const headers = { ...cors, "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };
    try {
      requireJson(request);
      const body = await route(request);
      return new Response(JSON.stringify(body), { status: 200, headers });
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      const message = e instanceof HttpError ? e.message : "伺服器錯誤";
      const extra = e instanceof HttpError ? e.extra : {};
      const retry: Record<string, string> = typeof extra.retryAfter === "number" ? { "retry-after": String(extra.retryAfter) } : {};
      return new Response(JSON.stringify({ ...extra, error: message }), { status, headers: { ...headers, ...retry } });
    }
  };
}

/**
 * 有內容的請求（POST，以及帶內容的 PUT、DELETE）只接受 application/json，其他一律 415.
 * 沒有內容的 PUT（開始同步）、DELETE 照舊
 */
function requireJson(request: Request): void {
  const method = request.method;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const type = request.headers.get("content-type");
  const hasBody = method === "POST" || type !== null || Number(request.headers.get("content-length") ?? 0) > 0 || request.headers.has("transfer-encoding");
  if (!hasBody) return;
  if (!type || !/^application\/json\s*(;|$)/i.test(type.trim())) throw new HttpError(415, "只接受 application/json");
}

/**
 * 定期的整理（Workers 的排程，每小時）：清掉沒在用的空空間、過期的配對碼、簽章的亂數與頻率限制的計數；
 * 用量接近上限（80%）時在 log 留下警告. 只記數量
 */
export async function maintain(
  store: SyncStore,
  options: { limits?: Partial<ServiceLimits>; purgeRates?: () => Promise<number>; log?: (line: string) => void } = {},
): Promise<{ spaces: number; slots: number; nonces: number; rates: number; networks: number; staleRekeys: number }> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const log = options.log ?? (() => undefined);
  const spaces = await store.purgeEmptySpaces(EMPTY_SPACE_TTL_MS);
  // 換到一半、7 天沒有進度的新空間（舊空間照舊，先移除的裝置維持移除）
  const staleRekeys = await store.purgeStaleRekeys(STALE_REKEY_MS);
  // 網段的代碼只保存 30 天（從記下的時間算；換金鑰的新空間沿用舊空間的時間，不會因此延長）
  const networks = await store.expireNetworks(NETWORK_RETENTION_MS);
  const { slots, nonces } = await store.purgeExpired();
  const rates = (await options.purgeRates?.()) ?? 0;
  const totals = await store.totals();
  const activeSlots = await store.activeSlots();
  const near = (used: number, max: number) => used >= max * 0.8;
  if (near(totals.spaces, limits.spaces)) log(`WARNING sync spaces near limit: ${totals.spaces}/${limits.spaces}`);
  if (near(totals.bytes, limits.bytes)) log(`WARNING sync bytes near limit: ${totals.bytes}/${limits.bytes}`);
  if (near(activeSlots, limits.pairSlots)) log(`WARNING sync pair slots near limit: ${activeSlots}/${limits.pairSlots}`);
  log(
    `maintenance: purged spaces=${spaces} staleRekeys=${staleRekeys} slots=${slots} nonces=${nonces} rates=${rates} networks=${networks}; spaces=${totals.spaces} bytes=${totals.bytes}`,
  );
  return { spaces, slots, nonces, rates, networks, staleRekeys };
}
