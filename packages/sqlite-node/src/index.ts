/** Node 的 SQLite 儲存驅動（better-sqlite3）. */
import Database from "better-sqlite3";

import type { Row, SqlDriver, SqlValue } from "@running-coach/core";

export interface NodeSqliteDriver extends SqlDriver {
  close(): void;
}

/** path 可為檔案路徑或 ":memory:" */
export function openNodeSqlite(path: string): NodeSqliteDriver {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");

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
    close() {
      db.close();
    },
  };
}
