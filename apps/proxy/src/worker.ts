/** Cloudflare Workers 進入點 — 用量存在 D1. */
import type { Row, SqlDriver, SqlValue } from "@running-coach/core";

import { createProxy } from "./handler";
import { loadPolicy } from "./policy";
import { AccountStore } from "./store";

interface Env {
  DB: D1Database;
  ANTHROPIC_API_KEY: string;
  ADMIN_TOKEN?: string;
  /** 以逗號分隔的網頁來源 */
  ALLOWED_ORIGINS?: string;
  /** 覆寫預設政策的 JSON */
  PROXY_POLICY?: string;
}

function d1Driver(db: D1Database): SqlDriver {
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
  };
}

// 每個執行個體只建立一次資料表
let ready: Promise<AccountStore> | undefined;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    ready ??= (async () => {
      const store = new AccountStore(d1Driver(env.DB));
      await store.init();
      return store;
    })();

    const handle = createProxy({
      store: await ready,
      policy: loadPolicy(env.PROXY_POLICY),
      upstream: { baseUrl: "https://api.anthropic.com", apiKey: env.ANTHROPIC_API_KEY },
      adminToken: env.ADMIN_TOKEN,
      allowedOrigins: (env.ALLOWED_ORIGINS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      waitUntil: (promise) => ctx.waitUntil(promise),
      log: (line) => console.log(line),
    });
    return handle(request);
  },
};
