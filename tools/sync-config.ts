/**
 * 部署同步服務前填入 apps/sync/wrangler.toml（規格 12.10、12.19）：由 .github/workflows/sync.yml（正式）與
 * staging.yml（staging）在部署前執行；帳號相關的值都從 GitHub 的 Variables 來，不寫進 repo.
 *
 *   WORKER_NAME     Worker 的名稱（選填，預設照 wrangler.toml：running-coach-sync）
 *   DATABASE_NAME   D1 資料庫的名稱（選填，預設照 wrangler.toml）
 *   DATABASE_ID     D1 資料庫的 id（必填）
 *   WEB_URLS        允許連線的網頁網址，以空白或逗號分隔（必填，至少一個；只取來源）
 *
 * 允許的來源設錯，那個網址的同步就會失敗：網址不是 https、沒有任何網址、wrangler.toml 的格式和預期不同時
 * 直接失敗、不部署，正式的同步服務維持上一次的設定.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface SyncDeployConfig {
  workerName?: string;
  databaseName?: string;
  databaseId: string;
  webUrls: string;
}

/** 網址轉成去掉重複的來源（https://host）；有任何一個不是 https 的網址就失敗 */
export function allowedOrigins(webUrls: string): string[] {
  const origins: string[] = [];
  for (const value of webUrls.split(/[\s,]+/).filter(Boolean)) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`不是網址：${value}`);
    }
    if (url.protocol !== "https:") throw new Error(`網頁的網址要是 https：${value}`);
    if (!origins.includes(url.origin)) origins.push(url.origin);
  }
  if (origins.length === 0) throw new Error("沒有任何允許的網頁網址：沒有網頁可以連線同步服務，不部署");
  return origins;
}

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/** 把設定填進 wrangler.toml 的內容；每個要填的欄位都要剛好出現一次 */
export function fillWranglerToml(toml: string, config: SyncDeployConfig): string {
  if (!/^[0-9a-f-]+$/i.test(config.databaseId)) throw new Error("D1 資料庫的 id 格式不對（應該是 xxxxxxxx-xxxx-… 的形式）");
  for (const name of [config.workerName, config.databaseName]) {
    if (name && !NAME.test(name)) throw new Error(`名稱只能有小寫英文、數字與 -：${name}`);
  }
  const origins = allowedOrigins(config.webUrls).join(",");
  const replace = (text: string, pattern: RegExp, line: string | undefined): string => {
    if (line === undefined) return text;
    const matches = text.match(new RegExp(pattern.source, "gm"));
    if (matches?.length !== 1) throw new Error(`wrangler.toml 裡的 ${pattern.source} 應該剛好一行，找到 ${matches?.length ?? 0} 行`);
    return text.replace(new RegExp(pattern.source, "m"), line);
  };
  let out = toml;
  out = replace(out, /^name = ".*"$/, config.workerName && `name = "${config.workerName}"`);
  out = replace(out, /^database_name = ".*"$/, config.databaseName && `database_name = "${config.databaseName}"`);
  out = replace(out, /^database_id = ""$/, `database_id = "${config.databaseId}"`);
  out = replace(out, /^ALLOWED_ORIGINS = ""$/, `ALLOWED_ORIGINS = "${origins}"`);
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = fileURLToPath(new URL("../apps/sync/wrangler.toml", import.meta.url));
  const env = process.env;
  try {
    const config: SyncDeployConfig = {
      workerName: env.WORKER_NAME || undefined,
      databaseName: env.DATABASE_NAME || undefined,
      databaseId: env.DATABASE_ID ?? "",
      webUrls: env.WEB_URLS ?? "",
    };
    writeFileSync(path, fillWranglerToml(readFileSync(path, "utf8"), config));
    // 只印公開的網址；D1 的 id 不印（Actions 的紀錄在公開的 repo 看得到）
    console.log(`Worker：${config.workerName ?? "（照 wrangler.toml）"}`);
    console.log(`允許的網頁來源：${allowedOrigins(config.webUrls).join(" ")}`);
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
