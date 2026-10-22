/** Node 進入點 — 本機開發與自己架設；紀錄存在本機的 SQLite 檔. */
import { createServer } from "node:http";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createSyncHandler } from "./handler";
import { SyncStore } from "./store";

const dbPath = process.env.SYNC_DB_PATH?.trim() || "./data/sync.db";
if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
const store = new SyncStore(openNodeSqlite(dbPath));
await store.init();
const handle = createSyncHandler({
  store,
  allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "http://localhost:5173,http://localhost:4173")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
});

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
