/** Node 進入點 — 用量存在本機的 SQLite 檔. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createProxy } from "./handler";
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
const store = new AccountStore(openNodeSqlite(dbPath));
await store.init();

const port = Number(process.env.PORT ?? 8787);
await serve(
  createProxy({
    store,
    policy: loadPolicy(process.env.PROXY_POLICY),
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
  }),
  port,
);
console.log(`proxy listening on :${port}`);
