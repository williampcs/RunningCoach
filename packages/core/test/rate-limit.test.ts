/** 頻率限制（同步服務與代理共用）：記憶體與 SQL 的兩種計數行為一樣. */
import { describe, expect, it } from "vitest";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { MemoryRateLimiter, sourceIp, sourceKey, sourceLevels, SqlRateLimiter, takeAll, takeEntries, type RateLimiter } from "../src/rate-limit";

async function limiters(now: () => number): Promise<[string, RateLimiter & { purge?: () => Promise<number> }][]> {
  const sql = new SqlRateLimiter(openNodeSqlite(":memory:"), now);
  await sql.init();
  return [
    ["memory", new MemoryRateLimiter(now)],
    ["sql", sql],
  ];
}

describe("頻率限制", () => {
  it("時間窗內最多 limit；超過的不算進去；下一個時間窗重來；帶 weight 的照位元組算", async () => {
    let t = 1_000_000;
    for (const [name, limiter] of await limiters(() => t)) {
      const rule = { limit: 3, windowMs: 1000 };
      const results = [];
      for (let i = 0; i < 5; i++) results.push(await limiter.take(`${name}:a`, rule));
      expect(results).toEqual([true, true, true, false, false]);
      expect(await limiter.take(`${name}:b`, rule)).toBe(true);
      t += 1000;
      expect(await limiter.take(`${name}:a`, rule)).toBe(true);
      const bytes = { limit: 100, windowMs: 1000 };
      expect(await limiter.take(`${name}:bytes`, bytes, 60)).toBe(true);
      expect(await limiter.take(`${name}:bytes`, bytes, 60)).toBe(false);
      expect(await limiter.take(`${name}:bytes`, bytes, 40)).toBe(true);
      expect(await limiter.take(`${name}:big`, bytes, 101)).toBe(false);
      t -= 1000;
    }
  });

  it("takeAll：每個時間窗都要過", async () => {
    const t = 0;
    for (const [, limiter] of await limiters(() => t)) {
      const rules = { short: { limit: 5, windowMs: 1000 }, long: { limit: 2, windowMs: 60_000 } };
      expect(await takeAll(limiter, "k", rules, 1, t)).toBeNull();
      expect(await takeAll(limiter, "k", rules, 1, t)).toBeNull();
      // 超過的是 60 秒的那條：要等到它的時間窗結束
      expect(await takeAll(limiter, "k", rules, 1, t)).toBe(60_000);
    }
  });

  it("SQL 的計數：過了時間窗的被清掉", async () => {
    let t = 0;
    const sql = new SqlRateLimiter(openNodeSqlite(":memory:"), () => t);
    await sql.init();
    await sql.take("k", { limit: 1, windowMs: 1000 });
    expect(await sql.purge()).toBe(0);
    t = 1001;
    expect(await sql.purge()).toBe(1);
  });

  it("來源：IPv6 同一個 /64 算同一個；IPv4 完整的位址；只信 cf-connecting-ip", () => {
    const a = sourceKey("2001:db8:1234:5678:aaaa:bbbb:cccc:dddd");
    expect(a).toBe("2001:db8:1234:5678::/64");
    expect(sourceKey("2001:0db8:1234:5678::1")).toBe(a);
    expect(sourceKey("2001:DB8:1234:5678:0:0:0:ffff")).toBe(a);
    expect(sourceKey("[2001:db8:1234:5678::2]")).toBe(a);
    expect(sourceKey("2001:db8:1234:5679::1")).not.toBe(a);
    expect(sourceKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(sourceKey("::1")).toBe("0:0:0:0::/64");
    expect(sourceKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(sourceKey("::ffff:198.51.100.7")).toBe("198.51.100.7");
    expect(sourceKey("198.51.100.7")).toBe("198.51.100.7");
    expect(sourceKey("198.51.100.8")).not.toBe(sourceKey("198.51.100.7"));
    const req = (headers: Record<string, string>) => new Request("http://x/", { headers });
    expect(sourceIp(req({ "cf-connecting-ip": "2001:db8:1:2:3:4:5:6" }))).toBe("2001:db8:1:2::/64");
    // 用戶端自己帶的標頭不算
    expect(sourceIp(req({ "x-forwarded-for": "203.0.113.9" }))).toBe("unknown");
    expect(sourceIp(req({}))).toBe("unknown");
  });

  it("多層的來源：IPv6 由寬到窄 /48、/56、/64；IPv4 /24 與完整的位址；沒有 IP 時 unknown", () => {
    expect(sourceLevels("2001:db8:aa:12bb:1:2:3:4")).toEqual([
      { tier: "v6/48", source: "2001:db8:aa:0::/48" },
      { tier: "v6/56", source: "2001:db8:aa:1200::/56" },
      { tier: "v6/64", source: "2001:db8:aa:12bb::/64" },
    ]);
    // 同一個 /48 的不同 /64：/48 一樣、/64 不同
    const a = sourceLevels("2001:db8:aa:1::1");
    const b = sourceLevels("2001:db8:aa:ff01::1");
    expect(a[0]).toEqual(b[0]);
    expect(a[2]).not.toEqual(b[2]);
    expect(sourceLevels("2001:db8::1")[0]!.source).toBe("2001:db8:0:0::/48");
    expect(sourceLevels("198.51.100.7")).toEqual([
      { tier: "v4/24", source: "198.51.100.0/24" },
      { tier: "v4/32", source: "198.51.100.7" },
    ]);
    expect(sourceLevels("::ffff:198.51.100.7")[1]).toEqual({ tier: "v4/32", source: "198.51.100.7" });
    expect(sourceLevels(null)).toEqual([{ tier: "unknown", source: "unknown" }]);
    expect(sourceLevels("  ")).toEqual([{ tier: "unknown", source: "unknown" }]);
  });

  it("takeEntries：有一條超過時都不加（先只讀檢查），每一條可以有自己的 weight", async () => {
    const t = 0;
    for (const [, limiter] of await limiters(() => t)) {
      const small = { limit: 2, windowMs: 1000 };
      const big = { limit: 100, windowMs: 1000 };
      expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 10 }, { key: "narrow", rule: small }], 1, t)).toBeNull();
      expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 10 }, { key: "narrow", rule: small }], 1, t)).toBeNull();
      // narrow 用完：wide 不會再被加
      for (let i = 0; i < 5; i++) expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 10 }, { key: "narrow", rule: small }], 1, t)).toBe(1000);
      // wide 還剩 80
      expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 80 }], 1, t)).toBeNull();
      expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 1 }], 1, t)).toBe(1000);
      // weight 0 的不算
      expect(await takeEntries(limiter, [{ key: "wide", rule: big, weight: 0 }], 1, t)).toBeNull();
    }
  });
});
