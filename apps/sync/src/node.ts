/** Node 進入點 — 本機開發與自己架設；紀錄存在本機的 SQLite 檔. */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler } from "./handler";
import { handleIntervalsToken, isIntervalsTokenPath } from "./intervals-token";
import { SyncStore } from "./store";

const dbPath = process.env.SYNC_DB_PATH?.trim() || "./data/sync.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const store = new SyncStore(openNodeSqlite(dbPath));
await store.init();
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const syncHandle = createSyncHandler({ store, allowedOrigins });
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
