/** Cloudflare Workers 進入點 — 加密後的紀錄存在 D1. 不記錄任何請求（wrangler 設定也關閉觀測日誌）. */
import type { Row, SqlValue } from "@running-coach/core";

import { createSyncHandler } from "./handler";
import { handleIntervalsToken, isIntervalsTokenPath } from "./intervals-token";
import { SyncStore, type SyncSqlDriver } from "./store";

interface Env {
  DB: D1Database;
  /** 以逗號分隔的網頁來源 */
  ALLOWED_ORIGINS?: string;
  /** 用 Intervals.icu 登入（規格 12.37）：client_id 是 wrangler.toml 的 var，client_secret 是 Worker 的 secret；沒有設定時登入不能用 */
  INTERVALS_CLIENT_ID?: string;
  INTERVALS_CLIENT_SECRET?: string;
}

const originsOf = (env: Env) =>
  (env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

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
    // 換 token 只轉送，不碰 D1：在初始化同步的資料表之前處理
    if (isIntervalsTokenPath(new URL(request.url).pathname)) {
      return handleIntervalsToken(request, {
        clientId: env.INTERVALS_CLIENT_ID,
        clientSecret: env.INTERVALS_CLIENT_SECRET,
        allowedOrigins: originsOf(env),
      });
    }
    ready ??= (async () => {
      const store = new SyncStore(d1Driver(env.DB));
      await store.init();
      return store;
    })();
    const handle = createSyncHandler({
      store: await ready,
      allowedOrigins: originsOf(env),
    });
    return handle(request);
  },
};
