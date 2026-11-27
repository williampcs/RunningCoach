/**
 * 「匯出資料庫」的檔案不含同步的金鑰（規格 12.10）：用網頁版同一個 SQLite（WASM）跑 export-copy.ts，
 * 檢查匯出的檔案、使用中的資料庫不動、匯入回來同步照常.
 */
import Database from "better-sqlite3";
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { Db, memoryRekeyKeyStore, newDeviceIdentity, newRootKey, SyncApi, SyncEngine, toBase64url, type DeviceIdentity, type Row, type SqlDriver, type SqlValue } from "@running-coach/core";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler } from "../../sync/src/handler";
import { SyncStore } from "../../sync/src/store";
import { EXPORTED_SYNC_META, exportCopy } from "../src/db/export-copy";

let sqlite3: Sqlite3Static;
beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

/** 和瀏覽器一樣不用 WAL 的 better-sqlite3（可以整個序列化） */
function driverOf(db: Database.Database): SqlDriver {
  return {
    async exec(sql) {
      db.exec(sql);
    },
    async run(sql, params: SqlValue[] = []) {
      const result = db.prepare(sql).run(...params);
      return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.changes };
    },
    async all(sql, params: SqlValue[] = []) {
      return db.prepare(sql).all(...params) as Row[];
    },
  };
}

/** 像網頁版的 worker：把檔案內容開成 WASM 的資料庫，匯出 */
function exportLikeBrowser(file: Uint8Array): { exported: Uint8Array; after: Uint8Array } {
  // better-sqlite3 給的是 Buffer：換成一般的 Uint8Array（瀏覽器裡 sqlite3_js_db_export 給的就是）
  const bytes = Uint8Array.from(file);
  const db = new sqlite3.oo1.DB(":memory:");
  try {
    const data = sqlite3.wasm.allocFromTypedArray(bytes);
    const { capi } = sqlite3;
    db.checkRc(capi.sqlite3_deserialize(db.pointer!, "main", data, bytes.byteLength, bytes.byteLength, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE));
    const exported = exportCopy(sqlite3, db);
    return { exported, after: capi.sqlite3_js_db_export(db) };
  } finally {
    db.close();
  }
}

const contains = (haystack: Uint8Array, needle: string) => Buffer.from(haystack).includes(Buffer.from(needle));

let now: Date;
let api: SyncApi;

beforeEach(async () => {
  now = new Date("2026-11-20T04:00:00Z");
  const store = new SyncStore(openNodeSqlite(":memory:"), () => now);
  await store.init();
  const handle = createSyncHandler({ store, allowedOrigins: [] });
  api = new SyncApi("http://sync.test", (input, init) => handle(new Request(input as string, init)));
});

async function device(raw = new Database(":memory:")) {
  const db = new Db(driverOf(raw), { now: () => now, today: () => now.toISOString().slice(0, 10) });
  await db.init();
  return { raw, db };
}

describe("匯出的資料庫不含同步的金鑰", () => {
  it("sync_meta 只留不含金鑰的鍵；換金鑰的進度（含舊格式的新金鑰）不帶出去，殘頁裡也沒有；使用中的資料庫不動", async () => {
    const { raw, db } = await device();
    await db.saveCheckin({ date: "2026-11-19", energy: 3, soreness: 2, sleep: 4, notes: "照常" });
    const secretRoot = toBase64url(newRootKey());
    await db.syncTransaction(async (sql) => {
      for (const [k, v] of [
        ["space", "s".repeat(43)],
        ["last_seq", "12"],
        ["last_sync", now.toISOString()],
        ["known_devices", "{}"],
        ["rekey_pending", JSON.stringify({ root: secretRoot, space: "n".repeat(43), from: "s".repeat(43), done: 1, total: 2, resumeAt: 0, removed: [] })],
        ["rekey_takeover", JSON.stringify({ space: "n".repeat(43), done: 1, total: 2, resumeAt: 0 })],
        ["future_secret", "x"],
      ]) {
        await sql.run("INSERT INTO sync_meta (k, v) VALUES (?, ?)", [k, v]);
      }
    });
    const before = raw.serialize();
    expect(contains(before, secretRoot)).toBe(true);
    const { exported, after } = exportLikeBrowser(before);

    expect(contains(exported, secretRoot)).toBe(false);
    expect(contains(exported, "rekey_pending")).toBe(false);
    const copy = new Database(Buffer.from(exported));
    const keys = (copy.prepare("SELECT k FROM sync_meta ORDER BY k").all() as { k: string }[]).map((r) => r.k);
    expect(keys).toEqual(["known_devices", "last_seq", "last_sync", "space"]);
    expect(keys.every((k) => (EXPORTED_SYNC_META as readonly string[]).includes(k))).toBe(true);
    // 其他資料照樣在
    expect(copy.prepare("SELECT notes FROM daily_checkins").all()).toEqual([{ notes: "照常" }]);
    // 使用中的那份沒有被改
    expect(contains(after, secretRoot)).toBe(true);
    const live = new Database(Buffer.from(after));
    expect((live.prepare("SELECT COUNT(*) AS n FROM sync_meta").get() as { n: number }).n).toBe(7);
  });

  it("匯入匯出的檔案之後同步照常（不重送、不當成刪除）", async () => {
    const root = newRootKey();
    const identity: DeviceIdentity = await newDeviceIdentity();
    const engineOf = (db: Db) => new SyncEngine(db, api, Uint8Array.from(root), () => now, { identity, label: () => ({ name: "A", platform: "t" }), rekeyKey: memoryRekeyKeyStore(), onRootChanged: async () => undefined });
    const a = await device();
    for (let i = 1; i <= 5; i++) await a.db.saveCheckin({ date: `2026-11-1${i}`, energy: 3, soreness: 2, sleep: 4, notes: `n${i}` });
    await engineOf(a.db).ensureSpace();
    expect(await engineOf(a.db).sync()).toMatchObject({ sent: 5 });

    const { exported } = exportLikeBrowser(a.raw.serialize());
    const imported = await device(new Database(Buffer.from(exported)));
    const result = await engineOf(imported.db).sync();
    expect(result).toMatchObject({ sent: 0, received: 0, total: 5 });
    // 另一台照樣拿得到全部
    const b = await device();
    const other = new SyncEngine(b.db, api, Uint8Array.from(root), () => now, { identity: await newDeviceIdentity(), label: () => ({ name: "B", platform: "t" }), rekeyKey: memoryRekeyKeyStore(), onRootChanged: async () => undefined });
    expect(await other.sync()).toMatchObject({ received: 5 });
  });
});
