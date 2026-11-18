/** Cloudflare Workers 進入點 — 加密後的紀錄存在 D1. 不記錄任何請求（wrangler 設定也關閉觀測日誌）. */
import type { Row, SqlValue } from "@running-coach/core";
import { SqlRateLimiter } from "@running-coach/core/rate-limit";

import { createSyncHandler, maintain } from "./handler";
import { handleIntervalsToken, isIntervalsTokenPath } from "./intervals-token";
import { SyncStore, type SyncSqlDriver } from "./store";

interface Env {
  DB: D1Database;
  /** 以逗號分隔的網頁來源 */
  ALLOWED_ORIGINS?: string;
  /** 用 Intervals.icu 登入（規格 12.37）：client_id 是 wrangler.toml 的 var，client_secret 是 Worker 的 secret；沒有設定時登入不能用 */
  INTERVALS_CLIENT_ID?: string;
  INTERVALS_CLIENT_SECRET?: string;
  /** 人機驗證（Turnstile）：網頁版有 site key 時部署填成 "on"（wrangler.toml 的 var）；secret key 是 Worker 的 secret. 兩個都有才驗證 */
  TURNSTILE?: string;
  TURNSTILE_SECRET_KEY?: string;
  /** 整個服務每天估算最多寫入幾列（wrangler.toml 的 var，部署時填入；空的用預設） */
  DAILY_WRITE_BUDGET?: string;
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
let ready: Promise<{ store: SyncStore; limiter: SqlRateLimiter }> | undefined;

function storeOf(env: Env) {
  ready ??= (async () => {
    const driver = d1Driver(env.DB);
    const store = new SyncStore(driver);
    await store.init();
    // 頻率限制的計數也在同一個 D1：所有執行個體共用
    const limiter = new SqlRateLimiter(driver);
    await limiter.init();
    return { store, limiter };
  })();
  return ready;
}

export default {
  /** 每小時（wrangler.toml 的 crons）：清掉沒在用的空空間、過期的配對碼與計數；接近上限時留下警告 */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const { store, limiter } = await storeOf(env);
        await maintain(store, { purgeRates: () => limiter.purge(), log: (line) => (line.startsWith("WARNING") ? console.warn(line) : console.log(line)) });
      })(),
    );
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    // 換 token 只轉送，不碰 D1：在初始化同步的資料表之前處理
    if (isIntervalsTokenPath(new URL(request.url).pathname)) {
      return handleIntervalsToken(request, {
        clientId: env.INTERVALS_CLIENT_ID,
        clientSecret: env.INTERVALS_CLIENT_SECRET,
        allowedOrigins: originsOf(env),
      });
    }
    const { store, limiter } = await storeOf(env);
    const handle = createSyncHandler({
      store,
      allowedOrigins: originsOf(env),
      rateLimiter: limiter,
      turnstile: env.TURNSTILE === "on" && env.TURNSTILE_SECRET_KEY?.trim() ? { secret: env.TURNSTILE_SECRET_KEY.trim() } : undefined,
      dailyWrites: Number(env.DAILY_WRITE_BUDGET) > 0 ? Number(env.DAILY_WRITE_BUDGET) : undefined,
      // 只有數量與被限制的種類，沒有 IP 或內容
      log: (line) => console.warn(line),
    });
    return handle(request);
  },
};
