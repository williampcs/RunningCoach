/** Node 進入點 — 本機開發與自己架設；紀錄存在本機的 SQLite 檔. */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { SqlRateLimiter } from "@running-coach/core/rate-limit";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler, maintain } from "./handler";
import { handleIntervalsToken, isIntervalsTokenPath } from "./intervals-token";
import { SyncStore } from "./store";

const dbPath = process.env.SYNC_DB_PATH?.trim() || "./data/sync.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const driver = openNodeSqlite(dbPath);
const store = new SyncStore(driver);
await store.init();
const limiter = new SqlRateLimiter(driver);
await limiter.init();
// 和 Workers 的排程一樣，每小時整理一次
const tidy = () => void maintain(store, { purgeRates: () => limiter.purge(), log: (line) => console.log(line) }).catch((e) => console.error(String(e)));
setInterval(tidy, 3_600_000).unref();
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// 人機驗證（Turnstile）：TURNSTILE_SECRET_KEY 有設定時才驗證
const turnstileSecret = process.env.TURNSTILE_SECRET_KEY?.trim();
const syncHandle = createSyncHandler({
  store,
  allowedOrigins,
  rateLimiter: limiter,
  turnstile: turnstileSecret ? { secret: turnstileSecret, url: process.env.TURNSTILE_VERIFY_URL || undefined } : undefined,
  dailyWrites: Number(process.env.DAILY_WRITE_BUDGET) > 0 ? Number(process.env.DAILY_WRITE_BUDGET) : undefined,
  log: (line) => console.warn(line),
  // 來源與網段的代碼用的金鑰（選填）：沒有時用沒有金鑰的雜湊
  hashKey: process.env.RATE_LIMIT_HASH_KEY?.trim() || undefined,
});
// 用 Intervals.icu 登入（規格 12.37）：INTERVALS_CLIENT_ID、INTERVALS_CLIENT_SECRET 有設定時才能用
const handle = (request: Request) =>
  isIntervalsTokenPath(new URL(request.url).pathname)
    ? handleIntervalsToken(request, {
        clientId: process.env.INTERVALS_CLIENT_ID,
        clientSecret: process.env.INTERVALS_CLIENT_SECRET,
        allowedOrigins,
        tokenUrl: process.env.INTERVALS_TOKEN_URL || undefined,
      })
    : syncHandle(request);

const port = Number(process.env.PORT ?? 8789);
createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", () => {
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method,
      headers: Object.entries(req.headers).flatMap(([k, v]) => (v === undefined ? [] : [[k, Array.isArray(v) ? v.join(", ") : v] as [string, string]])),
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    void handle(request).then(async (response) => {
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    });
  });
}).listen(port, "127.0.0.1", () => console.log(`sync server on http://127.0.0.1:${port}`));
