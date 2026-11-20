/**
 * 同步服務的保護（規格 12.10）：每個來源、每個空間每天只能用掉容量與寫入額度的一小部分；寫入額度照實際寫入的扣；
 * 寬的層在人機驗證之後才算；同一個舊空間只有一個換到一半的新空間；人機驗證沒有設定好時不跳過、比對網址與步驟.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, deriveKeys, newDeviceIdentity, newRootKey, SyncApi, SyncEngine } from "@running-coach/core";
import { hashSource, SqlRateLimiter, sourceHasher } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import {
  createSyncHandler,
  DEFAULT_DAILY_WRITES,
  DEFAULT_LIMITS,
  DEFAULT_RATE_LIMITS,
  maintain,
  MAX_SPACE_BYTES,
  NETWORK_RETENTION_MS,
  REKEY_ACTOR_SHARE,
  REKEY_WRITE_SHARE,
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
const writesToday = async () =>
  Number((await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'sync:daily-writes%' AND slot=?", [Math.floor(now.getTime() / DAY)]))[0]!.n);

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

  it("同一台一直開新的：已經有一個時拒絕（rekey_in_progress），明確重新開始才刪掉之前的，最多一個；每天有次數上限；過了一天恢復", async () => {
    const api = apiOf(handlerWith());
    const a = await device(api);
    await a.engine.ensureSpace();
    await a.engine.sync();
    advance(25 * HOUR);
    const from = (await deriveKeys(a.state.root)).space;
    const auth = { device: a.identity, token: TOKEN };
    for (let i = 0; i < REKEY_CREATIONS_PER_DAY; i++) {
      if (i > 0) {
        await expect(api.request("PUT", `/v1/spaces/${space(700 + i)}?create=1&devices=1&from=${from}`, undefined, auth)).rejects.toMatchObject({
          status: 409,
          state: "rekey_in_progress",
        });
      }
      await api.request("PUT", `/v1/spaces/${space(500 + i)}?create=1&devices=1&from=${from}${i > 0 ? "&replace=1" : ""}`, undefined, auth);
      const pending = await driver.all("SELECT id FROM spaces WHERE rekey_from=?", [from]);
      expect(pending.map((r) => r.id)).toEqual([space(500 + i)]);
    }
    await expect(api.request("PUT", `/v1/spaces/${space(600)}?create=1&devices=1&from=${from}&replace=1`, undefined, auth)).rejects.toMatchObject({ status: 429 });
    advance(DAY);
    await api.request("PUT", `/v1/spaces/${space(601)}?create=1&devices=1&from=${from}&replace=1`, undefined, auth);
    // 留下一個這台不知道的新空間（另一台開始的、或這台的紀錄不見了）：不自動取代，說「另一台正在換金鑰」
    const before = a.state.root;
    await expect(a.engine.rekey()).rejects.toMatchObject({ status: 409, state: "rekey_in_progress" });
    expect(await store.spaceToken(space(601))).not.toBeNull();
    // 使用者選了改由這台重新開始：取代它、照樣完成
    await a.engine.rekey([], undefined, undefined, { replace: true });
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
    // （每台、每個來源每天的換金鑰份額另外測：這裡放寬）
    const rateLimits: Partial<SyncRateLimits> = { pushBytes: {}, writes: {}, spaceWrites: 1_000_000, spaceBytes: 100_000_000, rekeyActorWrites: 1_000_000 };
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
    // 複製算在換金鑰自己的那一份（今天的時間窗）
    const slot = Math.floor(now.getTime() / DAY);
    const rekeyCount = Number((await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'sync:rekey-writes%' AND slot=?", [slot]))[0]!.n);
    expect(rekeyCount).toBeGreaterThan(3 * 1200);
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

describe("同一個網段建立的同步空間的總容量", () => {
  it("同一個 /24 開很多空間、跨好幾天慢慢送：總量卡在上限（413 network_full），整個服務還有空間；別的網段照常", async () => {
    expect(DEFAULT_LIMITS.networkBytes).toBeLessThanOrEqual(DEFAULT_LIMITS.bytes / 5);
    const big = 1_390_000;
    for (let n = 1; n <= 6; n++) expect((await create(n, `198.51.100.${n}`)).status).toBe(200);
    let id = 0;
    let full: Awaited<ReturnType<typeof call>> | null = null;
    for (let day = 0; day < 10 && !full; day++) {
      for (let n = 1; n <= 6 && !full; n++) {
        for (let i = 0; i < 3; i++) {
          const r = await push(n, [item(id++, big), item(id++, big)], `198.51.100.${n}`);
          if (r.status === 413) full = r;
          if (r.status !== 200) break;
        }
      }
      advance(DAY);
    }
    expect(full).toMatchObject({ status: 413, body: { state: "network_full" } });
    const total = (await store.totals()).bytes;
    expect(total).toBeLessThanOrEqual(DEFAULT_LIMITS.networkBytes);
    expect(total).toBeGreaterThan(DEFAULT_LIMITS.networkBytes - 4 * big);
    expect(total).toBeLessThan(DEFAULT_LIMITS.bytes);
    // 同一個網段的另一個位址開的新空間也送不上去；別的網段照常
    await create(20, "198.51.100.77");
    expect(await push(20, [item(1, big), item(2, big)], "198.51.100.77")).toMatchObject({ status: 413, body: { state: "network_full" } });
    await create(21, "198.51.101.1");
    expect((await push(21, [item(1, big)], "198.51.101.1")).status).toBe(200);
    // 之後換到別的網路送也一樣（算的是建立時的網段）
    expect(await push(1, [item(9998, big), item(9999, big)], "203.0.113.1")).toMatchObject({ status: 413, body: { state: "network_full" } });
    // 網段只存雜湊
    const networks = JSON.stringify(await driver.all("SELECT network FROM spaces"));
    expect(networks).not.toContain("198.51");
  });

  it("沒有記下網段的舊空間不受限；本機（沒有 IP）不記網段", async () => {
    const handler = handlerWith({ limits: { networkBytes: 1000 } });
    await create(1, "198.51.100.1", handler);
    await driver.run("UPDATE spaces SET network=NULL WHERE id=?", [space(1)]);
    expect((await push(1, [item(1, 5000)], "198.51.100.1", handler)).status).toBe(200);
    await create(2, "", handler);
    expect((await driver.all("SELECT network FROM spaces WHERE id=?", [space(2)]))[0]!.network).toBeNull();
  });

  it("換金鑰不會因為網段的上限失敗；新空間沿用舊空間的網段", async () => {
    const handler = handlerWith({ limits: { networkBytes: 60_000 } });
    const ip = "198.51.100.9";
    const api = new SyncApi(
      "http://sync.test",
      (input, init) => {
        const request = new Request(input as string, init);
        request.headers.set("cf-connecting-ip", ip);
        return handler(request);
      },
      async (ms) => advance(ms),
    );
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    for (let i = 0; i < 40; i++) await db.saveCheckin({ date: new Date(Date.UTC(2023, 0, 1) + i * DAY).toISOString().slice(0, 10), energy: 3, soreness: 2, sleep: 4, notes: "x".repeat(200) });
    const state = { root: newRootKey() };
    const engine = new SyncEngine(db, api, state.root, () => now, {
      identity: await newDeviceIdentity(),
      label: () => ({ name: "A", platform: "t" }),
      onRootChanged: async (r) => void (state.root = r),
    });
    await engine.ensureSpace();
    await engine.sync();
    const from = (await deriveKeys(state.root)).space;
    const used = (await store.spaceUsage(from)).bytes;
    // 這個網段已經用掉一大半：換金鑰的複製（同樣的量）不受網段的上限
    expect(used * 2).toBeGreaterThan(60_000);
    advance(25 * HOUR);
    await engine.rekey();
    const to = (await deriveKeys(state.root)).space;
    expect(to).not.toBe(from);
    const rows = await driver.all("SELECT id, network FROM spaces WHERE id IN (?, ?)", [from, to]);
    expect(rows).toHaveLength(2);
    expect(rows[0]!.network).not.toBeNull();
    expect(rows[0]!.network).toBe(rows[1]!.network);
  });

  it("引擎顯示看得懂的說明", async () => {
    const handler = handlerWith({ limits: { networkBytes: 1000 } });
    await create(1, "198.51.100.1", handler);
    const api = new SyncApi("http://sync.test", (input, init) => {
      const request = new Request(input as string, init);
      request.headers.set("cf-connecting-ip", "198.51.100.1");
      return handler(request);
    });
    await expect(api.request("POST", `/v1/spaces/${space(1)}/changes`, { items: [item(1, 5000)] }, TOKEN)).rejects.toMatchObject({
      status: 413,
      state: "network_full",
      message: expect.stringContaining("這個網路建立的同步空間已達總容量上限"),
    });
  });
});

describe("來源與網段的代碼（有金鑰時 HMAC）、網段代碼保存 30 天", () => {
  it("有金鑰時代碼不同於沒有金鑰的；同一個來源、同一把金鑰得到相同的代碼；不同的金鑰不同", async () => {
    const keyed = sourceHasher("k".repeat(44));
    expect(await keyed("198.51.100.0/24")).toBe(await keyed("198.51.100.0/24"));
    expect(await keyed("198.51.100.0/24")).not.toBe(await hashSource("198.51.100.0/24"));
    expect(await keyed("198.51.100.0/24")).not.toBe(await sourceHasher("other key")("198.51.100.0/24"));
    expect(await keyed("198.51.100.0/24")).toMatch(/^[0-9a-f]{32}$/);
    // 沒有金鑰（或空的）時照舊
    expect(await sourceHasher(undefined)("x")).toBe(await hashSource("x"));
    expect(await sourceHasher("  ")("x")).toBe(await hashSource("x"));
  });

  it("同步服務用金鑰算網段與計數的代碼：同一個網段的兩個空間代碼相同，和沒有金鑰的不同", async () => {
    const key = "secret-key-for-test-0123456789";
    const keyed = handlerWith({ hashKey: key });
    await create(1, "198.51.100.1", keyed);
    await create(2, "198.51.100.2", keyed);
    await create(3, "198.51.100.3");
    const rows = await driver.all("SELECT id, network FROM spaces ORDER BY id");
    expect(rows[0]!.network).toBe(rows[1]!.network);
    expect(rows[0]!.network).not.toBe(rows[2]!.network);
    expect(rows[0]!.network).toBe(await sourceHasher(key)("sync-network:198.51.100.0/24"));
    const counters = (await driver.all("SELECT key FROM rate_limits WHERE key LIKE 'sync:createSpace:v4/24:%'")).map((r) => String(r.key).split(":")[3]);
    expect(new Set(counters)).toEqual(new Set([await sourceHasher(key)("198.51.100.0/24"), await hashSource("198.51.100.0/24")]));
  });

  it("記下 30 天後網段的代碼清掉，不再算進網段的總容量；換金鑰的新空間沿用舊空間記下的時間", async () => {
    expect(NETWORK_RETENTION_MS).toBe(30 * DAY);
    const handler = handlerWith({ limits: { networkBytes: 5000 } });
    await create(1, "198.51.100.1", handler);
    expect((await push(1, [item(1, 4000)], "198.51.100.1", handler)).status).toBe(200);
    await create(2, "198.51.100.2", handler);
    expect(await push(2, [item(1, 4000)], "198.51.100.2", handler)).toMatchObject({ status: 413, body: { state: "network_full" } });
    expect((await push(2, [item(2, 10)], "198.51.100.2", handler)).status).toBe(200);
    // 換金鑰的新空間（第 20 天建立）沿用舊空間的代碼與記下的時間
    advance(20 * DAY);
    await store.createSpace(space(3), await sha256(TOKEN), null, space(1), "ignored");
    await store.putMany(space(3), [item(1, 10)]);
    const [old, renewed] = await driver.all("SELECT network, network_at FROM spaces WHERE id IN (?, ?) ORDER BY id", [space(1), space(3)]);
    expect(renewed).toEqual(old);
    // 換到一半的新空間也算進網段的總量
    expect(await store.networkUsage(space(1))).toBe((await store.spaceUsage(space(1))).bytes + (await store.spaceUsage(space(2))).bytes + (await store.spaceUsage(space(3))).bytes);
    expect((await maintain(store)).networks).toBe(0);
    // 換到一半的新空間一直有進度（沒有 7 天沒進度被清掉）
    advance(6 * DAY);
    await store.touchRekeyProgress(space(3));
    advance(4 * DAY + HOUR);
    expect((await maintain(store)).networks).toBe(3);
    expect(await driver.all("SELECT id FROM spaces WHERE network IS NOT NULL")).toHaveLength(0);
    // 不再算進上限：同一個網段之前建立的空間照常送；新建立的從頭算
    expect((await push(2, [item(1, 4000)], "198.51.100.2", handler)).status).toBe(200);
    await create(4, "198.51.100.4", handler);
    expect((await push(4, [item(1, 4000)], "198.51.100.4", handler)).status).toBe(200);
  });
});

describe("換金鑰的複製有自己的每日額度，同一個舊空間每天最多複製一份", () => {
  const rekeyCount = async () =>
    Number((await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE 'sync:rekey-writes%' AND slot=?", [Math.floor(now.getTime() / DAY)]))[0]!.n);

  async function setupDevice(handler: (r: Request) => Promise<Response>, records: number, hook?: (request: Request) => Promise<Response> | null) {
    const api = new SyncApi(
      "http://sync.test",
      (input, init) => {
        const request = new Request(input as string, init);
        return hook?.(request) ?? handler(request);
      },
      async (ms) => advance(ms),
    );
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
    await engine.ensureSpace();
    await engine.sync();
    advance(25 * HOUR);
    return { engine, state, api, identity, db };
  }

  /** 同一組同步金鑰的另一台（配對加入） */
  async function joinDevice(handler: (r: Request) => Promise<Response>, root: Uint8Array) {
    const api = new SyncApi("http://sync.test", (input, init) => handler(new Request(input as string, init)), async (ms) => advance(ms));
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    const identity = await newDeviceIdentity();
    const state: { root: Uint8Array } = { root: Uint8Array.from(root) };
    const engine = new SyncEngine(db, api, state.root, () => now, {
      identity,
      label: () => ({ name: "B", platform: "t" }),
      onRootChanged: async (r) => void (state.root = r),
    });
    await engine.sync();
    return { engine, state, api, identity, db };
  }

  const copiedToday = async (from: string) =>
    Number(
      (await driver.all("SELECT COALESCE(SUM(count), 0) AS n FROM rate_limits WHERE key LIKE ? AND slot=?", [`sync:rekey-copy:${from}%`, Math.floor(now.getTime() / DAY)]))[0]!.n,
    );
  const pendingOf = (from: string) => driver.all("SELECT id FROM spaces WHERE rekey_from=? AND id NOT IN (SELECT moved_to FROM moves)", [from]);
  const nextUtcDay = () => advance((Math.floor(now.getTime() / DAY) + 1) * DAY - now.getTime() + 60_000);

  it("一般的寫入最多用到扣掉換金鑰那一份的量；換金鑰的那一份用完：新空間照樣建立、複製停下來明天接著做，一般的送出與新空間照常", async () => {
    expect(REKEY_WRITE_SHARE).toBe(0.25);
    // 每天 400 列：換金鑰 100、一般 300、新空間與配對 200
    const handler = handlerWith({ dailyWrites: 400, rateLimits: { writes: {}, spaceWrites: 10_000 } });
    const a = await setupDevice(handler, 20);
    const from = (await deriveKeys(a.state.root)).space;
    // 換金鑰的那一份用完（直接把計數加滿）
    await limiter.take("sync:rekey-writes", { limit: 100, windowMs: DAY }, 100);
    await expect(a.engine.rekey()).rejects.toMatchObject({ name: "Error", done: 0, total: 20, message: expect.stringContaining("明天會自動接著做") });
    expect(await a.engine.pendingRekey()).toMatchObject({ done: 0, total: 20 });
    expect((await a.engine.pendingRekey())!.resumeAt).toBeGreaterThan(now.getTime());
    // 新空間留著（明天接著做）、舊的照常
    expect(await pendingOf(from)).toHaveLength(1);
    await a.engine.sync();
    // 一般的送出、新空間照常
    expect((await create(50, "198.51.100.50", handler)).status).toBe(200);
    expect((await push(50, [item(1, 10)], "198.51.100.50", handler)).status).toBe(200);
    // 一般的寫入用到 300 為止（換金鑰的那一份不給一般的用）
    const used = await writesToday();
    await limiter.take("sync:daily-writes", { limit: 300, windowMs: DAY }, 300 - used);
    expect(await push(50, [item(2, 10)], "198.51.100.50", handler)).toMatchObject({ status: 503, body: { state: "daily_limit" } });
    // 隔天接著做完
    nextUtcDay();
    const before = a.state.root;
    expect(await a.engine.resumeRekey()).not.toBeNull();
    expect(a.state.root).not.toEqual(before);
    expect(await store.movedTo(from)).not.toBeNull();
  });

  it("大空間跨好幾天完成：每天從斷掉的地方接著送（不重來），這段時間新增與改過的紀錄也帶過去，資料一筆不少", async () => {
    // 這一份每天 500 列：一批 100 筆估 310 列，一天只送得完一批
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const b = await joinDevice(handler, a.state.root);
    const from = (await deriveKeys(a.state.root)).space;
    const steps: string[] = [];
    // 第一天：100／300
    await expect(a.engine.rekey([], undefined, (p) => p.step === "copy" && steps.push(`${p.done}/${p.total}`))).rejects.toMatchObject({ done: 100, total: 300 });
    expect(await copiedToday(from)).toBe(100);
    const pendingSpace = (await a.engine.pendingRekey())!.space;
    // 換到一半的這段時間：B 照常同步，新增 5 筆、改 1 筆（舊空間）
    for (let i = 0; i < 5; i++) await b.db.saveCheckin({ date: `2026-10-0${i + 1}`, energy: 5, soreness: 1, sleep: 5, notes: `新的 ${i}` });
    await b.db.saveCheckin({ date: "2022-01-01", energy: 1, soreness: 5, sleep: 1, notes: "改過" });
    await b.engine.sync();
    // 第二天：從 100 接著送（改過的那筆要重送），只送一批
    nextUtcDay();
    await expect(a.engine.resumeRekey((p) => p.step === "copy" && steps.push(`${p.done}/${p.total}`))).rejects.toMatchObject({ done: 199, total: 305 });
    expect(await copiedToday(from)).toBe(100);
    expect((await a.engine.pendingRekey())!.space).toBe(pendingSpace);
    // 第三天：送完（含換到一半時新增與改過的），換金鑰完成
    nextUtcDay();
    expect(await a.engine.resumeRekey((p) => p.step === "copy" && steps.push(`${p.done}/${p.total}`))).not.toBeNull();
    expect((await deriveKeys(a.state.root)).space).toBe(pendingSpace);
    expect(steps[0]).toBe("0/300");
    expect(steps).toContain("99/305");
    expect(steps).toContain("199/305");
    expect(steps.at(-1)).toBe("305/305");
    expect(await copiedToday(from)).toBeLessThanOrEqual(110);
    // 新空間一筆不少；B 換過去後看得到全部，包括改過的那筆
    expect((await store.spaceUsage(pendingSpace)).records).toBe(305);
    await b.engine.sync();
    expect(b.state.root).toEqual(a.state.root);
    for (let i = 0; i < 300; i += 37) expect(await b.db.getCheckin(new Date(Date.UTC(2022, 0, 1) + i * DAY).toISOString().slice(0, 10))).not.toBeNull();
    expect(await b.db.getCheckin(new Date(Date.UTC(2022, 0, 1) + 299 * DAY).toISOString().slice(0, 10))).not.toBeNull();
    for (let i = 0; i < 5; i++) expect((await a.db.getCheckin(`2026-10-0${i + 1}`))?.notes).toBe(`新的 ${i}`);
    await a.engine.sync();
    expect((await a.db.getCheckin("2022-01-01"))?.notes).toBe("改過");
    expect(await pendingOf(from)).toHaveLength(0);
  });

  it("複製之後、換金鑰之前舊空間又有寫入：伺服器拒絕（rekey_behind），用戶端補送後完成，不漏資料", async () => {
    const handler = handlerWith();
    let b: Awaited<ReturnType<typeof joinDevice>> | null = null;
    let once = true;
    const a = await setupDevice(handler, 30, (request) => {
      const url = new URL(request.url);
      if (once && b && request.method === "POST" && url.pathname.endsWith("/rekey")) {
        once = false;
        // 就在送出換金鑰之前，B 寫了一筆到舊空間
        return (async () => {
          await b!.db.saveCheckin({ date: "2026-10-10", energy: 5, soreness: 1, sleep: 5, notes: "最後一刻" });
          await b!.engine.sync();
          return handler(request);
        })();
      }
      return null;
    });
    b = await joinDevice(handler, a.state.root);
    await a.engine.rekey();
    const newSpace = (await deriveKeys(a.state.root)).space;
    expect((await store.spaceUsage(newSpace)).records).toBe(31);
  });

  it("重開換金鑰不會讓複製量變多：接著做同一個；取消後重新開始也受同一個舊空間每天的上限；隔天恢復", async () => {
    let failRekey = 0;
    const handler = handlerWith();
    const a = await setupDevice(handler, 400, (request) => {
      const url = new URL(request.url);
      if (failRekey > 0 && request.method === "POST" && url.pathname.endsWith("/rekey")) {
        failRekey--;
        return Promise.resolve(Response.json({ error: "x" }, { status: 409, headers: { "content-type": "application/json" } }));
      }
      return null;
    });
    const from = (await deriveKeys(a.state.root)).space;
    failRekey = 2;
    // 第一次：整份複製完，最後一步失敗；新空間留著
    await expect(a.engine.rekey()).rejects.toMatchObject({ status: 409 });
    expect(await copiedToday(from)).toBe(400);
    // 第二次：接著做同一個，不重送
    await expect(a.engine.rekey()).rejects.toMatchObject({ status: 409 });
    expect(await copiedToday(from)).toBe(400);
    expect(await pendingOf(from)).toHaveLength(1);
    // 取消後重新開始：今天這個舊空間只剩寬容的 100 筆，送完就停（明天接著做）
    await a.engine.cancelRekey();
    expect(await pendingOf(from)).toHaveLength(0);
    advance(2 * 60_000);
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 100, total: 400 });
    expect(await copiedToday(from)).toBeLessThanOrEqual(400 + 100);
    expect(await pendingOf(from)).toHaveLength(1);
    // 舊的照常
    await a.engine.sync();
    // 隔天接著做完
    nextUtcDay();
    const before = a.state.root;
    await a.engine.resumeRekey();
    expect(a.state.root).not.toEqual(before);
    expect(await copiedToday(from)).toBe(300);
  });

  it("移除馬上生效：換金鑰還沒完成，被移除的那台就被拒絕、驗得過「已移除」；用舊的同步金鑰登記新的裝置也不行；完成後仍然被拒", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const b = await joinDevice(handler, a.state.root);
    const from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey([b.identity.id])).rejects.toMatchObject({ done: 100 });
    expect(await a.engine.pendingRekey()).toMatchObject({ removed: [b.identity.id] });
    // B 下一次同步：已移除（有 A 簽的聲明與用舊金鑰算的證明）
    await expect(b.engine.sync()).rejects.toMatchObject({ name: "Error", message: "這台已從同步移除" });
    // 拿著舊的同步金鑰（復原碼）用新的裝置 id 登記：換金鑰完成之前不行
    const c = await joinDevice(handler, a.state.root).catch((e: unknown) => e);
    expect(c).toMatchObject({ status: 409, state: "rekey_pending" });
    expect((await store.devices(from)).filter((d) => d.removedAt === null).map((d) => d.id)).toEqual([a.identity.id]);
    // A 照常同步，清單裡沒有 B
    expect((await a.engine.sync()).devices!.devices.map((d) => d.id)).toEqual([a.identity.id]);
    nextUtcDay();
    await expect(a.engine.resumeRekey()).rejects.toMatchObject({ done: 200 });
    nextUtcDay();
    await a.engine.resumeRekey();
    // 完成後：B 仍然是已移除；新空間只有 A
    await expect(b.engine.sync()).rejects.toMatchObject({ message: "這台已從同步移除" });
    const to = (await deriveKeys(a.state.root)).space;
    expect((await store.devices(to)).map((d) => d.id)).toEqual([a.identity.id]);
  });

  it("移除要過了冷卻期的裝置、要先有換到一半的新空間、聲明要對", async () => {
    const handler = handlerWith();
    const a = await setupDevice(handler, 5);
    const b = await joinDevice(handler, a.state.root);
    const from = (await deriveKeys(a.state.root)).space;
    const auth = { device: b.identity };
    // B 還在冷卻期
    await expect(b.api.request("POST", `/v1/spaces/${from}/remove`, { space: space(9), remove: [{ id: a.identity.id, proof: null }], statement: "x", signature: "y" }, auth)).rejects.toMatchObject({
      state: "cooldown",
    });
    // A：沒有換到一半的新空間
    await expect(a.api.request("POST", `/v1/spaces/${from}/remove`, { space: space(9), remove: [{ id: b.identity.id, proof: null }], statement: "x", signature: "y" }, { device: a.identity })).rejects.toMatchObject({
      status: 409,
      state: "rekey_conflict",
    });
    expect((await store.device(from, b.identity.id))!.removedAt).toBeNull();
  });

  it("放棄很久（7 天沒有進度）的新空間被清掉；空空間的清理不動還在進行的；之後重新開始照樣完成", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 100 });
    // 換到一半、還沒有任何紀錄的新空間（例如第一天額度一開始就用完）：空空間的清理也不動
    await store.createSpace(space(77), await sha256(TOKEN), null, space(76));
    advance(2 * DAY);
    expect(await maintain(store)).toMatchObject({ spaces: 0, staleRekeys: 0 });
    expect(await store.spaceToken(space(77))).not.toBeNull();
    expect(await pendingOf(from)).toHaveLength(1);
    advance(6 * DAY);
    expect(await maintain(store)).toMatchObject({ staleRekeys: 2 });
    expect(await pendingOf(from)).toHaveLength(0);
    expect(await store.spaceToken(space(77))).toBeNull();
    // 這台接著做時發現不在了：清掉這台的紀錄；再按一次重新開始，照樣完成（每天一批）
    await expect(a.engine.resumeRekey()).rejects.toMatchObject({ status: 404 });
    expect(await a.engine.pendingRekey()).toBeNull();
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 100 });
    for (let day = 0; day < 2; day++) {
      nextUtcDay();
      await a.engine.resumeRekey().catch(() => undefined);
    }
    expect(await store.movedTo(from)).not.toBeNull();
  });

  it("兩台同時互相移除：只有先到的生效；換到一半的新空間不在時移除也不生效", async () => {
    await store.createSpace(space(1), await sha256(TOKEN));
    for (const id of ["A".repeat(22), "B".repeat(22)]) await store.addDevice(space(1), { id, signPub: "p", boxPub: "b", label: "l", legacy: false });
    await store.createSpace(space(2), await sha256(TOKEN), null, space(1), null, "A".repeat(22));
    const removal = (signer: string) => ({ signer, statement: `s-${signer}`, signature: "g" });
    // 不是這個舊空間換到一半的新空間：不生效
    expect(await store.removeDevices(space(1), space(9), [{ id: "B".repeat(22), proof: null }], removal("A".repeat(22)))).toBe(0);
    // A 先到：B 被移除；B 同時送的移除 A（檢查都過了）不生效，因為 B 已經被移除
    expect(await store.removeDevices(space(1), space(2), [{ id: "B".repeat(22), proof: null }], removal("A".repeat(22)))).toBe(1);
    expect(await store.removeDevices(space(1), space(2), [{ id: "A".repeat(22), proof: null }], removal("B".repeat(22)))).toBe(0);
    expect((await store.device(space(1), "A".repeat(22)))!.removedAt).toBeNull();
  });

  it("登記的檢查與寫入在同一個敘述：換到一半、有先移除的不能登記；換到一半的新空間可以（登記要有新空間的憑證）", async () => {
    const dev = (id: string) => ({ id, signPub: "p", boxPub: "b", label: "l", legacy: false });
    await store.createSpace(space(1), await sha256(TOKEN));
    expect(await store.addDevice(space(1), dev("A".repeat(22)))).toBe(true);
    await store.createSpace(space(2), await sha256(TOKEN), null, space(1), null, "A".repeat(22));
    expect(await store.addDevice(space(1), dev("C".repeat(22)))).toBe(false);
    expect(await store.addDevice(space(2), dev("A".repeat(22)))).toBe(true);
    expect(await store.addDevice(space(2), dev("C".repeat(22)))).toBe(true);
    // 換到一半的放棄了，但有先移除、還沒換金鑰的：一樣不能登記
    await store.addDevice(space(3), dev("x".repeat(22)));
    await store.createSpace(space(4), await sha256(TOKEN));
    await store.addDevice(space(4), dev("A".repeat(22)));
    await store.addDevice(space(4), dev("B".repeat(22)));
    await store.createSpace(space(5), await sha256(TOKEN), null, space(4), null, "A".repeat(22));
    await store.removeDevices(space(4), space(5), [{ id: "B".repeat(22), proof: null }], { signer: "A".repeat(22), statement: "s", signature: "g" });
    await store.deleteSingleSpace(space(5));
    expect(await store.addDevice(space(4), dev("C".repeat(22)))).toBe(false);
  });

  it("開始之後清單裡出現沒確認過的裝置：不給它新的金鑰，放棄這次、請使用者重新確認", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 100 });
    // 繞過登記的檢查塞進一台（代表檢查之前就登記成功的）
    const x = await newDeviceIdentity();
    await driver.run("INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) VALUES (?, ?, ?, ?, 'x', 0, 0, 0)", [from, x.id, x.signPub, x.boxPub]);
    nextUtcDay();
    await expect(a.engine.resumeRekey()).rejects.toMatchObject({ status: 409, state: "devices_changed" });
    expect(await pendingOf(from)).toHaveLength(0);
    expect(await a.engine.pendingRekey()).toBeNull();
    expect(await store.movedTo(from)).toBeNull();
  });

  it("換到一半的新空間裡別台（持有新的同步金鑰）送的複製：份額照開始換金鑰的那台算，不會多一份", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 100 });
    const newSpace = String((await pendingOf(from))[0]!.id);
    const other = await newDeviceIdentity();
    await driver.run("INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) VALUES (?, ?, ?, ?, 'x', 0, 0, 0)", [newSpace, other.id, other.signPub, other.boxPub]);
    const deviceBuckets = async () => (await driver.all("SELECT key, SUM(count) AS n FROM rate_limits WHERE key LIKE 'sync:rekey-device%' GROUP BY key")).map((r) => [String(r.key), Number(r.n)]);
    const before = await deviceBuckets();
    expect(before).toHaveLength(1);
    await a.api.request("POST", `/v1/spaces/${newSpace}/changes`, { items: [item(900, 10)] }, { device: other }).catch(() => undefined);
    const after = await deviceBuckets();
    // 同一個桶（開始的那台），沒有另外開一個
    expect(after).toHaveLength(1);
    expect(after[0]![0]).toBe(before[0]![0]);
  });

  it("在新空間登記之前就放棄：在舊空間簽章放棄，伺服器上的也清掉，之後可以加入新的裝置", async () => {
    let failRegister = true;
    let from = "";
    const handler = handlerWith();
    const a = await setupDevice(handler, 20, (request) => {
      const url = new URL(request.url);
      if (failRegister && request.method === "POST" && url.pathname.endsWith("/devices") && url.searchParams.size === 0) {
        const target = url.pathname.split("/")[3];
        if (from && target !== from) return Promise.reject(new Error("斷線"));
      }
      return null;
    });
    from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey()).rejects.toThrow(/連不上/);
    expect(await pendingOf(from)).toHaveLength(1);
    await a.engine.cancelRekey();
    expect(await pendingOf(from)).toHaveLength(0);
    expect(await a.engine.pendingRekey()).toBeNull();
    failRegister = false;
    const b = await joinDevice(handler, a.state.root);
    expect((await b.engine.sync()).devices!.devices).toHaveLength(2);
  });

  it("續傳時改過很多筆（超過寬容的筆數）：仍然算換金鑰的複製（只算新的筆數與大小的差）", async () => {
    let failRekey = 1;
    const handler = handlerWith();
    const a = await setupDevice(handler, 300, (request) => {
      if (failRekey > 0 && request.method === "POST" && new URL(request.url).pathname.endsWith("/rekey")) {
        failRekey--;
        return Promise.resolve(Response.json({ error: "x" }, { status: 409, headers: { "content-type": "application/json" } }));
      }
      return null;
    });
    const from = (await deriveKeys(a.state.root)).space;
    await expect(a.engine.rekey()).rejects.toMatchObject({ status: 409 });
    const newSpace = String((await pendingOf(from))[0]!.id);
    // 複製之後舊空間改了 60 筆（超過寬容的 50 筆；同一個舊空間一天的上限 375 筆之內）
    for (let i = 0; i < 60; i++) {
      await a.db.saveCheckin({ date: new Date(Date.UTC(2022, 0, 1) + i * DAY).toISOString().slice(0, 10), energy: 1, soreness: 1, sleep: 1, notes: `改過 ${i}` });
    }
    await a.engine.sync();
    await a.engine.rekey();
    expect(await store.movedTo(from)).toBe(newSpace);
    expect(await copiedToday(from)).toBe(360);
    expect(await driver.all("SELECT key FROM rate_limits WHERE key LIKE ?", [`sync:space-writes:${newSpace}%`])).toHaveLength(0);
  });

  it("換金鑰完成之後才到的送出不寫進已經搬走的舊空間", async () => {
    await store.createSpace(space(1), await sha256(TOKEN));
    await store.createSpace(space(2), await sha256(TOKEN), null, space(1));
    await store.rekey(space(1), { newSpace: space(2), caller: "x", keep: [], remove: [], statement: "s", signature: "g" });
    const result = await store.putMany(space(1), [item(1, 10)]);
    expect(result.applied).toHaveLength(0);
    expect((await store.changes(space(1), 0, 10)).length).toBe(0);
  });

  it("開始換金鑰的那台搬到一半不見了：用移除時拿到的新復原碼還原的裝置接手完成，資料一筆不少；舊的復原碼不行；份額照開始的那台算", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const b = await joinDevice(handler, a.state.root);
    const oldRoot = Uint8Array.from(a.state.root);
    const from = (await deriveKeys(oldRoot)).space;
    // 移除之前先拿到新的復原碼
    const newRoot = await a.engine.prepareRekey([b.identity.id]);
    expect((await a.engine.pendingRekey())!.codeGiven).toBe(true);
    await expect(a.engine.rekey([b.identity.id])).rejects.toMatchObject({ done: 100, total: 300 });
    // A 不見了（本機清掉）；只拿舊的復原碼的加不進來
    expect(await joinDevice(handler, oldRoot).catch((e: unknown) => e)).toMatchObject({ status: 409, state: "rekey_pending" });
    // 用新的復原碼還原：登記在換到一半的新空間，看得到要接手
    const c = await joinDevice(handler, newRoot);
    const view = await c.engine.sync();
    expect(view.devices!.rekeyTarget).toBe(true);
    // 今天開始的那台的份額已經用完：接手也一樣停下來（不會多一份）
    await expect(c.engine.takeover()).rejects.toMatchObject({ done: 100, total: 300 });
    nextUtcDay();
    await expect(c.engine.takeover()).rejects.toMatchObject({ done: 200, total: 300 });
    expect(await c.engine.takeoverStatus()).toMatchObject({ done: 200, total: 300 });
    nextUtcDay();
    await c.engine.takeover();
    const to = (await deriveKeys(newRoot)).space;
    expect(await store.movedTo(from)).toBe(to);
    expect((await store.spaceUsage(to)).records).toBe(300);
    expect(await c.engine.takeoverStatus()).toBeNull();
    expect((await c.engine.sync()).devices!.rekeyTarget).toBe(false);
    for (let i = 0; i < 300; i += 61) expect(await c.db.getCheckin(new Date(Date.UTC(2022, 0, 1) + i * DAY).toISOString().slice(0, 10))).not.toBeNull();
    // 每台的份額只有開始的那台一個桶
    expect(await driver.all("SELECT DISTINCT key FROM rate_limits WHERE key LIKE 'sync:rekey-device%'")).toHaveLength(1);
    // 被移除的 B 仍然被拒；A 回來時跟著搬到新空間
    await expect(b.engine.sync()).rejects.toMatchObject({ message: "這台已從同步移除" });
    await a.engine.sync();
    expect(a.state.root).toEqual(newRoot);
  });

  it("已經提早移除過的換金鑰：不能取消、不能被取代、不會被 7 天沒進度的排程清掉", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const b = await joinDevice(handler, a.state.root);
    const from = (await deriveKeys(a.state.root)).space;
    await a.engine.prepareRekey([b.identity.id]);
    await expect(a.engine.rekey([b.identity.id])).rejects.toMatchObject({ done: 100 });
    await expect(a.engine.cancelRekey()).rejects.toThrow(/只能完成/);
    await expect(a.api.request("DELETE", `/v1/spaces/${from}/rekey`, undefined, { device: a.identity })).rejects.toMatchObject({ status: 409, state: "rekey_locked" });
    const newSpace = String((await pendingOf(from))[0]!.id);
    await expect(a.api.request("DELETE", `/v1/spaces/${newSpace}?abandon=1`, undefined, { device: a.identity })).rejects.toMatchObject({ status: 409, state: "rekey_locked" });
    await expect(a.api.request("PUT", `/v1/spaces/${space(999)}?create=1&devices=1&from=${from}&replace=1`, undefined, { device: a.identity, token: TOKEN })).rejects.toMatchObject({
      status: 409,
      state: "rekey_locked",
    });
    advance(10 * DAY);
    expect(await maintain(store)).toMatchObject({ staleRekeys: 0 });
    expect(await pendingOf(from)).toHaveLength(1);
  });

  it("沒有提早移除過的換金鑰不能用新的復原碼接手完成", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 500 } });
    const a = await setupDevice(handler, 300);
    const newRoot = await a.engine.prepareRekey([]);
    const c = await joinDevice(handler, newRoot);
    await expect(c.engine.takeover()).rejects.toMatchObject({ status: 403 });
  });

  it("正常大小的換金鑰照樣一次完成（每天額度調小）", async () => {
    expect(REKEY_ACTOR_SHARE).toBe(0.25);
    // 每天 12,000 列：換金鑰的那一份 3,000 列、每台每個來源 750 列，200 筆的複製（約 620 列）一次搬得完
    const handler = handlerWith({ dailyWrites: 12_000, rateLimits: { writes: {}, spaceWrites: 10_000 } });
    const a = await setupDevice(handler, 200);
    const before = a.state.root;
    await a.engine.rekey();
    expect(a.state.root).not.toEqual(before);
    expect(await rekeyCount()).toBeGreaterThanOrEqual(3 * 200);
    expect(await rekeyCount()).toBeLessThanOrEqual(750);
  });

  it("每台裝置每天只能用掉換金鑰那一份的一小部分，接連換好幾次金鑰也一起算；別的裝置與來源照常換", async () => {
    // 換金鑰的那一份 4,000 列，每台、每個來源 1,000 列（約 320 筆）
    const handler = handlerWith({ rateLimits: { rekeyWrites: 4000 } });
    const ip = (value: string) => (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", value);
      return handler(new Request(request, { headers }));
    };
    const a = await setupDevice(ip("198.51.100.10"), 250);
    const from = (await deriveKeys(a.state.root)).space;
    // 第一次：250 筆一次完成
    await a.engine.rekey();
    const second = (await deriveKeys(a.state.root)).space;
    expect(second).not.toBe(from);
    // 一分鐘後馬上再換（新空間、新的「每個舊空間」份額）：這台今天的份額用完，停下來
    advance(61_000);
    await expect(a.engine.rekey()).rejects.toMatchObject({ done: 0, total: 250 });
    expect(await rekeyCount()).toBeLessThanOrEqual(1000);
    // 另一個網段的另一個人照常換金鑰
    const other = await setupDevice(ip("203.0.113.20"), 250);
    const before = other.state.root;
    await other.engine.rekey();
    expect(other.state.root).not.toEqual(before);
    // A 隔天接著做完
    advance(DAY);
    await a.engine.resumeRekey();
    expect(await store.movedTo(second)).not.toBeNull();
  });

  it("同一個網段的好幾台一起用：每個來源每天也只能用掉一小部分", async () => {
    const handler = handlerWith({ rateLimits: { rekeyWrites: 4000 } });
    const ip = (value: string) => (request: Request) => {
      const headers = new Headers(request.headers);
      headers.set("cf-connecting-ip", value);
      return handler(new Request(request, { headers }));
    };
    const a = await setupDevice(ip("198.51.100.30"), 250);
    const b = await setupDevice(ip("198.51.100.31"), 250);
    await a.engine.rekey();
    // 同一個 /24 的另一台（另一個空間）：這個來源今天剩不到一批，停下來
    await expect(b.engine.rekey()).rejects.toMatchObject({ total: 250 });
    expect((await b.engine.pendingRekey())!.done).toBeLessThan(250);
    expect(await rekeyCount()).toBeLessThanOrEqual(1000);
  });
});

describe("預設的寫入額度", () => {
  it("每個來源與每個空間的上限照整個服務的額度算", () => {
    expect(Math.floor(DEFAULT_DAILY_WRITES * SOURCE_WRITE_SHARE.narrow)).toBe(4000);
    expect(Math.floor(DEFAULT_DAILY_WRITES * SPACE_WRITE_SHARE)).toBe(4000);
  });
});
