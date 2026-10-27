/** Cloudflare Workers 進入點 — 加密後的紀錄存在 D1. 不記錄任何請求（wrangler 設定也關閉觀測日誌）. */
import type { Row, SqlValue } from "@running-coach/core";

import { createSyncHandler } from "./handler";
import { SyncStore, type SyncSqlDriver } from "./store";

interface Env {
  DB: D1Database;
  /** 以逗號分隔的網頁來源 */
  ALLOWED_ORIGINS?: string;
}

function d1Driver(db: D1Database): SyncSqlDriver {
  return {
    async exec(sql) {
      const statements = sql
        .split(";")
        .map((s) => s.trim())
        .filter(Boolean);
      await db.batch(statements.map((s) => db.prepare(s)));
    },
    async run(sql, params: SqlValue[] = []) {
      const result = await db.prepare(sql).bind(...params).run();
      return { lastInsertRowid: result.meta.last_row_id, changes: result.meta.changes };
    },
    async all(sql, params: SqlValue[] = []) {
      return (await db.prepare(sql).bind(...params).all<Row>()).results;
    },
    // D1 的 batch 是一個交易：其中一個敘述失敗時全部不做
    async batch(statements) {
      await db.batch(statements.map((s) => db.prepare(s.sql).bind(...s.params)));
    },
  };
}

// 每個執行個體只建立一次資料表
let ready: Promise<SyncStore> | undefined;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    ready ??= (async () => {
      const store = new SyncStore(d1Driver(env.DB));
      await store.init();
      return store;
    })();
    const handle = createSyncHandler({
      store: await ready,
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    });
    return handle(request);
  },
};
