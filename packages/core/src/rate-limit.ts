/**
 * 頻率限制（同步服務與代理共用，規格 12.10、12.39）：在一段時間內，同一個來源（帳號，或來源 IP 的雜湊）最多做幾次或送多少位元組.
 *
 * Workers 的每個請求可能在不同的執行個體，記憶體裡的計數不會累積，所以計數放在服務自己的 D1（SqlRateLimiter）：
 * 加上這次與比較上限在同一個 SQL 敘述裡，並行的請求不會一起超過. 本機與測試可以用 MemoryRateLimiter.
 * IP 只存雜湊，時間窗過了就刪掉；不寫進日誌.
 */
import type { SqlDriver } from "./types";

/** 一條規則：windowMs 內最多 limit（次數，或帶 weight 時的位元組數） */
export interface RateRule {
  limit: number;
  windowMs: number;
}

export interface RateLimiter {
  /**
   * 這個來源在目前的時間窗加上 weight（預設 1）. 加了之後超過上限時不加、回傳 false.
   * key 要包含規則的名稱（例如 `push-bytes:ip:…`）
   */
  take(key: string, rule: RateRule, weight?: number): Promise<boolean>;
  /** 只讀不加：每一條在目前的時間窗再加上它的 weight 還在上限內嗎；回傳第一條超過的位置，都沒超過時 -1 */
  firstOver?(entries: RateEntry[]): Promise<number>;
  /** 退回之前加上的 weight（請求最後沒有用到，例如寫入失敗或衝突）；時間窗已經換了就不動，不會低於 0 */
  release?(key: string, rule: RateRule, weight: number): Promise<void>;
}

/** 一條要檢查的計數：key、規則與這次要加多少（沒有時用 takeEntries 的 weight） */
export interface RateEntry {
  key: string;
  rule: RateRule;
  weight?: number;
}

/**
 * 一次檢查好幾條（多層的來源、好幾個時間窗、好幾種）. 先全部只讀檢查（limiter 支援時，一個查詢），有一條超過就都不加，
 * 被擋下的請求不會把其他的計數也用掉；都在限制內才依序加上. 回傳 null 或還要等幾毫秒（超過的那條的時間窗結束）
 */
export async function takeEntries(limiter: RateLimiter, entries: RateEntry[], weight = 1, nowMs: number = Date.now()): Promise<number | null> {
  const wait = (rule: RateRule) => (slotOf(nowMs, rule) + 1) * rule.windowMs - nowMs;
  const list = entries.map((e) => ({ ...e, weight: e.weight ?? weight })).filter((e) => e.weight > 0);
  if (list.length === 0) return null;
  if (limiter.firstOver) {
    const over = await limiter.firstOver(list);
    if (over >= 0) return wait(list[over]!.rule);
  }
  // 一條一條加；中途有一條超過時，前面已經加上的退回（並行時 firstOver 之後才被用完的情況），不會只扣一半
  const taken: typeof list = [];
  for (const e of list) {
    if (!(await limiter.take(e.key, e.rule, e.weight))) {
      for (const t of taken) await limiter.release?.(t.key, t.rule, t.weight).catch(() => undefined);
      return wait(e.rule);
    }
    taken.push(e);
  }
  return null;
}

/**
 * 檢查每條規則（同一個 key 的好幾個時間窗）. 都在限制內時回傳 null；有一條超過時回傳還要等幾毫秒（那條的時間窗結束）
 */
export async function takeAll(
  limiter: RateLimiter,
  key: string,
  rules: Record<string, RateRule>,
  weight = 1,
  nowMs: number = Date.now(),
): Promise<number | null> {
  return takeEntries(
    limiter,
    Object.entries(rules).map(([name, rule]) => ({ key: `${key}:${name}`, rule })),
    weight,
    nowMs,
  );
}

/**
 * 來源的層級（規格 12.10）：同一個來源同時以好幾層計數，每一層有自己的上限（上層寬鬆一些）.
 * IPv6：/64（一般一個用戶或一支手機）、/56、/48（一個用戶或機構常拿到的整段）；IPv4：完整的位址與 /24.
 * 沒有 IP 時（本機的 Node 版）是 unknown，用 /64 與 IPv4 完整位址的規則
 */
export type SourceTier = "v6/48" | "v6/56" | "v6/64" | "v4/24" | "v4/32" | "unknown";

/** 每一層的規則；沒有寫的那一層不計數 */
export type TieredRules = Partial<Record<SourceTier, Record<string, RateRule>>>;

export interface SourceLevel {
  tier: SourceTier;
  /** 這一層的來源（IP 的前綴；存之前要雜湊） */
  source: string;
}

/** 由寬到窄的每一層. 寬的先檢查：被寬的擋下時不會再用掉窄的計數 */
export function sourceLevels(ip: string | null | undefined): SourceLevel[] {
  const text = ip?.trim();
  if (!text) return [{ tier: "unknown", source: "unknown" }];
  const address = normalizeAddress(text);
  const v4 = ipv4Of(address);
  if (v4) {
    const parts = v4.split(".");
    return [
      { tier: "v4/24", source: `${parts.slice(0, 3).join(".")}.0/24` },
      { tier: "v4/32", source: v4 },
    ];
  }
  const groups = ipv6Groups(address);
  const prefix = (bits: 48 | 56 | 64) => {
    const g = groups.slice(0, 4);
    if (bits === 48) g[3] = 0;
    if (bits === 56) g[3] = g[3]! & 0xff00;
    return `${g.map((n) => n.toString(16)).join(":")}::/${bits}`;
  };
  return [
    { tier: "v6/48", source: prefix(48) },
    { tier: "v6/56", source: prefix(56) },
    { tier: "v6/64", source: prefix(64) },
  ];
}

/** 請求的每一層來源（只信 cf-connecting-ip） */
export function requestSourceLevels(request: Request): SourceLevel[] {
  return sourceLevels(request.headers.get("cf-connecting-ip"));
}

/** 來源（IP 或網段）轉成存得下的代碼 */
export type SourceHasher = (text: string) => Promise<string>;

/**
 * 來源的代碼：有金鑰（Worker 的 secret RATE_LIMIT_HASH_KEY）時用 HMAC-SHA256，沒有金鑰的人算不出、也反推不回 IP；
 * 沒有金鑰時（本機、模擬服務、測試）用沒有金鑰的雜湊（hashSource）. 一樣取 16 bytes
 */
export function sourceHasher(key?: string | null): SourceHasher {
  const secret = key?.trim();
  if (!secret) return hashSource;
  let imported: Promise<CryptoKey> | undefined;
  return async (text) => {
    imported ??= crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", await imported, new TextEncoder().encode(`rate-limit:${text}`));
    return Array.from(new Uint8Array(mac).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
  };
}

/** 規則套到每一層：回傳要檢查的計數（key 是 prefix、層級、來源的代碼與規則的名稱）. hash 預設沒有金鑰 */
export async function tieredEntries(
  prefix: string,
  levels: SourceLevel[],
  rules: TieredRules,
  weight?: number,
  hash: SourceHasher = hashSource,
): Promise<RateEntry[]> {
  const entries: RateEntry[] = [];
  for (const level of levels) {
    const forTier = rules[level.tier] ?? (level.tier === "unknown" ? (rules["v6/64"] ?? rules["v4/32"]) : undefined);
    if (!forTier) continue;
    const hashed = await hash(level.source);
    for (const [name, rule] of Object.entries(forTier)) entries.push({ key: `${prefix}:${level.tier}:${hashed}:${name}`, rule, weight });
  }
  return entries;
}

/** 來源 IP 的雜湊（不存原文；沒有金鑰，正式環境用 sourceHasher(金鑰)） */
export async function hashSource(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`rate-limit:${text}`));
  return Array.from(new Uint8Array(digest).slice(0, 16), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 請求的來源：只信 Cloudflare 給的 cf-connecting-ip（用戶端可以自己帶其他標頭）；沒有時（本機的 Node 版）全部算同一個來源.
 * IPv6 取前 64 bits（一般一個用戶拿到的就是整個 /64），IPv4 是完整的位址
 */
export function sourceIp(request: Request): string {
  const ip = request.headers.get("cf-connecting-ip")?.trim();
  return ip ? sourceKey(ip) : "unknown";
}

const normalizeAddress = (ip: string) =>
  ip
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/%.*$/, "");

/** IPv4（含 IPv4 對應的 IPv6）的位址；不是時 null */
function ipv4Of(address: string): string | null {
  if (!address.includes(":")) return address;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  return mapped ? mapped[1]! : null;
}

/** IPv6 展開 :: 之後的八段（數字）；最後一段是 IPv4 寫法時算兩段 */
function ipv6Groups(address: string): number[] {
  const [head = "", tail] = address.split("::", 2);
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  const groups = (parts: string[]) => parts.flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const full = tail === undefined ? groups(front) : [...groups(front), ...Array(Math.max(0, 8 - groups(front).length - groups(back).length)).fill("0"), ...groups(back)];
  return full.map((g) => (parseInt(g || "0", 16) || 0) & 0xffff);
}

/** 同一個來源的 key：IPv6 的前四段（展開 :: 之後），IPv4（含 IPv4 對應的 IPv6）是完整的位址 */
export function sourceKey(ip: string): string {
  const address = normalizeAddress(ip);
  const v4 = ipv4Of(address);
  if (v4) return v4;
  return `${ipv6Groups(address)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":")}::/64`;
}

const slotOf = (nowMs: number, rule: RateRule) => Math.floor(nowMs / rule.windowMs);

/** 單一執行個體的記憶體計數：本機開發與測試 */
export class MemoryRateLimiter implements RateLimiter {
  private readonly counts = new Map<string, { slot: number; count: number }>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  async take(key: string, rule: RateRule, weight = 1): Promise<boolean> {
    const slot = slotOf(this.now(), rule);
    const id = `${key}:${rule.windowMs}`;
    const current = this.counts.get(id);
    const count = current && current.slot === slot ? current.count : 0;
    if (count + weight > rule.limit) return false;
    // 不讓表一直長大
    if (!current && this.counts.size > 50_000) this.counts.clear();
    this.counts.set(id, { slot, count: count + weight });
    return true;
  }

  async firstOver(entries: RateEntry[]): Promise<number> {
    return entries.findIndex((e) => {
      const current = this.counts.get(`${e.key}:${e.rule.windowMs}`);
      const count = current && current.slot === slotOf(this.now(), e.rule) ? current.count : 0;
      return count + (e.weight ?? 1) > e.rule.limit;
    });
  }

  async release(key: string, rule: RateRule, weight: number): Promise<void> {
    const id = `${key}:${rule.windowMs}`;
    const current = this.counts.get(id);
    if (!current || current.slot !== slotOf(this.now(), rule) || weight <= 0) return;
    current.count = Math.max(0, current.count - weight);
  }
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS rate_limits (
    key         TEXT NOT NULL,
    slot        INTEGER NOT NULL,
    count       INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    PRIMARY KEY (key, slot)
  )
`;

/** 計數存在 SQL（Workers 上是服務自己的 D1）：所有執行個體共用 */
export class SqlRateLimiter implements RateLimiter {
  constructor(
    private readonly driver: Pick<SqlDriver, "exec" | "run" | "all">,
    private readonly now: () => number = () => Date.now(),
  ) {}

  init(): Promise<void> {
    return this.driver.exec(SCHEMA);
  }

  async take(key: string, rule: RateRule, weight = 1): Promise<boolean> {
    if (weight > rule.limit) return false;
    const nowMs = this.now();
    const slot = slotOf(nowMs, rule);
    // 偶爾順便清掉過期的（排程也會清）
    if (Math.random() < 0.01) await this.purge();
    // 新的一列直接寫入；已經有的，只有加上這次不超過上限時才加. 沒有回傳的列＝超過了
    const rows = await this.driver.all(
      "INSERT INTO rate_limits (key, slot, count, expires_at) VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(key, slot) DO UPDATE SET count = rate_limits.count + excluded.count WHERE rate_limits.count + excluded.count <= ? RETURNING count",
      [`${key}:${rule.windowMs}`, slot, weight, (slot + 1) * rule.windowMs, rule.limit],
    );
    return rows.length > 0;
  }

  /** 一個查詢讀出全部（每一條都用主鍵查） */
  async firstOver(entries: RateEntry[]): Promise<number> {
    if (entries.length === 0) return -1;
    const now = this.now();
    const ids = entries.map((e) => ({ key: `${e.key}:${e.rule.windowMs}`, slot: slotOf(now, e.rule) }));
    const rows = await this.driver.all(
      `SELECT key, slot, count FROM rate_limits WHERE ${ids.map(() => "(key=? AND slot=?)").join(" OR ")}`,
      ids.flatMap((id) => [id.key, id.slot]),
    );
    const counts = new Map(rows.map((r) => [`${String(r.key)}#${Number(r.slot)}`, Number(r.count)]));
    return entries.findIndex((e, i) => (counts.get(`${ids[i]!.key}#${ids[i]!.slot}`) ?? 0) + (e.weight ?? 1) > e.rule.limit);
  }

  async release(key: string, rule: RateRule, weight: number): Promise<void> {
    if (weight <= 0) return;
    await this.driver.run("UPDATE rate_limits SET count = MAX(0, count - ?) WHERE key = ? AND slot = ?", [weight, `${key}:${rule.windowMs}`, slotOf(this.now(), rule)]);
  }

  /** 刪掉時間窗已經過了的計數 */
  async purge(): Promise<number> {
    return (await this.driver.run("DELETE FROM rate_limits WHERE expires_at < ?", [this.now()])).changes;
  }
}
