/** Node 進入點 — 用量存在本機的 SQLite 檔. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createProxy, purgeOld } from "./handler";
import { loadPolicy } from "./policy";
import { serve } from "./server";
import { AccountStore } from "./store";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

const dbPath = process.env.PROXY_DB_PATH?.trim() || "./data/proxy.db";
mkdirSync(dirname(dbPath), { recursive: true });
const driver = openNodeSqlite(dbPath);
const store = new AccountStore(driver);
await store.init();
const limiter = new SqlRateLimiter(driver);
await limiter.init();

const policy = loadPolicy(process.env.PROXY_POLICY);
// 過了保存期限的用量紀錄：啟動時與之後每天刪一次
const purge = () => void Promise.all([purgeOld(store, policy), limiter.purge()]).catch((e) => console.error(`purge failed: ${e instanceof Error ? e.message : String(e)}`));
purge();
setInterval(purge, 86_400_000).unref();

const port = Number(process.env.PORT ?? 8787);
await serve(
  createProxy({
    store,
    rateLimiter: limiter,
    policy,
    upstream: {
      baseUrl: process.env.UPSTREAM_BASE_URL?.trim() || "https://api.anthropic.com",
      apiKey: required("ANTHROPIC_API_KEY"),
    },
    adminToken: process.env.ADMIN_TOKEN?.trim() || undefined,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
    // 來源 IP 的代碼用的金鑰（選填）：沒有時用沒有金鑰的雜湊
    hashKey: process.env.RATE_LIMIT_HASH_KEY?.trim() || undefined,
  }),
  port,
);
console.log(`proxy listening on :${port}`);
