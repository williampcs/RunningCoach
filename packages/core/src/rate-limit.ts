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
}

/**
 * 依序檢查每條規則. 都在限制內時回傳 null；有一條超過時回傳還要等幾毫秒（那條的時間窗結束），
 * 前面已經通過的那幾條照算
 */
export async function takeAll(
  limiter: RateLimiter,
  key: string,
  rules: Record<string, RateRule>,
  weight = 1,
  nowMs: number = Date.now(),
): Promise<number | null> {
  for (const [name, rule] of Object.entries(rules)) {
    if (!(await limiter.take(`${key}:${name}`, rule, weight))) return (slotOf(nowMs, rule) + 1) * rule.windowMs - nowMs;
  }
  return null;
}

/** 來源 IP 的雜湊（不存原文） */
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

/** 同一個來源的 key：IPv6 的前四段（展開 :: 之後），IPv4（含 IPv4 對應的 IPv6）是完整的位址 */
export function sourceKey(ip: string): string {
  const address = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!address.includes(":")) return address;
  const mapped = /^(?:0*:)*:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped) return mapped[1]!;
  const [head = "", tail] = address.split("::", 2);
  const front = head ? head.split(":") : [];
  const back = tail === undefined ? [] : tail ? tail.split(":") : [];
  // 最後一段是 IPv4 寫法時算兩段
  const groups = (parts: string[]) => parts.flatMap((g) => (g.includes(".") ? ["0", "0"] : [g]));
  const full = tail === undefined ? groups(front) : [...groups(front), ...Array(Math.max(0, 8 - groups(front).length - groups(back).length)).fill("0"), ...groups(back)];
  return `${full
    .slice(0, 4)
    .map((g) => (parseInt(g || "0", 16) || 0).toString(16))
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

  /** 刪掉時間窗已經過了的計數 */
  async purge(): Promise<number> {
    return (await this.driver.run("DELETE FROM rate_limits WHERE expires_at < ?", [this.now()])).changes;
  }
}
