/**
 * 不活躍的空間到期刪除（規格 12.10）：所有裝置 12 個月都沒有連線的空間刪掉（讀取也算連線）；
 * 換金鑰做到一半、鎖住的不誤刪；已經存在的空間從上線那天起算；最後連線的日期一天只寫一次、只記到日.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, newDeviceIdentity, newRootKey, SyncApi, SyncEngine, memoryRekeyKeyStore } from "@running-coach/core";
import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createSyncHandler, INACTIVE_PER_RUN, INACTIVE_SPACE_TTL_MS, maintain, NETWORK_RETENTION_MS } from "../src/handler";
import { SyncStore } from "../src/store";

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const TOKEN = "t".repeat(43);

let now: Date;
let driver: NodeSqliteDriver;
let store: SyncStore;
/** 寫入最後連線日期的次數（真的改到一列的） */
let seenWrites: number;

/** 數一下寫 seen_on 的 UPDATE 真的改了幾次 */
function counting(d: NodeSqliteDriver): NodeSqliteDriver {
  return new Proxy(d, {
    get(target, prop, receiver) {
      if (prop === "run") {
        return async (sql: string, params?: unknown[]) => {
          const result = await target.run(sql, params as never);
          if (/^UPDATE spaces SET seen_on=\? WHERE id=\?/.test(sql) && result.changes > 0) seenWrites++;
          return result;
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

beforeEach(async () => {
  now = new Date("2026-11-20T01:00:00Z");
  seenWrites = 0;
  driver = openNodeSqlite(":memory:");
  store = new SyncStore(counting(driver), () => now);
  await store.init();
});

const advance = (ms: number) => {
  now = new Date(now.getTime() + ms);
};

const handler = (request: Request) => createSyncHandler({ store, allowedOrigins: [] })(request);
const space = (n: number) => n.toString(16).padStart(32, "0");

async function call(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}` };
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await handler(new Request(`http://sync.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const exists = async (n: number) => (await store.spaceToken(space(n))) !== null;
const count = async (table: string, column: string, n: number) =>
  Number((await driver.all(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column}=?`, [space(n)]))[0]!.c);

describe("12 個月沒有連線的空間", () => {
  it("12 個月沒有任何請求：連同紀錄、裝置模式一起刪掉；還沒到 12 個月的不刪", async () => {
    expect((await call("PUT", `/v1/spaces/${space(1)}?create=1`)).status).toBe(200);
    expect((await call("POST", `/v1/spaces/${space(1)}/changes`, { items: [{ id: "record0000000001", base: 0, blob: "x".repeat(100) }] })).status).toBe(200);
    advance(INACTIVE_SPACE_TTL_MS - DAY);
    expect((await maintain(store)).inactive).toBe(0);
    expect(await exists(1)).toBe(true);
    advance(2 * DAY);
    const logs: string[] = [];
    expect((await maintain(store, { log: (l) => logs.push(l) })).inactive).toBe(1);
    expect(await exists(1)).toBe(false);
    expect(await count("records", "space", 1)).toBe(0);
    expect(logs.join("\n")).toContain("inactive=1");
  });

  it("只有讀取（沒有寫入）也算連線：updated_at 沒變，空間照樣留著", async () => {
    await call("PUT", `/v1/spaces/${space(1)}?create=1`);
    await call("POST", `/v1/spaces/${space(1)}/changes`, { items: [{ id: "record0000000001", base: 0, blob: "x" }] });
    const updated = String((await driver.all("SELECT updated_at FROM spaces WHERE id=?", [space(1)]))[0]!.updated_at);
    // 10 個月後只讀一次
    advance(300 * DAY);
    expect((await call("GET", `/v1/spaces/${space(1)}/changes?since=0`)).status).toBe(200);
    expect(String((await driver.all("SELECT updated_at FROM spaces WHERE id=?", [space(1)]))[0]!.updated_at)).toBe(updated);
    // 從建立算已經超過 12 個月，從讀取算還沒
    advance(300 * DAY);
    await maintain(store);
    expect(await exists(1)).toBe(true);
    // 讀取之後滿 12 個月才刪
    advance(70 * DAY);
    await maintain(store);
    expect(await exists(1)).toBe(false);
  });

  it("登記過的裝置同步（簽章的請求）也算；確認憑證（開始同步的 PUT）也算", async () => {
    const db = new Db(openNodeSqlite(":memory:"), { now: () => now, today: () => now.toISOString().slice(0, 10) });
    await db.init();
    await db.saveCheckin({ date: "2026-11-01", energy: 3, soreness: 2, sleep: 4, notes: "n" });
    const api = new SyncApi("http://sync.test", (input, init) => handler(new Request(input as string, init)));
    const engine = new SyncEngine(db, api, newRootKey(), () => now, {
      identity: await newDeviceIdentity(),
      label: () => ({ name: "A", platform: "t" }),
      rekeyKey: memoryRekeyKeyStore(),
      onRootChanged: async () => undefined,
    });
    await engine.ensureSpace();
    await engine.sync();
    const id = String((await driver.all("SELECT id FROM spaces"))[0]!.id);
    advance(200 * DAY);
    await engine.sync();
    expect(await store.seenOn(id)).toBe(now.toISOString().slice(0, 10));
    advance(200 * DAY);
    await call("PUT", `/v1/spaces/${space(9)}?create=1`);
    await call("POST", `/v1/spaces/${space(9)}/changes`, { items: [{ id: "record0000000001", base: 0, blob: "x" }] });
    advance(200 * DAY);
    // 確認憑證
    await call("PUT", `/v1/spaces/${space(9)}`);
    advance(200 * DAY);
    await maintain(store);
    // 裝置的空間：最後一次同步已經 600 天前；space(9)：確認憑證 200 天前
    expect(await store.spaceToken(id)).toBeNull();
    expect(await exists(9)).toBe(true);
  });

  it("換過金鑰的舊空間跟著最新的空間：最新的有連線時都不刪；都沒有時一起刪", async () => {
    const hash = await sha256(TOKEN);
    await store.createSpace(space(1), hash);
    await store.createSpace(space(2), hash, null, space(1), null, "A".repeat(22));
    await store.rekey(space(1), { newSpace: space(2), caller: "A".repeat(22), keep: [], remove: [], statement: "s", signature: "g" });
    advance(INACTIVE_SPACE_TTL_MS - 10 * DAY);
    await store.touchSpace(space(2));
    advance(20 * DAY);
    expect((await maintain(store)).inactive).toBe(0);
    expect(await exists(1)).toBe(true);
    advance(INACTIVE_SPACE_TTL_MS);
    expect((await maintain(store)).inactive).toBe(1);
    expect(await exists(1)).toBe(false);
    expect(await exists(2)).toBe(false);
    expect(await count("moves", "space", 1)).toBe(0);
  });
});

describe("換金鑰做到一半的不誤刪", () => {
  const removal = { signer: "A".repeat(22), statement: "s", signature: "g" };
  const device = (id: string) => ({ id, signPub: "p", boxPub: "b", label: "l", legacy: false });

  it("舊空間很久沒連線、換到一半的新空間最近有（換金鑰的那台在複製）：兩邊都留著", async () => {
    const hash = await sha256(TOKEN);
    await store.createSpace(space(1), hash);
    await store.addDevice(space(1), device("A".repeat(22)));
    advance(INACTIVE_SPACE_TTL_MS - 5 * DAY);
    await store.createSpace(space(2), hash, null, space(1), null, "A".repeat(22));
    // 換到一半的新空間 7 天沒有進度會被清掉（purgeStaleRekeys），這裡還沒到
    advance(6 * DAY);
    expect((await maintain(store)).inactive).toBe(0);
    expect(await exists(1)).toBe(true);
    expect(await exists(2)).toBe(true);
  });

  it("鎖住的換金鑰（已經先移除裝置）：舊空間最近有連線、新空間很久沒有，兩邊都留著；都 12 個月沒有連線才一起刪", async () => {
    const hash = await sha256(TOKEN);
    await store.createSpace(space(1), hash);
    await store.addDevice(space(1), device("A".repeat(22)));
    await store.addDevice(space(1), device("B".repeat(22)));
    await store.createSpace(space(2), hash, null, space(1), null, "A".repeat(22));
    expect(await store.removeDevices(space(1), space(2), [{ id: "B".repeat(22), proof: null }], removal)).toBe(1);
    // 舊空間的另一台一直在同步，新空間停著
    for (let i = 0; i < 13; i++) {
      advance(30 * DAY);
      await store.touchSpace(space(1));
      await maintain(store);
    }
    expect(await exists(1)).toBe(true);
    expect(await exists(2)).toBe(true);
    // 之後所有裝置都沒有連線滿 12 個月：兩邊一起刪（裝置、移除的聲明也是）
    advance(INACTIVE_SPACE_TTL_MS + DAY);
    expect((await maintain(store)).inactive).toBe(1);
    expect(await exists(1)).toBe(false);
    expect(await exists(2)).toBe(false);
    expect(await count("devices", "space", 1)).toBe(0);
  });

  it("換到一半的新空間不單獨刪（舊空間還有連線時）", async () => {
    const hash = await sha256(TOKEN);
    await store.createSpace(space(1), hash);
    await store.addDevice(space(1), device("A".repeat(22)));
    await store.addDevice(space(1), device("B".repeat(22)));
    await store.createSpace(space(2), hash, null, space(1), null, "A".repeat(22));
    await store.removeDevices(space(1), space(2), [{ id: "B".repeat(22), proof: null }], removal);
    advance(INACTIVE_SPACE_TTL_MS + DAY);
    await store.touchSpace(space(1));
    expect(await store.expireInactiveSpaces(INACTIVE_SPACE_TTL_MS)).toBe(0);
    expect(await exists(2)).toBe(true);
  });
});

describe("已經存在的空間與寫入的次數", () => {
  it("上線之前就有的空間（沒有這個欄）：從上線那天起算，不追溯", async () => {
    const old = openNodeSqlite(":memory:");
    // 上線之前的資料表：沒有 seen_on
    await old.exec(
      "CREATE TABLE spaces (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
    );
    await old.run("INSERT INTO spaces (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?)", [space(1), "h", "2023-01-01T00:00:00.000Z", "2023-01-01T00:00:00.000Z"]);
    const launched = new SyncStore(old, () => now);
    await launched.init();
    expect(await launched.seenOn(space(1))).toBe("2026-11-20");
    advance(INACTIVE_SPACE_TTL_MS - DAY);
    expect(await launched.expireInactiveSpaces(INACTIVE_SPACE_TTL_MS)).toBe(0);
    // 再啟動一次（新的執行個體）不會把日期往後推
    await new SyncStore(old, () => now).init();
    expect(await launched.seenOn(space(1))).toBe("2026-11-20");
    advance(2 * DAY);
    expect(await launched.expireInactiveSpaces(INACTIVE_SPACE_TTL_MS)).toBe(1);
  });

  it("一天最多寫一次、只記到日（沒有時間）", async () => {
    await call("PUT", `/v1/spaces/${space(1)}?create=1`);
    const afterCreate = seenWrites;
    for (let i = 0; i < 5; i++) {
      advance(HOUR);
      expect((await call("GET", `/v1/spaces/${space(1)}/changes?since=0`)).status).toBe(200);
      await call("POST", `/v1/spaces/${space(1)}/changes`, { items: [{ id: `record000000000${i}`, base: 0, blob: "x" }] });
    }
    // 建立當天已經記了日期：同一天的讀寫都不再寫
    expect(seenWrites).toBe(afterCreate);
    advance(DAY);
    await call("GET", `/v1/spaces/${space(1)}/changes?since=0`);
    await call("GET", `/v1/spaces/${space(1)}/changes?since=0`);
    expect(seenWrites).toBe(afterCreate + 1);
    // 另一個執行個體（記憶體裡沒有記過）同一天也不再寫：資料庫裡已經是今天
    const other = new SyncStore(counting(driver), () => now);
    await other.touchSpace(space(1));
    expect(seenWrites).toBe(afterCreate + 1);
    expect(await store.seenOn(space(1))).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("沒通過驗證的請求不算連線", async () => {
    await call("PUT", `/v1/spaces/${space(1)}?create=1`);
    advance(2 * DAY);
    const before = await store.seenOn(space(1));
    const res = await handler(new Request(`http://sync.test/v1/spaces/${space(1)}/changes?since=0`, { headers: { authorization: `Bearer ${"u".repeat(43)}` } }));
    expect(res.status).toBe(403);
    expect(await store.seenOn(space(1))).toBe(before);
  });
});

describe("很多空間同一天到期（現有的空間從上線那天一起起算）", () => {
  /** 每次呼叫最多 50 個查詢（D1 免費方案），超過就丟錯 */
  const MAX_QUERIES = 50;

  async function manySpaces(n: number) {
    const hash = await sha256(TOKEN);
    for (let i = 1; i <= n; i++) {
      await store.createSpace(space(i), hash, null, null, `net${i % 3}`);
      await store.addDevice(space(i), { id: String(i).padStart(22, "A"), signPub: "p", boxPub: "b", label: "l", legacy: false });
      await driver.run("INSERT INTO records (space, id, seq, blob) VALUES (?, 'r', 1, 'x')", [space(i)]);
    }
  }

  function limited() {
    let queries = 0;
    const count = <T>(fn: () => T): T => {
      if (++queries > MAX_QUERIES) throw new Error("Too many API requests by single worker invocation");
      return fn();
    };
    const d = {
      exec: (sql: string) => count(() => driver.exec(sql)),
      run: (sql: string, params?: any[]) => count(() => driver.run(sql, params)),
      all: (sql: string, params?: any[]) => count(() => driver.all(sql, params)),
    };
    return { store: new SyncStore(d, () => now), limiter: new SqlRateLimiter(d, () => now.getTime()), reset: () => (queries = 0), used: () => queries };
  }

  it("一次 maintain 只刪上限內的空間，在查詢數上限內；網段代碼、配對碼等其他清理照常；剩下的之後每小時接著刪", async () => {
    await manySpaces(30);
    await store.createSlot("AAAAAAAA", "p", "c", 60_000);
    advance(INACTIVE_SPACE_TTL_MS + DAY);
    expect(NETWORK_RETENTION_MS).toBeLessThan(INACTIVE_SPACE_TTL_MS);
    const l = limited();
    await l.limiter.init();
    const logs: string[] = [];
    l.reset();
    const result = await maintain(l.store, { purgeRates: () => l.limiter.purge(), log: (line) => logs.push(line) });
    expect(l.used()).toBeLessThanOrEqual(MAX_QUERIES);
    expect(result.inactive).toBe(INACTIVE_PER_RUN);
    expect(result.slots).toBe(1);
    // 網段的代碼照樣清掉（隱私說明的「保存 30 天」）
    expect(Number((await driver.all("SELECT COUNT(*) AS c FROM spaces WHERE network IS NOT NULL"))[0]!.c)).toBe(0);
    expect(logs.some((line) => line.startsWith("WARNING maintenance step failed"))).toBe(false);
    expect((await store.totals()).spaces).toBe(30 - INACTIVE_PER_RUN);
    for (let hour = 0; hour < 10; hour++) {
      advance(HOUR);
      l.reset();
      await maintain(l.store, { purgeRates: () => l.limiter.purge() });
      expect(l.used()).toBeLessThanOrEqual(MAX_QUERIES);
    }
    expect((await store.totals()).spaces).toBe(0);
  });

  it("一項失敗（例如查詢數用完）只記 log，其他項照常完成", async () => {
    await manySpaces(3);
    advance(INACTIVE_SPACE_TTL_MS + DAY);
    const broken = Object.assign(Object.create(store), {
      expireInactiveSpaces: async () => {
        throw new Error("Too many API requests by single worker invocation");
      },
      purgeStaleRekeys: async () => {
        throw new Error("boom");
      },
    }) as SyncStore;
    const logs: string[] = [];
    const result = await maintain(broken, { log: (line) => logs.push(line) });
    expect(result.inactive).toBe(0);
    expect(result.networks).toBe(3);
    expect(logs.filter((line) => line.startsWith("WARNING maintenance step failed"))).toHaveLength(2);
    expect(logs.some((line) => line.startsWith("maintenance: purged"))).toBe(true);
  });

  it("刪到一半查詢數用完：沒有留下接不上的舊空間，下次接著刪完", async () => {
    const hash = await sha256(TOKEN);
    // space(1) → space(2) → space(3)：換過兩次金鑰
    await store.createSpace(space(1), hash);
    await store.createSpace(space(2), hash, null, space(1), null, "A".repeat(22));
    await store.rekey(space(1), { newSpace: space(2), caller: "A".repeat(22), keep: [], remove: [], statement: "s", signature: "g" });
    await store.createSpace(space(3), hash, null, space(2), null, "A".repeat(22));
    await store.rekey(space(2), { newSpace: space(3), caller: "A".repeat(22), keep: [], remove: [], statement: "s", signature: "g" });
    advance(INACTIVE_SPACE_TTL_MS + DAY);
    for (let budget = 6; budget < 40; budget++) {
      let left = budget;
      const d = {
        exec: (sql: string) => (left-- > 0 ? driver.exec(sql) : Promise.reject(new Error("Too many API requests"))),
        run: (sql: string, params?: any[]) => (left-- > 0 ? driver.run(sql, params) : Promise.reject(new Error("Too many API requests"))),
        all: (sql: string, params?: any[]) => (left-- > 0 ? driver.all(sql, params) : Promise.reject(new Error("Too many API requests"))),
        // 像 D1 的 batch：一個呼叫、整批一個交易
        batch: async (statements: { sql: string; params: any[] }[]) => {
          if (left-- <= 0) throw new Error("Too many API requests");
          await driver.exec("BEGIN");
          try {
            for (const st of statements) await driver.run(st.sql, st.params);
            await driver.exec("COMMIT");
          } catch (e) {
            await driver.exec("ROLLBACK");
            throw e;
          }
        },
      };
      await new SyncStore(d, () => now).expireInactiveSpaces(INACTIVE_SPACE_TTL_MS).catch(() => undefined);
      // 還在的舊空間一定接在還在的空間後面
      const orphans = await driver.all("SELECT space FROM moves WHERE moved_to NOT IN (SELECT id FROM spaces)");
      expect(orphans).toEqual([]);
      if (!(await exists(3))) break;
    }
    expect(await exists(1)).toBe(false);
    expect(await exists(2)).toBe(false);
    expect(await exists(3)).toBe(false);
  });
});
