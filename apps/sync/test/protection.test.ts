/**
 * 同步服務的保護（規格 12.10）：依來源的多層計數、建立空間與開配對碼前的人機驗證（Turnstile）、容量上限、
 * 整個服務每天的寫入上限、只接受 application/json、配對每一步的頻率限制.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, newDeviceIdentity, newRootKey, SyncApi, SyncEngine, memoryRekeyKeyStore } from "@running-coach/core";
import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createSyncHandler, DEFAULT_LIMITS, MAX_SPACE_BYTES, type SyncDeps } from "../src/handler";
import { RECORD_OVERHEAD, SyncStore } from "../src/store";
import { DUMMY_TOKEN, fakeTurnstileFetch, TEST_SECRET_FAIL, TEST_SECRET_PASS, TEST_SECRET_SPENT } from "../src/turnstile-testing";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TOKEN = "t".repeat(43);

let now: Date;
let driver: NodeSqliteDriver;
let store: SyncStore;
let limiter: SqlRateLimiter;

beforeEach(async () => {
  now = new Date("2026-11-18T03:00:00Z");
  driver = openNodeSqlite(":memory:");
  store = new SyncStore(driver, () => now);
  await store.init();
  limiter = new SqlRateLimiter(driver, () => now.getTime());
  await limiter.init();
});

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/** 像 Workers 一樣每個請求都重新建立處理器 */
const handlerWith =
  (extra: Partial<SyncDeps> = {}) =>
  (request: Request) =>
    createSyncHandler({ store, allowedOrigins: ["https://app.example"], rateLimiter: limiter, ...extra })(request);

const space = (n: number) => n.toString(16).padStart(32, "0");

interface CallOptions {
  ip?: string;
  body?: unknown;
  handler?: (r: Request) => Promise<Response>;
  headers?: Record<string, string>;
  /** 原樣送出的內容（不轉 JSON、不自動帶 content-type） */
  raw?: string;
}

async function call(method: string, path: string, opts: CallOptions = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, ...opts.headers };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  const handle = opts.handler ?? handlerWith();
  const body = opts.raw ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body));
  const res = await handle(new Request(`http://sync.test${path}`, { method, headers, body }));
  const text = await res.text();
  return { status: res.status, body: (text ? JSON.parse(text) : {}) as Record<string, any>, headers: res.headers };
}

const create = (n: number, ip: string, handler?: (r: Request) => Promise<Response>, headers?: Record<string, string>) =>
  call("PUT", `/v1/spaces/${space(n)}?create=1`, { ip, handler, headers });

const item = (id: number, size: number) => ({ id: `record${String(id).padStart(10, "0")}`, base: 0, blob: "b".repeat(size) });

describe("依來源的多層計數", () => {
  it("IPv6：同一個 /48 的不同 /64（也在不同的 /56）累積到 /48 的上限；隔壁的 /48 不受影響", async () => {
    // /48 每小時 20 個；每個 /64、/56 只用一次，都還沒到自己的上限
    for (let i = 0; i < 20; i++) expect((await create(i, `2001:db8:aa:${(i << 8).toString(16)}::1`)).status).toBe(200);
    const blocked = await create(50, "2001:db8:aa:ff00::1");
    expect(blocked).toMatchObject({ status: 429, body: { state: "rate_limited" } });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    // 隔壁的 /48
    expect((await create(51, "2001:db8:ab:ff00::1")).status).toBe(200);
    // 過了一小時恢復
    advance(HOUR);
    expect((await create(52, "2001:db8:aa:ff00::1")).status).toBe(200);
  });

  it("IPv6：同一個 /56 的不同 /64 累積到 /56 的上限；同一個 /48 的另一個 /56 不受影響", async () => {
    for (let i = 0; i < 10; i++) expect((await create(i, `2001:db8:aa:10${i.toString(16).padStart(2, "0")}::1`)).status).toBe(200);
    expect((await create(60, "2001:db8:aa:10ff::1")).status).toBe(429);
    expect((await create(61, "2001:db8:aa:2000::1")).status).toBe(200);
  });

  it("IPv4：同一個 /24 的不同位址累積到 /24 的上限；隔壁的 /24 不受影響", async () => {
    for (let i = 0; i < 20; i++) expect((await create(i, `198.51.100.${i + 1}`)).status).toBe(200);
    expect((await create(70, "198.51.100.200")).status).toBe(429);
    expect((await create(71, "198.51.101.1")).status).toBe(200);
  });

  it("被寬的層擋下時，窄的層不會被用掉", async () => {
    for (let i = 0; i < 20; i++) await create(i, `198.51.100.${i + 1}`);
    // 這個位址被 /24 擋了好幾次
    for (let i = 0; i < 8; i++) expect((await create(100 + i, "198.51.100.250")).status).toBe(429);
    // /24 的時間窗過了以後，它自己的每小時 5 個還在
    advance(HOUR);
    for (let i = 0; i < 5; i++) expect((await create(200 + i, "198.51.100.250")).status).toBe(200);
    expect((await create(210, "198.51.100.250")).status).toBe(429);
  });

  it("計數只存雜湊，看不到 IP 與前綴", async () => {
    await create(1, "2001:db8:aa:bb::1");
    await create(2, "198.51.100.7");
    const keys = JSON.stringify(await driver.all("SELECT key FROM rate_limits"));
    for (const part of ["2001", "db8", "198.51", "aa:bb"]) expect(keys).not.toContain(part);
  });
});

describe("人機驗證（Turnstile）", () => {
  const withSecret = (secret: string, calls: Record<string, string>[] = []) => handlerWith({ turnstile: { secret, fetch: fakeTurnstileFetch(calls) } });
  const human = { "x-turnstile": DUMMY_TOKEN };

  it("建立空間：沒有 token、錯的 token、用過的 token 都拒絕；正確的測試 token 通過", async () => {
    const pass = withSecret(TEST_SECRET_PASS);
    expect(await create(1, "198.51.100.1", pass)).toMatchObject({ status: 403, body: { state: "human_check", reason: "missing" } });
    expect(await create(2, "198.51.100.1", withSecret(TEST_SECRET_FAIL), human)).toMatchObject({ status: 403, body: { state: "human_check", reason: "failed" } });
    expect(await create(3, "198.51.100.1", withSecret(TEST_SECRET_SPENT), human)).toMatchObject({ status: 403, body: { state: "human_check", reason: "failed" } });
    expect(await create(4, "198.51.100.1", pass, { "x-turnstile": "not a token!" })).toMatchObject({ status: 403, body: { reason: "failed" } });
    expect(await create(5, "198.51.100.1", pass, human)).toMatchObject({ status: 200, body: { created: true } });
    // 被拒絕的都沒有建立
    for (const n of [1, 2, 3, 4]) expect(await store.spaceToken(space(n))).toBeNull();
    // 已經有的空間（每次同步都會確認）不用再驗證
    expect(await create(5, "198.51.100.1", pass)).toMatchObject({ status: 200, body: { created: false } });
  });

  it("開配對碼要驗證；配對的其他步驟不用", async () => {
    const pass = withSecret(TEST_SECRET_PASS);
    const body = { pub: "PUB", commitment: "C" };
    expect(await call("POST", "/v1/pair", { handler: pass, body })).toMatchObject({ status: 403, body: { state: "human_check" } });
    const opened = await call("POST", "/v1/pair", { handler: pass, body, headers: human });
    expect(opened.status).toBe(200);
    const slot = opened.body.slot as string;
    expect((await call("GET", `/v1/pair/${slot}`, { handler: pass })).status).toBe(200);
    expect((await call("POST", `/v1/pair/${slot}/hello`, { handler: pass, body: { pub: "OLD" } })).status).toBe(200);
  });

  it("送去 Turnstile 的只有 secret 與 token（不送 IP）；給別的步驟的 token 不能用", async () => {
    const calls: Record<string, string>[] = [];
    await create(1, "198.51.100.1", withSecret(TEST_SECRET_PASS, calls), human);
    expect(calls).toEqual([{ secret: TEST_SECRET_PASS, response: DUMMY_TOKEN }]);
    const pairToken = handlerWith({
      turnstile: { secret: "s", fetch: async () => new Response(JSON.stringify({ success: true, action: "pair" })) },
    });
    expect(await create(2, "198.51.100.1", pairToken, human)).toMatchObject({ status: 403, body: { reason: "failed" } });
  });

  it("Turnstile 連不上或 secret 設錯：503，說明是暫時的", async () => {
    const down = handlerWith({ turnstile: { secret: TEST_SECRET_PASS, fetch: async () => Promise.reject(new Error("offline")) } });
    expect(await create(1, "198.51.100.1", down, human)).toMatchObject({ status: 503, body: { state: "human_check_unavailable" } });
    expect(await create(2, "198.51.100.1", withSecret("wrong-secret"), human)).toMatchObject({ status: 503, body: { state: "human_check_unavailable" } });
  });

  it("沒有設定時不驗證（本機、模擬服務、E2E）", async () => {
    expect((await create(1, "198.51.100.1")).status).toBe(200);
    expect((await call("POST", "/v1/pair", { body: { pub: "PUB", commitment: "C" } })).status).toBe(200);
  });

  it("CORS 允許帶 token 的標頭", async () => {
    const res = await handlerWith()(new Request("http://sync.test/v1/pair", { method: "OPTIONS", headers: { origin: "https://app.example" } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-turnstile");
  });

  it("用引擎開始同步帶 token；換金鑰的新空間（舊空間的裝置簽章）不用驗證", async () => {
    const handle = handlerWith({ turnstile: { secret: TEST_SECRET_PASS, fetch: fakeTurnstileFetch() }, cooldownMs: 0 });
    const api = new SyncApi("http://sync.test", (input, init) => handle(new Request(input as string, init)));
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    await db.saveCheckin({ date: "2026-11-17", energy: 3, soreness: 2, sleep: 4, notes: "x" });
    let root = newRootKey();
    const engine = new SyncEngine(db, api, root, () => now, {
      identity: await newDeviceIdentity(),
      label: () => ({ name: "A", platform: "test" }),
      rekeyKey: memoryRekeyKeyStore(),
      onRootChanged: async (r) => void (root = r),
    });
    await expect(engine.ensureSpace()).rejects.toMatchObject({ status: 403, message: "人機驗證沒有通過或已經過期，請再試一次" });
    expect(await engine.ensureSpace(DUMMY_TOKEN)).toBe(true);
    await engine.sync();
    advance(2 * 60_000);
    const before = root;
    await engine.rekey();
    expect(root).not.toEqual(before);
  });
});

describe("容量", () => {
  it("上限對齊 Cloudflare 免費方案：總共約 300 MB、每個空間約 25 MB", () => {
    expect(DEFAULT_LIMITS.bytes).toBe(300_000_000);
    expect(MAX_SPACE_BYTES).toBe(25_000_000);
  });

  it("一個空間超過 25 MB（內容加上每筆的固定額外）時 413；整個服務還有空間", async () => {
    await create(1, "198.51.100.1");
    // 每天的位元組另外有上限：這裡一天送一次
    const big = 1_390_000;
    let id = 0;
    let status = 200;
    let pushes = 0;
    while (status === 200 && pushes < 20) {
      status = (await call("POST", `/v1/spaces/${space(1)}/changes`, { ip: "198.51.100.1", body: { items: [item(id++, big), item(id++, big)] } })).status;
      pushes++;
      advance(DAY);
    }
    expect(status).toBe(413);
    const bytes = (await store.spaceUsage(space(1))).bytes;
    expect(bytes).toBeLessThanOrEqual(MAX_SPACE_BYTES);
    expect(bytes).toBeGreaterThan(MAX_SPACE_BYTES - 2 * (big + RECORD_OVERHEAD));
  });

  it("很多筆很小的紀錄也算進大小（每筆的固定額外）", async () => {
    await create(1, "198.51.100.1");
    await call("POST", `/v1/spaces/${space(1)}/changes`, { ip: "198.51.100.1", body: { items: Array.from({ length: 200 }, (_, i) => item(i, 1)) } });
    expect((await store.spaceUsage(space(1))).bytes).toBe(200 * (1 + RECORD_OVERHEAD));
  });

  it("換金鑰的新空間（還沒換完）可以暫時超過總量一個空間的量；一般的空間不行", async () => {
    const handler = handlerWith({ limits: { bytes: 1000 } });
    await create(1, "198.51.100.1", handler);
    await create(2, "198.51.100.1", handler);
    expect((await call("POST", `/v1/spaces/${space(1)}/changes`, { handler, body: { items: [item(1, 700)] } })).status).toBe(200);
    // 換金鑰的新空間（直接寫進儲存，代表舊空間的裝置建立的）；複製要由開始換金鑰的那台送
    const starter = await newDeviceIdentity();
    const pub = { id: starter.id, signPub: starter.signPub, boxPub: starter.boxPub, label: "x", legacy: false };
    await store.addDevice(space(1), pub);
    await store.createSpace(space(3), await sha256(TOKEN), null, space(1), null, starter.id);
    await store.addDevice(space(3), pub);
    const signed = new SyncApi("http://sync.test", (input, init) => handler(new Request(input as string, init)));
    await signed.request("POST", `/v1/spaces/${space(3)}/changes`, { items: [item(1, 700)] }, { device: starter });
    expect(await call("POST", `/v1/spaces/${space(2)}/changes`, { handler, body: { items: [item(1, 700)] } })).toMatchObject({ status: 503 });
  });
});

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("整個服務每天的寫入上限", () => {
  it("用到一半時停止新的空間與配對碼，已經在同步的照常送出；用完時送出也停止；隔天（UTC）恢復", async () => {
    // 這裡只看整個服務的上限：每個來源、每個空間的比例另外測
    const handler = handlerWith({ dailyWrites: 98, rateLimits: { writes: {}, spaceWrites: 1000, rekeyWrites: 0 } });
    // 建立空間估 12 列：一半是 49，前 4 個可以
    for (let i = 0; i < 4; i++) expect((await create(i, `198.51.100.${i + 1}`, handler)).status).toBe(200);
    const full = await create(9, "198.51.100.9", handler);
    expect(full).toMatchObject({ status: 503, body: { state: "daily_limit" } });
    // 到 UTC 午夜的秒數
    expect(Number(full.headers.get("retry-after"))).toBe(21 * 3600);
    expect(await call("POST", "/v1/pair", { handler, body: { pub: "PUB", commitment: "C" } })).toMatchObject({ status: 503, body: { state: "daily_limit" } });
    // 已經有的空間照常送出（送出 1 筆估 13 列）
    expect((await call("POST", `/v1/spaces/${space(0)}/changes`, { handler, body: { items: [item(1, 10)] } })).status).toBe(200);
    expect((await call("POST", `/v1/spaces/${space(1)}/changes`, { handler, body: { items: [item(1, 10)] } })).status).toBe(200);
    expect((await call("POST", `/v1/spaces/${space(2)}/changes`, { handler, body: { items: [item(1, 10)] } })).status).toBe(200);
    expect(await call("POST", `/v1/spaces/${space(3)}/changes`, { handler, body: { items: [item(1, 10)] } })).toMatchObject({ status: 503, body: { state: "daily_limit" } });
    // 被擋下的送出沒有寫入
    expect((await call("GET", `/v1/spaces/${space(3)}/changes`, { handler })).body.items).toHaveLength(0);
    // 讀取不受影響
    expect((await call("GET", `/v1/spaces/${space(0)}/changes`, { handler })).body.items).toHaveLength(1);
    advance(21 * HOUR);
    expect((await create(9, "198.51.100.9", handler)).status).toBe(200);
    expect((await call("POST", `/v1/spaces/${space(3)}/changes`, { handler, body: { items: [item(1, 10)] } })).status).toBe(200);
  });

  it("沒有計數（本機的模擬服務）時不限制", async () => {
    const handler = (request: Request) => createSyncHandler({ store, allowedOrigins: [], dailyWrites: 10 })(request);
    for (let i = 0; i < 5; i++) expect((await create(i, "198.51.100.1", handler)).status).toBe(200);
  });

  it("引擎看到每日上限時顯示明天會恢復", async () => {
    const handler = handlerWith({ dailyWrites: 30, rateLimits: { writes: {} } });
    const api = new SyncApi("http://sync.test", (input, init) => handler(new Request(input as string, init)));
    await api.request("PUT", `/v1/spaces/${space(1)}?create=1`, undefined, TOKEN);
    await expect(api.request("PUT", `/v1/spaces/${space(2)}?create=1`, undefined, TOKEN)).rejects.toMatchObject({
      status: 503,
      message: "今天的同步量已達上限，明天會自動恢復；資料都還在這台",
    });
  });
});

describe("只接受 application/json", () => {
  it("text/plain、表單、沒有 content-type 的 POST 都是 415，不建立配對碼；preflight 照舊", async () => {
    const body = JSON.stringify({ pub: "PUB", commitment: "C" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x", "application/jsonp"]) {
      expect((await call("POST", "/v1/pair", { raw: body, headers: { "content-type": type } })).status).toBe(415);
    }
    expect((await call("POST", "/v1/pair", { raw: body })).status).toBe(415);
    expect(await store.activeSlots()).toBe(0);
    expect((await call("POST", "/v1/pair", { raw: body, headers: { "content-type": "application/json; charset=utf-8" } })).status).toBe(200);
    // 沒有內容的 PUT（開始同步）、DELETE 照舊
    expect((await create(1, "198.51.100.1")).status).toBe(200);
    const preflight = await handlerWith()(
      new Request("http://sync.test/v1/pair", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } }),
    );
    expect(preflight.status).toBe(204);
  });

  it("送出紀錄也一樣", async () => {
    await create(1, "198.51.100.1");
    const raw = JSON.stringify({ items: [item(1, 10)] });
    expect((await call("POST", `/v1/spaces/${space(1)}/changes`, { raw, headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect((await call("GET", `/v1/spaces/${space(1)}/changes`)).body.items).toHaveLength(0);
  });
});

describe("配對每一步的頻率限制", () => {
  const ip = "203.0.113.5";

  it("查不存在的配對碼：每小時 20 次；用完後查任何配對碼都是 429；查得到的不算", async () => {
    const opened = await call("POST", "/v1/pair", { ip: "203.0.113.99", body: { pub: "PUB", commitment: "C" } });
    const slot = opened.body.slot as string;
    // 等另一台時每 2 秒查一次：查得到的不算
    for (let i = 0; i < 100; i++) expect((await call("GET", `/v1/pair/${slot}`, { ip })).status).toBe(200);
    for (let i = 0; i < 20; i++) expect((await call("GET", `/v1/pair/ZZZZZZZ${(i % 10).toString()}`, { ip })).status).toBe(404);
    expect((await call("GET", "/v1/pair/ZZZZZZZZ", { ip })).status).toBe(429);
    expect((await call("GET", `/v1/pair/${slot}`, { ip })).status).toBe(429);
    // 別的位址照常
    expect((await call("GET", `/v1/pair/${slot}`, { ip: "203.0.114.5" })).status).toBe(200);
  });

  it("hello、nonce、box 與取消：每小時 30 次", async () => {
    for (let i = 0; i < 30; i++) {
      const status = (await call("POST", "/v1/pair/ZZZZZZZZ/hello", { ip, body: { pub: "OLD" } })).status;
      expect(status).toBe(409);
    }
    expect((await call("POST", "/v1/pair/ZZZZZZZZ/hello", { ip, body: { pub: "OLD" } })).status).toBe(429);
    expect((await call("DELETE", "/v1/pair/ZZZZZZZZ", { ip })).status).toBe(429);
    expect((await call("DELETE", "/v1/pair/ZZZZZZZZ", { ip: "203.0.114.5" })).status).toBe(200);
  });
});
