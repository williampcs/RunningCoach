/// <reference lib="webworker" />
/** SQLite（WASM）執行緒 — 資料庫存在瀏覽器的 OPFS，不離開使用者的裝置. */
import sqlite3InitModule, { type Database, type SAHPoolUtil, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/** 正式資料是 /coach.db；測試模式用另一個檔案，兩者互不影響 */
let dbFile = "/coach.db";

export type DbRequest =
  | { id: number; method: "open"; file?: string }
  | { id: number; method: "exec"; sql: string }
  | { id: number; method: "run" | "all"; sql: string; params: (string | number | null)[] }
  | { id: number; method: "export" }
  | { id: number; method: "import"; bytes: Uint8Array }
  | { id: number; method: "reset" };

let sqlite3: Sqlite3Static;
let pool: SAHPoolUtil | null = null;
let db: Database;

async function open(file?: string): Promise<{ persistent: boolean; reason?: string }> {
  if (file) dbFile = file;
  sqlite3 = await sqlite3InitModule();
  try {
    pool = await sqlite3.installOpfsSAHPoolVfs({ name: "running-coach" });
    db = new pool.OpfsSAHPoolDb(dbFile);
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
      return open(request.file);
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
        await pool.importDb(dbFile, request.bytes);
      } finally {
        db = new pool.OpfsSAHPoolDb(dbFile);
      }
      return null;
    }
    case "reset": {
      // 清空每個資料表但保留結構，全在這一則訊息內完成：
      // 若刪檔重開，進行中的查詢（例如設定頁的狀態統計）會在資料表重建前撞上「資料表不存在」
      const tables = db.selectValues("SELECT name FROM sqlite_master WHERE type = 'table'") as string[];
      db.transaction(() => {
        db.exec("PRAGMA defer_foreign_keys = ON");
        for (const table of tables) db.exec(`DELETE FROM "${table.replaceAll('"', '""')}"`);
      });
      // 釋放空間，也不在檔案裡留下已刪資料的殘頁
      db.exec("VACUUM");
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
