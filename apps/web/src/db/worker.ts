/// <reference lib="webworker" />
/** SQLite（WASM）執行緒 — 資料庫存在瀏覽器的 OPFS，不離開使用者的裝置. */
import sqlite3InitModule, { type Database, type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

const DB_FILE = "/coach.db";

export type DbRequest =
  | { id: number; method: "open" }
  | { id: number; method: "exec"; sql: string }
  | { id: number; method: "run" | "all"; sql: string; params: (string | number | null)[] }
  | { id: number; method: "export" }
  | { id: number; method: "import"; bytes: Uint8Array };

let sqlite3: Sqlite3Static;
let pool: SAHPoolUtil | null = null;
let db: Database;

async function open(): Promise<{ persistent: boolean; reason?: string }> {
  sqlite3 = await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "running-coach" });
    db = new pool.OpfsSAHPoolDb(DB_FILE);
    return { persistent: true };
  } catch (e) {
    // OPFS 無法使用（例如無痕視窗，或同一個網站已在另一個分頁開啟）時退回記憶體資料庫
    db = new sqlite3.oo1.DB(":memory:");
    return { persistent: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

async function handle(request: DbRequest): Promise<unknown> {
  switch (request.method) {
    case "open":
      return open();
    case "exec":
      db.exec(request.sql);
      return null;
    case "run":
      db.exec({ sql: request.sql, bind: request.params });
      return {
        lastInsertRowid: Number(sqlite3.capi.sqlite3_last_insert_rowid(db)),
        changes: db.changes(),
      };
    case "all":
      return db.exec({ sql: request.sql, bind: request.params, rowMode: "object", returnValue: "resultRows" });
    case "export":
      return sqlite3.capi.sqlite3_js_db_export(db);
    case "import": {
      if (!pool) throw new Error("目前使用的是暫時性的記憶體資料庫，無法匯入");
      db.close();
      try {
        await pool.importDb(DB_FILE, request.bytes);
      } finally {
        db = new pool.OpfsSAHPoolDb(DB_FILE);
      }
      return null;
    }
  }
}

self.onmessage = (event: MessageEvent<DbRequest>) => {
  const { id } = event.data;
  handle(event.data).then(
    (result) => self.postMessage({ id, result }),
    (e) => self.postMessage({ id, error: e instanceof Error ? e.message : String(e) }),
  );
};
