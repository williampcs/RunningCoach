/** 同步服務的頻率限制與容量（規格 12.10）：依來源的限制跨請求有效、空的空間自動清掉、換金鑰不受空間數擋、並行時不越過總量. */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, deriveKeys, newDeviceIdentity, newRootKey, SyncApi, SyncEngine, type DeviceIdentity } from "@running-coach/core";
import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createSyncHandler, maintain, type ServiceLimits, type SyncDeps, type SyncRateLimits } from "../src/handler";
import { RECORD_OVERHEAD, SyncStore } from "../src/store";

const HOUR = 3600_000;
const TOKEN = "t".repeat(43);

let now: Date;
let driver: NodeSqliteDriver;
let store: SyncStore;
let limiter: SqlRateLimiter;

beforeEach(async () => {
  now = new Date("2026-11-17T00:00:00Z");
  driver = openNodeSqlite(":memory:");
  store = new SyncStore(driver, () => now);
  await store.init();
  limiter = new SqlRateLimiter(driver, () => now.getTime());
  await limiter.init();
});

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

/** 像 Workers 一樣每個請求都重新建立處理器：計數只能靠共用的 D1（這裡是同一個 SQLite） */
function freshHandler(extra: Partial<SyncDeps> = {}) {
  return (request: Request) => createSyncHandler({ store, allowedOrigins: [], rateLimiter: limiter, ...extra })(request);
}

const space = (n: number) => n.toString(16).padStart(32, "0");

async function call(method: string, path: string, opts: { ip?: string; body?: unknown; handler?: (r: Request) => Promise<Response> } = {}) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (opts.ip) headers["cf-connecting-ip"] = opts.ip;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const handle = opts.handler ?? freshHandler();
  const res = await handle(new Request(`http://sync.test${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const item = (id: number, size: number) => ({ id: `record${String(id).padStart(10, "0")}`, base: 0, blob: "b".repeat(size) });

describe("依來源 IP 的頻率限制（跨請求有效）", () => {
  it("建立空間：每個 IPv4 位址每小時 5 個、每天 10 個；不同的 IP 分開算；過了時間窗恢復", async () => {
    for (let i = 0; i < 5; i++) expect((await call("PUT", `/v1/spaces/${space(i)}?create=1`, { ip: "198.51.100.1" })).status).toBe(200);
    const limited = await call("PUT", `/v1/spaces/${space(10)}?create=1`, { ip: "198.51.100.1" });
    expect(limited).toMatchObject({ status: 429, body: { state: "rate_limited" } });
    // 別的 IP 不受影響
    expect((await call("PUT", `/v1/spaces/${space(11)}?create=1`, { ip: "198.51.100.2" })).status).toBe(200);
    // 已經有的空間（每次同步都會確認）不算建立
    for (let i = 0; i < 20; i++) expect((await call("PUT", `/v1/spaces/${space(0)}?create=1`, { ip: "198.51.100.1" })).status).toBe(200);
    advance(HOUR);
    expect((await call("PUT", `/v1/spaces/${space(12)}?create=1`, { ip: "198.51.100.1" })).status).toBe(200);
    // 每天 10 個
    for (let i = 0; i < 4; i++) await call("PUT", `/v1/spaces/${space(100 + i)}?create=1`, { ip: "198.51.100.1" });
    advance(HOUR);
    expect((await call("PUT", `/v1/spaces/${space(200)}?create=1`, { ip: "198.51.100.1" })).status).toBe(429);
    // 計數只存 IP 的雜湊
    expect(JSON.stringify(await driver.all("SELECT key FROM rate_limits"))).not.toContain("198.51.100");
  });

  it("配對碼：每 10 分鐘 10 個", async () => {
    for (let i = 0; i < 10; i++) expect((await call("POST", "/v1/pair", { ip: "203.0.113.5", body: { pub: "PUB", commitment: "C" } })).status).toBe(200);
    expect((await call("POST", "/v1/pair", { ip: "203.0.113.5", body: { pub: "PUB", commitment: "C" } })).status).toBe(429);
    expect((await call("POST", "/v1/pair", { ip: "203.0.113.6", body: { pub: "PUB", commitment: "C" } })).status).toBe(200);
  });

  it("送出：每分鐘的次數與位元組（覆寫的上限）", async () => {
    const handler = freshHandler({ rateLimits: { push: { "v4/32": { minute: { limit: 3, windowMs: 60_000 } } }, pushBytes: { "v4/32": { hour: { limit: 1000, windowMs: HOUR } } } } });
    await call("PUT", `/v1/spaces/${space(1)}?create=1`, { ip: "192.0.2.1", handler });
    const push = (id: number, size: number, ip = "192.0.2.1") => call("POST", `/v1/spaces/${space(1)}/changes`, { ip, handler, body: { items: [item(id, size)] } });
    expect((await push(1, 400)).status).toBe(200);
    expect((await push(2, 400)).status).toBe(200);
    // 位元組超過：不寫入，次數與位元組都不扣（有一條超過時這次都不算）
    expect((await push(3, 400)).status).toBe(429);
    expect((await push(4, 100)).status).toBe(200);
    expect((await push(5, 10)).status).toBe(429); // 次數（第 4 次）
    advance(60_000);
    expect((await push(6, 10)).status).toBe(200);
    expect((await call("GET", `/v1/spaces/${space(1)}/changes`, { handler })).body.items).toHaveLength(4);
  });

  it("沒有給計數時不限制（本機的模擬服務）", async () => {
    const handler = (request: Request) => createSyncHandler({ store, allowedOrigins: [] })(request);
    for (let i = 0; i < 15; i++) expect((await call("PUT", `/v1/spaces/${space(i)}?create=1`, { handler })).status).toBe(200);
  });
});

describe("容量", () => {
  const limits: Partial<ServiceLimits> = { spaces: 3, bytes: 1000 + 6 * 200, pairSlots: 3 };
  // 這裡測容量，來源的限制放寬
  const loose = { hour: { limit: 1000, windowMs: HOUR } };
  const handler = () => freshHandler({ limits, rateLimits: { createSpace: { unknown: loose }, createPair: { unknown: loose } } });

  it("沒有紀錄也沒有裝置、建立超過 24 小時的空間被清掉；有資料、有裝置、還沒滿 24 小時的不清", async () => {
    await call("PUT", `/v1/spaces/${space(1)}?create=1`, { handler: handler() });
    await call("PUT", `/v1/spaces/${space(2)}?create=1`, { handler: handler() });
    await call("POST", `/v1/spaces/${space(2)}/changes`, { handler: handler(), body: { items: [item(1, 10)] } });
    // 有登記裝置的空間（直接寫進儲存，代表裝置模式的空間）
    await call("PUT", `/v1/spaces/${space(3)}?create=1`, { handler: handler() });
    await store.addDevice(space(3), { id: "d".repeat(22), signPub: "S", boxPub: "B", label: "L", legacy: false });
    advance(23 * HOUR);
    expect((await maintain(store, { limits })).spaces).toBe(0);
    advance(2 * HOUR);
    const logs: string[] = [];
    expect((await maintain(store, { limits, log: (l) => logs.push(l) })).spaces).toBe(1);
    expect(await store.spaceToken(space(1))).toBeNull();
    expect(await store.spaceToken(space(2))).not.toBeNull();
    expect(await store.spaceToken(space(3))).not.toBeNull();
    expect((await call("GET", `/v1/spaces/${space(2)}/changes`, { handler: handler() })).body.items).toHaveLength(1);
    // 2/3 個空間還不到 80%；位元組 10/1000 也不到
    expect(logs.some((l) => l.startsWith("WARNING"))).toBe(false);
    await call("PUT", `/v1/spaces/${space(4)}?create=1`, { handler: handler() });
    await maintain(store, { limits, log: (l) => logs.push(l) });
    expect(logs.find((l) => l.startsWith("WARNING"))).toBe("WARNING sync spaces near limit: 3/3");
  });

  it("服務已滿時先清掉過期的空空間再建立", async () => {
    for (let i = 1; i <= 3; i++) await call("PUT", `/v1/spaces/${space(i)}?create=1`, { handler: handler() });
    expect((await call("PUT", `/v1/spaces/${space(9)}?create=1`, { handler: handler() })).status).toBe(503);
    advance(25 * HOUR);
    expect((await call("PUT", `/v1/spaces/${space(9)}?create=1`, { handler: handler() })).body).toEqual({ created: true });
    expect(Number((await driver.all("SELECT COUNT(*) AS n FROM spaces"))[0]!.n)).toBe(1);
  });

  it("過期的配對碼被清掉", async () => {
    await call("POST", "/v1/pair", { handler: handler(), body: { pub: "PUB", commitment: "C" } });
    advance(11 * 60_000);
    expect((await maintain(store, { limits })).slots).toBe(1);
  });

  it("並行時不越過空間數、配對碼數與總量", async () => {
    const created = await Promise.all(Array.from({ length: 10 }, (_, i) => call("PUT", `/v1/spaces/${space(i)}?create=1`, { handler: handler() })));
    expect(created.filter((r) => r.status === 200)).toHaveLength(3);
    expect(created.filter((r) => r.status === 503)).toHaveLength(7);
    expect((await store.totals()).spaces).toBe(3);

    const ok = created.flatMap((r, i) => (r.status === 200 ? [i] : []));
    const pushes = await Promise.all(
      ok.flatMap((i) => [0, 1].map((k) => call("POST", `/v1/spaces/${space(i)}/changes`, { handler: handler(), body: { items: [item(k, 300)] } }))),
    );
    // 每筆 300（加上每筆的固定額外 200）、上限 2200：六個並行的送出只有四個寫得進去
    expect(pushes.filter((r) => r.status === 200)).toHaveLength(4);
    expect(pushes.filter((r) => r.status === 503)).toHaveLength(2);
    expect((await store.totals()).bytes).toBe(4 * 500);

    const slots = await Promise.all(Array.from({ length: 8 }, () => call("POST", "/v1/pair", { handler: handler(), body: { pub: "PUB", commitment: "C" } })));
    expect(slots.filter((r) => r.status === 200)).toHaveLength(3);
    expect(await store.activeSlots()).toBe(3);
  });
});

describe("換金鑰不受整個服務的空間數擋（一換一）", () => {
  let api: SyncApi;

  async function device(name: string, root: Uint8Array, identity?: DeviceIdentity) {
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    const d = { identity: identity ?? (await newDeviceIdentity()), root: Uint8Array.from(root) } as { identity: DeviceIdentity; root: Uint8Array; engine: SyncEngine };
    d.engine = new SyncEngine(db, api, d.root, () => now, {
      identity: d.identity,
      label: () => ({ name, platform: "test" }),
      onRootChanged: async (next) => {
        d.root = next;
      },
    });
    return d;
  }

  beforeEach(() => {
    const handle = freshHandler({ limits: { spaces: 2 } });
    api = new SyncApi("http://sync.test", (input, init) => handle(new Request(input as string, init)));
  });

  it("服務已滿時還是可以換金鑰；不是換金鑰的建立照樣被擋；同一個舊空間不能同時開兩個", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const other = await device("Other", newRootKey());
    await other.engine.ensureSpace();
    // 服務已滿（2 個）
    const third = await device("Third", newRootKey());
    await expect(third.engine.ensureSpace()).rejects.toMatchObject({ status: 503 });

    advance(25 * HOUR);
    const before = a.root;
    await a.engine.rekey();
    expect(a.root).not.toEqual(before);
    // 舊空間不算，新空間算：還是 2 個
    expect((await store.totals()).spaces).toBe(2);
    await expect(third.engine.ensureSpace()).rejects.toMatchObject({ status: 503 });
    // 換完之後再換一次也可以（等一分鐘）
    advance(2 * 60_000);
    await a.engine.rekey();
    expect((await store.totals()).spaces).toBe(2);
  });

  it("沒有舊空間裡那台的簽章、或還在冷卻期的，照一般的建立（服務已滿就擋）", async () => {
    const rootA = newRootKey();
    const a = await device("A", rootA);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const b = await device("B", newRootKey());
    await b.engine.ensureSpace();
    const oldSpace = (await deriveKeys(rootA)).space;
    // 沒有簽章
    expect((await call("PUT", `/v1/spaces/${space(77)}?create=1&devices=1&from=${oldSpace}`, { handler: freshHandler({ limits: { spaces: 2 } }) })).status).toBe(503);
    // 不是舊空間裡的裝置
    const stranger = await newDeviceIdentity();
    await expect(api.request("PUT", `/v1/spaces/${space(78)}?create=1&devices=1&from=${oldSpace}`, undefined, { device: stranger, token: TOKEN })).rejects.toMatchObject({
      status: 503,
    });
    // 舊空間裡的那台，但還在冷卻期
    await expect(api.request("PUT", `/v1/spaces/${space(79)}?create=1&devices=1&from=${oldSpace}`, undefined, { device: a.identity, token: TOKEN })).rejects.toMatchObject({
      status: 503,
    });
    // 過了冷卻期：可以，但同一個舊空間同時只能有一個換到一半的
    advance(25 * HOUR);
    await api.request("PUT", `/v1/spaces/${space(80)}?create=1&devices=1&from=${oldSpace}`, undefined, { device: a.identity, token: TOKEN });
    await expect(api.request("PUT", `/v1/spaces/${space(81)}?create=1&devices=1&from=${oldSpace}`, undefined, { device: a.identity, token: TOKEN })).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("每個請求的 D1 查詢次數固定（Workers 每次呼叫有查詢數的上限，D1 每個查詢都是一次來回）", () => {
  /** 每個請求最多 50 個查詢（免費方案的上限），超過就丟錯，像 D1 一樣 */
  const MAX_QUERIES = 50;
  let queries = 0;
  let limitedStore: SyncStore;
  let limitedHandle: (request: Request) => Promise<Response>;

  beforeEach(async () => {
    const count = <T>(fn: () => T): T => {
      if (++queries > MAX_QUERIES) throw new Error("Too many API requests by single worker invocation");
      return fn();
    };
    const limited = {
      exec: (sql: string) => count(() => driver.exec(sql)),
      run: (sql: string, params?: any[]) => count(() => driver.run(sql, params)),
      all: (sql: string, params?: any[]) => count(() => driver.all(sql, params)),
    };
    limitedStore = new SyncStore(limited, () => now);
    const limitedLimiter = new SqlRateLimiter(limited, () => now.getTime());
    limitedHandle = async (request) => {
      queries = 0;
      return createSyncHandler({ store: limitedStore, allowedOrigins: [], rateLimiter: limitedLimiter })(request);
    };
  });

  it("一次送 200 筆只用十幾個查詢；同一批重複的 id 只算第一筆", async () => {
    await call("PUT", `/v1/spaces/${space(1)}?create=1`, { handler: limitedHandle });
    const items = Array.from({ length: 200 }, (_, i) => item(i, 100));
    const res = await call("POST", `/v1/spaces/${space(1)}/changes`, { handler: limitedHandle, body: { items } });
    expect(res.status).toBe(200);
    expect(res.body.applied).toHaveLength(200);
    expect(queries).toBeLessThan(20);
    // 序號只會變大、不重複
    const seqs = res.body.applied.map((a: { seq: number }) => a.seq);
    expect(new Set(seqs).size).toBe(200);
    // 每筆的內容加上固定額外
    expect((await store.spaceUsage(space(1))).bytes).toBe(200 * (100 + RECORD_OVERHEAD));
    // 更新一部分（一筆的 base 是舊的、一筆重複）
    const update = [
      { ...item(0, 50), base: seqs[0] },
      { ...item(1, 50), base: 0 },
      { ...item(0, 70), base: seqs[0] },
    ];
    const second = await call("POST", `/v1/spaces/${space(1)}/changes`, { handler: limitedHandle, body: { items: update } });
    expect(second.body.applied).toHaveLength(1);
    expect(second.body.applied[0].seq).toBeGreaterThan(Math.max(...seqs));
    expect(second.body.conflicts.sort()).toEqual([item(0, 1).id, item(1, 1).id].sort());
    // 更新已經有的那筆只算內容的差
    expect((await store.spaceUsage(space(1))).bytes).toBe(200 * (100 + RECORD_OVERHEAD) - 50);
  });

  it("換金鑰把 450 筆重送一次：每個請求都在查詢數的上限內", async () => {
    const api = new SyncApi("http://sync.test", (input, init) => limitedHandle(new Request(input as string, init)));
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    for (let i = 0; i < 450; i++) {
      await db.saveCheckin({ date: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), energy: 3, soreness: 2, sleep: 4, notes: "x" });
    }
    const identity = await newDeviceIdentity();
    let root = newRootKey();
    const engine = new SyncEngine(db, api, root, () => now, { identity, label: () => ({ name: "A", platform: "t" }), onRootChanged: async (r) => void (root = r) });
    await engine.ensureSpace();
    await engine.sync();
    advance(25 * HOUR);
    const before = root;
    await engine.rekey();
    expect(root).not.toEqual(before);
    const keys = await deriveKeys(root);
    expect(Number((await driver.all("SELECT COUNT(*) AS n FROM records WHERE space=?", [keys.space]))[0]!.n)).toBeGreaterThanOrEqual(450);
  });
});

describe("換金鑰中途失敗", () => {
  it("複製到新空間時失敗：刪掉剛建立的新空間、舊的照舊、可以重試；進度回報到哪一步", async () => {
    const handle = freshHandler({ limits: { spaces: 1 } });
    let failCopy = true;
    let newSpace: string | null = null;
    const api = new SyncApi("http://sync.test", (input, init) => {
      const request = new Request(input as string, init);
      const url = new URL(request.url);
      if (request.method === "PUT" && url.searchParams.get("from")) newSpace = url.pathname.split("/")[3]!;
      if (failCopy && newSpace && request.method === "POST" && url.pathname === `/v1/spaces/${newSpace}/changes`) {
        return Promise.reject(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }));
      }
      return handle(request);
    });
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    await db.saveCheckin({ date: "2026-11-01", energy: 3, soreness: 2, sleep: 4, notes: "x" });
    let root = newRootKey();
    const engine = new SyncEngine(db, api, root, () => now, {
      identity: await newDeviceIdentity(),
      label: () => ({ name: "A", platform: "t" }),
      onRootChanged: async (r) => void (root = r),
    });
    await engine.ensureSpace();
    await engine.sync();
    advance(25 * HOUR);
    const steps: string[] = [];
    await expect(engine.rekey([], undefined, (p) => steps.push(p.step))).rejects.toMatchObject({ status: 0, message: "同步服務 30 秒沒有回應，請稍後再試" });
    expect(steps).toEqual(["fetch"]);
    expect(await store.spaceToken(newSpace!)).toBeNull();
    expect((await store.totals()).spaces).toBe(1);
    // 舊的照常同步；再試一次就成功
    await engine.sync();
    failCopy = false;
    const before = root;
    await engine.rekey([], undefined, (p) => steps.push(p.step));
    expect(root).not.toEqual(before);
    expect(steps.slice(1)).toEqual(["fetch", "copy", "rekey", "switch"]);
  });
});

describe("換金鑰的結果不明、被頻率限制、並行", () => {
  type Hook = (request: Request, url: URL, handle: (r: Request) => Promise<Response>) => Promise<Response> | null;

  async function setup(opts: { records?: number; hook?: Hook; deps?: Partial<SyncDeps> } = {}) {
    const handle = freshHandler(opts.deps);
    const sleeps: number[] = [];
    const api = new SyncApi(
      "http://sync.test",
      (input, init) => {
        const request = new Request(input as string, init);
        return opts.hook?.(request, new URL(request.url), handle) ?? handle(request);
      },
      async (ms) => {
        sleeps.push(ms);
        advance(ms);
      },
    );
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    for (let i = 0; i < (opts.records ?? 3); i++) {
      await db.saveCheckin({ date: new Date(Date.UTC(2024, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), energy: 3, soreness: 2, sleep: 4, notes: "x" });
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
    const oldSpace = (await deriveKeys(state.root)).space;
    advance(25 * HOUR);
    return { engine, state, oldSpace, sleeps, identity, api };
  }

  const rekeyPath = (oldSpace: string) => `/v1/spaces/${oldSpace}/rekey`;
  const timeout = () => Promise.reject(Object.assign(new Error("signal timed out"), { name: "TimeoutError" }));
  const recordsIn = async (space: string) => Number((await driver.all("SELECT COUNT(*) AS n FROM records WHERE space=?", [space]))[0]!.n);

  it("最後一步逾時，但伺服器已經換好：當成成功，改用新的金鑰，資料都在", async () => {
    let oldSpace = "";
    const t = await setup({
      hook: (request, url, handle) => (request.method === "POST" && url.pathname === rekeyPath(oldSpace) ? handle(request).then(timeout) : null),
    });
    oldSpace = t.oldSpace;
    const before = t.state.root;
    await t.engine.rekey();
    expect(t.state.root).not.toEqual(before);
    const newSpace = (await deriveKeys(t.state.root)).space;
    expect(await store.movedTo(oldSpace)).toBe(newSpace);
    expect(await recordsIn(newSpace)).toBeGreaterThanOrEqual(3);
    expect((await t.engine.sync()).devices!.devices).toHaveLength(1);
  });

  it("最後一步伺服器出錯、沒有換成：放棄新空間，舊的照舊", async () => {
    let oldSpace = "";
    let newSpace = "";
    const t = await setup({
      hook: (request, url) => {
        if (request.method === "PUT" && url.searchParams.get("from")) newSpace = url.pathname.split("/")[3]!;
        return request.method === "POST" && url.pathname === rekeyPath(oldSpace) ? Promise.resolve(Response.json({ error: "x" }, { status: 502 })) : null;
      },
    });
    oldSpace = t.oldSpace;
    const before = t.state.root;
    await expect(t.engine.rekey()).rejects.toMatchObject({ status: 502 });
    expect(t.state.root).toEqual(before);
    expect(await store.spaceToken(newSpace)).toBeNull();
    expect(await recordsIn(oldSpace)).toBeGreaterThanOrEqual(3);
  });

  it("最後一步逾時、也問不到舊空間：結果不確定，什麼都不刪；之後同步時自動跟上", async () => {
    let oldSpace = "";
    let newSpace = "";
    let down = false;
    const t = await setup({
      hook: (request, url, handle) => {
        if (request.method === "PUT" && url.searchParams.get("from")) newSpace = url.pathname.split("/")[3]!;
        if (down) return timeout();
        if (request.method === "POST" && url.pathname === rekeyPath(oldSpace)) {
          down = true;
          return handle(request).then(timeout);
        }
        return null;
      },
    });
    oldSpace = t.oldSpace;
    await expect(t.engine.rekey()).rejects.toMatchObject({ name: "Error", message: expect.stringContaining("結果還不確定") });
    expect(await store.spaceToken(newSpace)).not.toBeNull();
    expect(await store.spaceToken(oldSpace)).not.toBeNull();
    expect(await recordsIn(newSpace)).toBeGreaterThanOrEqual(3);
    // 連得上之後：舊空間回「已搬家」與給這台的新金鑰，這台跟過去
    down = false;
    await t.engine.sync();
    expect((await deriveKeys(t.state.root)).space).toBe(newSpace);
  });

  it("伺服器：換金鑰完成之後，放棄（?abandon=1）被拒絕；一般的刪除 10 分鐘內也拒絕，不會連帶刪掉舊的空間", async () => {
    const t = await setup();
    await t.engine.rekey();
    const newKeys = await deriveKeys(t.state.root);
    const auth = { device: t.identity, token: newKeys.token };
    await expect(t.api.request("DELETE", `/v1/spaces/${newKeys.space}?abandon=1`, undefined, auth)).rejects.toMatchObject({ status: 409, state: "rekey_done" });
    await expect(t.api.request("DELETE", `/v1/spaces/${newKeys.space}`, undefined, auth)).rejects.toMatchObject({ status: 429, state: "too_soon" });
    expect(await store.spaceToken(newKeys.space)).not.toBeNull();
    expect(await store.spaceToken(t.oldSpace)).not.toBeNull();
    expect(await recordsIn(newKeys.space)).toBeGreaterThanOrEqual(3);
    // 過了 10 分鐘，使用者自己按「刪除雲端的資料」照舊（連同換金鑰之前的舊空間）
    advance(11 * 60_000);
    await t.api.request("DELETE", `/v1/spaces/${newKeys.space}`, undefined, auth);
    expect(await store.spaceToken(newKeys.space)).toBeNull();
    expect(await store.spaceToken(t.oldSpace)).toBeNull();
  });

  it("資料多、碰到自己的頻率限制：等時間窗過了接著送，最後換成；進度顯示在等", async () => {
    // 開始同步時照預設的上限；換金鑰前改成每分鐘只能送 3 次（450 筆要送 5 次）
    const rateLimits: Partial<SyncRateLimits> = {};
    const t = await setup({ records: 450, deps: { rateLimits } });
    rateLimits.push = { unknown: { minute: { limit: 3, windowMs: 60_000 } } };
    const steps: string[] = [];
    const before = t.state.root;
    await t.engine.rekey([], undefined, (p) => steps.push(p.step === "wait" ? `wait:${p.seconds}` : p.step));
    expect(t.state.root).not.toEqual(before);
    expect(steps.some((s) => s.startsWith("wait:"))).toBe(true);
    expect(t.sleeps.length).toBeGreaterThan(0);
    expect(t.sleeps.every((ms) => ms > 0 && ms <= 60_000)).toBe(true);
    expect(await recordsIn((await deriveKeys(t.state.root)).space)).toBeGreaterThanOrEqual(450);
  });

  it("同時送好幾個從同一個舊空間換金鑰的建立：只有一個不受空間數限制", async () => {
    const t = await setup({ deps: { limits: { spaces: 1 } } });
    const auth = { device: t.identity, token: TOKEN };
    const results = await Promise.allSettled(
      [90, 91, 92, 93].map((n) => t.api.request("PUT", `/v1/spaces/${space(n)}?create=1&devices=1&from=${t.oldSpace}`, undefined, auth)),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected" && (r.reason as { status: number }).status === 503)).toHaveLength(3);
  });

  it("IPv6：同一個 /64 的不同位址算同一個來源", async () => {
    for (let i = 0; i < 5; i++) {
      expect((await call("PUT", `/v1/spaces/${space(300 + i)}?create=1`, { ip: `2001:db8:aa:bb::${(i + 1).toString(16)}` })).status).toBe(200);
    }
    expect((await call("PUT", `/v1/spaces/${space(320)}?create=1`, { ip: "2001:db8:aa:bb:ffff:ffff:ffff:ffff" })).status).toBe(429);
    expect((await call("PUT", `/v1/spaces/${space(321)}?create=1`, { ip: "2001:db8:aa:bc::1" })).status).toBe(200);
  });
});
