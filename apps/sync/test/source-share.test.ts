/**
 * 同步服務的保護（規格 12.10）：每個來源、每個空間每天只能用掉容量與寫入額度的一小部分；寫入額度照實際寫入的扣；
 * 寬的層在人機驗證之後才算；同一個舊空間只有一個換到一半的新空間；人機驗證沒有設定好時不跳過、比對網址與步驟.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, deriveKeys, newDeviceIdentity, newRootKey, SyncApi, SyncEngine } from "@running-coach/core";
import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import {
  createSyncHandler,
  DEFAULT_DAILY_WRITES,
  DEFAULT_LIMITS,
  DEFAULT_RATE_LIMITS,
  MAX_SPACE_BYTES,
  REKEY_CREATIONS_PER_DAY,
  SOURCE_WRITE_SHARE,
  SPACE_DAILY_BYTES,
  SPACE_WRITE_SHARE,
  type SyncDeps,
  type SyncRateLimits,
} from "../src/handler";
import { RECORD_OVERHEAD, SyncStore } from "../src/store";
import { DUMMY_TOKEN, fakeTurnstileFetch, TEST_SECRET_FAIL, TEST_SECRET_PASS } from "../src/turnstile-testing";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TOKEN = "t".repeat(43);

let now: Date;
let driver: NodeSqliteDriver;
let store: SyncStore;
let limiter: SqlRateLimiter;

beforeEach(async () => {
  now = new Date("2026-11-18T01:00:00Z");
  driver = openNodeSqlite(":memory:");
  store = new SyncStore(driver, () => now);
  await store.init();
  limiter = new SqlRateLimiter(driver, () => now.getTime());
  await limiter.init();
});

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

const handlerWith =
  (extra: Partial<SyncDeps> = {}) =>
  (request: Request) =>
    createSyncHandler({ store, allowedOrigins: ["https://app.example"], rateLimiter: limiter, ...extra })(request);

const space = (n: number) => n.toString(16).padStart(32, "0");

async function call(method: string, path: string, opts: { ip?: string; body?: unknown; handler?: (r: Request) => Promise<Response>; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, ...opts.headers };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const handle = opts.handler ?? handlerWith();
  const res = await handle(new Request(`http://sync.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any> };
}

const create = (n: number, ip: string, handler?: (r: Request) => Promise<Response>, headers?: Record<string, string>) =>
  call("PUT", `/v1/spaces/${space(n)}?create=1`, { ip, handler, headers });
const push = (n: number, items: unknown[], ip: string, handler?: (r: Request) => Promise<Response>) =>
  call("POST", `/v1/spaces/${space(n)}/changes`, { ip, handler, body: { items } });
const item = (id: number, size: number, base = 0) => ({ id: `record${String(id).padStart(10, "0")}`, base, blob: "b".repeat(size) });

/** 整個服務今天用掉的寫入（估算的列數） */
const writesToday = async () => Number((await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'sync:daily-writes%'"))[0]!.n);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("每個來源、每個空間每天的位元組", () => {
  it("預設的上限：一個 /64 或 IPv4 位址每天最多一個空間的量；寬的層也只佔容量的一小部分；每個空間每天能長的比上限小", () => {
    const day = (tier: keyof typeof DEFAULT_RATE_LIMITS.pushBytes) => DEFAULT_RATE_LIMITS.pushBytes[tier]!.day!.limit;
    expect(day("v6/64")).toBeLessThanOrEqual(MAX_SPACE_BYTES);
    expect(day("v4/32")).toBeLessThanOrEqual(MAX_SPACE_BYTES);
    for (const tier of ["v6/56", "v6/48", "v4/24"] as const) expect(day(tier)).toBeLessThanOrEqual(DEFAULT_LIMITS.bytes * 0.2);
    expect(day("v6/48")).toBeGreaterThan(day("v6/64"));
    expect(SPACE_DAILY_BYTES).toBeLessThan(MAX_SPACE_BYTES);
  });

  it("單一來源開好幾個空間塞資料：一天最多送到來源的上限，整個服務還有很多空間；每個空間每天也有上限", async () => {
    const ip = "198.51.100.7";
    const big = 1_390_000;
    for (let n = 1; n <= 4; n++) expect((await create(n, ip)).status).toBe(200);
    let id = 0;
    const statuses: number[] = [];
    for (let n = 1; n <= 4; n++) {
      for (let i = 0; i < 8; i++) {
        const r = await push(n, [item(id++, big), item(id++, big)], ip);
        statuses.push(r.status);
        if (r.status !== 200) {
          expect(r.body.state).toBe("rate_limited");
          break;
        }
      }
    }
    const total = (await store.totals()).bytes;
    expect(total).toBeLessThanOrEqual(DEFAULT_RATE_LIMITS.pushBytes["v4/32"]!.day!.limit);
    expect(total).toBeLessThan(DEFAULT_LIMITS.bytes / 10);
    // 第一個空間被每個空間每天的上限擋下（15 MB），沒有長到來源的上限
    expect((await store.spaceUsage(space(1))).bytes).toBeLessThanOrEqual(SPACE_DAILY_BYTES);
    expect(statuses).toContain(429);
    // 被擋下的沒有保留住位元組（保留的都還回去了）
    const records = Number((await driver.all("SELECT COALESCE(SUM(LENGTH(blob)), 0) AS b, COUNT(*) AS n FROM records"))[0]!.b);
    const count = Number((await driver.all("SELECT COUNT(*) AS n FROM records"))[0]!.n);
    expect(total).toBe(records + count * RECORD_OVERHEAD);
    // 隔天恢復
    advance(DAY);
    expect((await push(4, [item(id++, 1000)], ip)).status).toBe(200);
  });

  it("同一個 /24 的好幾個位址一起送：被 /24 的上限擋下", async () => {
    const handler = handlerWith({ rateLimits: { pushBytes: { "v4/24": { day: { limit: 5000, windowMs: DAY } }, "v4/32": { day: { limit: 3000, windowMs: DAY } } } } });
    for (let n = 1; n <= 3; n++) await create(n, `203.0.113.${n}`, handler);
    expect((await push(1, [item(1, 2000)], "203.0.113.1", handler)).status).toBe(200);
    expect((await push(2, [item(1, 2000)], "203.0.113.2", handler)).status).toBe(200);
    expect(await push(3, [item(1, 2000)], "203.0.113.3", handler)).toMatchObject({ status: 429, body: { state: "rate_limited" } });
    expect((await push(3, [item(1, 2000)], "203.0.114.3", handler)).status).toBe(200);
  });
});

describe("每天的寫入額度", () => {
  it("每個來源只能用掉額度的一小部分（窄的層 10%、寬的層 20%）；用完時別的來源還能建立空間", async () => {
    const handler = handlerWith({ dailyWrites: 1000, rateLimits: { spaceWrites: 10_000 } });
    expect(SOURCE_WRITE_SHARE.narrow).toBeLessThanOrEqual(0.1);
    expect(SOURCE_WRITE_SHARE.widest).toBeLessThanOrEqual(0.2);
    await create(1, "198.51.100.1", handler);
    // 窄的層 100 列：建立 12 + 送出 (10 + 3×20) = 82；再送一次就超過
    expect((await push(1, Array.from({ length: 20 }, (_, i) => item(i, 10)), "198.51.100.1", handler)).status).toBe(200);
    expect(await push(1, [item(100, 10), item(101, 10), item(102, 10)], "198.51.100.1", handler)).toMatchObject({ status: 429, body: { state: "rate_limited" } });
    // 別的來源照常（整個服務還沒用到一半）
    expect((await create(2, "198.51.101.1", handler)).status).toBe(200);
    expect(await writesToday()).toBe(12 + 70 + 12);
  });

  it("每個空間每天的寫入也有上限：好幾個來源一起送同一個空間會被擋", async () => {
    expect(SPACE_WRITE_SHARE).toBeLessThanOrEqual(0.1);
    const handler = handlerWith({ dailyWrites: 10_000, rateLimits: { spaceWrites: 50 } });
    await create(1, "198.51.100.1", handler);
    expect((await push(1, Array.from({ length: 10 }, (_, i) => item(i, 10)), "198.51.100.1", handler)).status).toBe(200);
    expect(await push(1, Array.from({ length: 10 }, (_, i) => item(20 + i, 10)), "198.51.101.1", handler)).toMatchObject({ status: 429 });
  });

  it("格式不對的整批、送到已滿的空間（413）都不扣額度；衝突的退回", async () => {
    const handler = handlerWith({ dailyWrites: 1000 });
    await create(1, "198.51.100.1", handler);
    const base = await writesToday();
    // 格式不對（400）
    for (let i = 0; i < 20; i++) {
      expect((await push(1, [item(1, 10), { id: "bad id!", base: 0, blob: "x" }], "198.51.100.1", handler)).status).toBe(400);
    }
    expect(await writesToday()).toBe(base);
    // 已滿的空間（413）
    expect((await push(1, [item(1, 10)], "198.51.100.1", handler)).status).toBe(200);
    const afterOne = await writesToday();
    expect(afterOne).toBe(base + 13);
    await driver.run("UPDATE spaces SET bytes=? WHERE id=?", [MAX_SPACE_BYTES, space(1)]);
    for (let i = 0; i < 10; i++) expect((await push(1, [item(50 + i, 10)], "198.51.100.1", handler)).status).toBe(413);
    expect(await writesToday()).toBe(afterOne);
    await driver.run("UPDATE spaces SET bytes=0 WHERE id=?", [space(1)]);
    // 衝突（伺服器的版本不是 base）：整批都沒寫入時全部退回；部分寫入時只扣寫入的
    expect((await push(1, [item(1, 10)], "198.51.100.1", handler)).body.conflicts).toHaveLength(1);
    expect(await writesToday()).toBe(afterOne);
    expect((await push(1, [item(1, 10), item(2, 10)], "198.51.100.1", handler)).body.applied).toHaveLength(1);
    expect(await writesToday()).toBe(afterOne + 13);
  });
});

describe("寬的層只在人機驗證之後才算", () => {
  const human = { "x-turnstile": DUMMY_TOKEN };

  it("同一個 /24 的鄰居送一堆沒通過驗證的建立與配對碼：整段的額度沒有被用掉", async () => {
    const fail = handlerWith({ turnstile: { secret: TEST_SECRET_FAIL, fetch: fakeTurnstileFetch() } });
    const pass = handlerWith({ turnstile: { secret: TEST_SECRET_PASS, fetch: fakeTurnstileFetch() } });
    for (let i = 0; i < 60; i++) {
      expect((await create(i, `198.51.100.${i + 1}`, fail, human)).status).toBe(403);
      expect((await call("POST", "/v1/pair", { ip: `198.51.100.${i + 1}`, handler: fail, body: { pub: "PUB", commitment: "C" }, headers: human })).status).toBe(403);
    }
    expect((await create(100, "198.51.100.200", pass, human)).status).toBe(200);
    expect((await call("POST", "/v1/pair", { ip: "198.51.100.200", handler: pass, body: { pub: "PUB", commitment: "C" }, headers: human })).status).toBe(200);
  });

  it("IPv6：同一個 /48 的很多 /64 送不存在的配對碼的步驟：整段的額度沒有被用掉；存在的配對碼的步驟才算寬的層", async () => {
    for (let i = 0; i < 100; i++) {
      expect((await call("POST", "/v1/pair/ZZZZZZZZ/hello", { ip: `2001:db8:aa:${i.toString(16)}::1`, body: { pub: "OLD" } })).status).toBe(409);
      expect((await call("DELETE", "/v1/pair/ZZZZZZZZ", { ip: `2001:db8:aa:${i.toString(16)}::1` })).status).toBe(200);
    }
    const opened = await call("POST", "/v1/pair", { ip: "2001:db8:aa:ffff::1", body: { pub: "PUB", commitment: "C" } });
    const slot = opened.body.slot as string;
    expect((await call("POST", `/v1/pair/${slot}/hello`, { ip: "2001:db8:aa:fff0::1", body: { pub: "OLD" } })).status).toBe(200);
    expect((await call("POST", `/v1/pair/${slot}/nonce`, { ip: "2001:db8:aa:ffff::1", body: { nonce: "N" } })).status).toBe(200);
    expect((await call("POST", `/v1/pair/${slot}/box`, { ip: "2001:db8:aa:fff0::1", body: { box: "B" } })).status).toBe(200);
    // 順序不對的（重送 hello）只算窄的層
    const wide = async () => Number((await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'sync:pairStep:v6/48:%'"))[0]!.n);
    const before = await wide();
    expect((await call("POST", `/v1/pair/${slot}/hello`, { ip: "2001:db8:aa:fff1::1", body: { pub: "OLD" } })).status).toBe(409);
    expect(await wide()).toBe(before);
    expect(before).toBe(3);
  });

  it("被寬的層擋下時，窄的層與人機驗證都不會被用掉", async () => {
    const calls: Record<string, string>[] = [];
    const pass = handlerWith({ turnstile: { secret: TEST_SECRET_PASS, fetch: fakeTurnstileFetch(calls) } });
    for (let i = 0; i < 20; i++) expect((await create(i, `198.51.100.${i + 1}`, pass, human)).status).toBe(200);
    const before = calls.length;
    expect((await create(50, "198.51.100.250", pass, human)).status).toBe(429);
    expect(calls.length).toBe(before);
  });
});

describe("換金鑰的新空間：同一個舊空間只有一個換到一半的", () => {
  async function device(api: SyncApi, records = 3) {
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    for (let i = 0; i < records; i++) {
      await db.saveCheckin({ date: new Date(Date.UTC(2022, 0, 1) + i * DAY).toISOString().slice(0, 10), energy: 3, soreness: 2, sleep: 4, notes: `n${i}` });
    }
    const identity = await newDeviceIdentity();
    const state = { root: newRootKey() };
    const engine = new SyncEngine(db, api, state.root, () => now, {
      identity,
      label: () => ({ name: "A", platform: "t" }),
      onRootChanged: async (r) => void (state.root = r),
    });
    return { engine, state, identity };
  }

  const apiOf = (handle: (r: Request) => Promise<Response>) =>
    new SyncApi(
      "http://sync.test",
      (input, init) => handle(new Request(input as string, init)),
      async (ms) => advance(ms),
    );

  it("同一台一直開新的：之前沒完成的被刪掉，最多一個；每天有次數上限；過了一天恢復", async () => {
    const api = apiOf(handlerWith());
    const a = await device(api);
    await a.engine.ensureSpace();
    await a.engine.sync();
    advance(25 * HOUR);
    const from = (await deriveKeys(a.state.root)).space;
    const auth = { device: a.identity, token: TOKEN };
    for (let i = 0; i < REKEY_CREATIONS_PER_DAY; i++) {
      await api.request("PUT", `/v1/spaces/${space(500 + i)}?create=1&devices=1&from=${from}`, undefined, auth);
      const pending = await driver.all("SELECT id FROM spaces WHERE rekey_from=?", [from]);
      expect(pending.map((r) => r.id)).toEqual([space(500 + i)]);
    }
    await expect(api.request("PUT", `/v1/spaces/${space(600)}?create=1&devices=1&from=${from}`, undefined, auth)).rejects.toMatchObject({ status: 429 });
    advance(DAY);
    await api.request("PUT", `/v1/spaces/${space(601)}?create=1&devices=1&from=${from}`, undefined, auth);
    // 留下一個沒完成的新空間之後，換金鑰照樣完成（重試的情況）
    const before = a.state.root;
    await a.engine.rekey();
    expect(a.state.root).not.toEqual(before);
    expect(await store.spaceToken(space(601))).toBeNull();
    expect((await store.totals()).spaces).toBe(1);
  });

  it("換金鑰的最後一步：新的空間已經不在（被同一個舊空間的另一個換金鑰取代）時整個失敗，舊空間的資料不動", async () => {
    await store.createSpace(space(1), await sha256(TOKEN));
    await store.putMany(space(1), [item(1, 10)]);
    await store.createSpace(space(2), await sha256(TOKEN), null, space(1));
    await store.abandonPendingRekeys(space(1), space(3));
    await expect(
      store.rekey(space(1), { newSpace: space(2), caller: "x", keep: [], remove: [], statement: "s", signature: "g" }),
    ).rejects.toThrow();
    expect(await store.movedTo(space(1))).toBeNull();
    expect((await store.changes(space(1), 0, 10)).length).toBe(1);
  });

  it("換金鑰在新的限制下仍能完成：很多筆、來源與空間每天的位元組與寫入都很小", async () => {
    // 開始同步時照寬鬆的上限；換金鑰前改成很小的上限：複製不受來源與空間的上限擋
    const rateLimits: Partial<SyncRateLimits> = { pushBytes: {}, writes: {}, spaceWrites: 1_000_000, spaceBytes: 100_000_000 };
    const api = apiOf(handlerWith({ rateLimits }));
    const a = await device(api, 1200);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const from = (await deriveKeys(a.state.root)).space;
    expect((await store.spaceUsage(from)).records).toBeGreaterThanOrEqual(1200);
    advance(25 * HOUR);
    Object.assign(rateLimits, {
      pushBytes: { unknown: { day: { limit: 1000, windowMs: DAY } } },
      writes: { unknown: { day: { limit: 100, windowMs: DAY } } },
      spaceWrites: 100,
      spaceBytes: 1000,
    } satisfies Partial<SyncRateLimits>);
    const before = a.state.root;
    await a.engine.rekey();
    expect(a.state.root).not.toEqual(before);
    const to = (await deriveKeys(a.state.root)).space;
    expect((await store.spaceUsage(to)).records).toBeGreaterThanOrEqual(1200);
    // 整個服務的寫入照算
    expect(await writesToday()).toBeGreaterThan(3 * 1200);
  });

  it("換金鑰的新空間送超過舊空間的量：超過的照一般的送出計算（不是繞過的路）", async () => {
    const handler = handlerWith({ rateLimits: { pushBytes: { unknown: { day: { limit: 50_000, windowMs: DAY } } } } });
    await store.createSpace(space(1), await sha256(TOKEN));
    await store.putMany(space(1), [item(1, 1000)]);
    await driver.run("UPDATE spaces SET bytes=? WHERE id=?", [1000 + RECORD_OVERHEAD, space(1)]);
    await store.createSpace(space(2), await sha256(TOKEN), null, space(1));
    // 舊空間的量以內（加上寬容）：不算來源的位元組
    expect((await push(2, [item(1, 1000)], "", handler)).status).toBe(200);
    // 超過：照一般的計算，被來源的上限擋
    const many = Array.from({ length: 60 }, (_, i) => item(10 + i, 1000));
    expect(await push(2, many, "", handler)).toMatchObject({ status: 429 });
  });
});

describe("人機驗證：沒有設定好時不跳過；比對網址與步驟", () => {
  const human = { "x-turnstile": DUMMY_TOKEN };
  const reply = (body: Record<string, unknown>) => async () => new Response(JSON.stringify(body), { status: 200 });

  it("有開但沒有 secret：建立空間與開配對碼都是 503（human_check_unavailable），不建立", async () => {
    const handler = handlerWith({ turnstile: { secret: "", hostnames: ["app.example"] } });
    expect(await create(1, "198.51.100.1", handler, human)).toMatchObject({ status: 503, body: { state: "human_check_unavailable" } });
    expect(await call("POST", "/v1/pair", { handler, body: { pub: "PUB", commitment: "C" }, headers: human })).toMatchObject({
      status: 503,
      body: { state: "human_check_unavailable" },
    });
    expect(await store.spaceToken(space(1))).toBeNull();
    expect(await store.activeSlots()).toBe(0);
  });

  it("正式的設定：hostname 要是這個環境的網頁、action 要完全相同", async () => {
    const withReply = (body: Record<string, unknown>) => handlerWith({ turnstile: { secret: "s", hostnames: ["app.example"], fetch: reply(body) } });
    expect((await create(1, "198.51.101.1", withReply({ success: true, hostname: "app.example", action: "create-space" }), human)).status).toBe(200);
    // 別的環境（staging）拿到的
    expect(await create(2, "198.51.102.1", withReply({ success: true, hostname: "staging.example", action: "create-space" }), human)).toMatchObject({
      status: 403,
      body: { reason: "failed" },
    });
    // 沒有回 hostname、action 不同或沒有 action
    expect((await create(3, "198.51.103.1", withReply({ success: true, action: "create-space" }), human)).status).toBe(403);
    expect((await create(4, "198.51.104.1", withReply({ success: true, hostname: "app.example", action: "pair" }), human)).status).toBe(403);
    expect((await create(5, "198.51.105.1", withReply({ success: true, hostname: "app.example", action: "" }), human)).status).toBe(403);
    expect((await create(6, "198.51.106.1", withReply({ success: true, hostname: "app.example" }), human)).status).toBe(403);
    // 開配對碼要 action pair
    const pairHandler = withReply({ success: true, hostname: "app.example", action: "pair" });
    expect((await call("POST", "/v1/pair", { handler: pairHandler, body: { pub: "PUB", commitment: "C" }, headers: human })).status).toBe(200);
    // 沒有任何允許的網頁：一律暫時無法使用
    const none = handlerWith({ turnstile: { secret: "s", hostnames: [], fetch: reply({ success: true, hostname: "app.example", action: "create-space" }) } });
    expect(await create(7, "198.51.107.1", none, human)).toMatchObject({ status: 503, body: { state: "human_check_unavailable" } });
  });
});

describe("預設的寫入額度", () => {
  it("每個來源與每個空間的上限照整個服務的額度算", () => {
    expect(Math.floor(DEFAULT_DAILY_WRITES * SOURCE_WRITE_SHARE.narrow)).toBe(4000);
    expect(Math.floor(DEFAULT_DAILY_WRITES * SPACE_WRITE_SHARE)).toBe(4000);
  });
});
