/**
 * 部署代理前填入 apps/proxy/wrangler.toml（規格 12.39）：由 .github/workflows/proxy.yml（正式）與 staging.yml（staging）在部署前執行；
 * 帳號相關的值都從 GitHub 的 Variables 來，不寫進 repo. 和同步服務共用 tools/sync-config.ts 的檢查.
 *
 *   WORKER_NAME     Worker 的名稱（選填，預設照 wrangler.toml：running-coach-proxy）
 *   DATABASE_NAME   D1 資料庫的名稱（選填，預設照 wrangler.toml）
 *   DATABASE_ID     D1 資料庫的 id（必填）
 *   WEB_URLS        允許連線的網頁網址，以空白或逗號分隔（必填，至少一個；只取來源）
 *   PROXY_POLICY    覆寫預設政策的 JSON（選填；例：{"dailyMessages":20,"totalMonthlyBudgetUsd":80}）
 *
 * 設錯時直接失敗、不部署，代理維持上一次的設定.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { loadPolicy } from "../apps/proxy/src/policy";
import { allowedOrigins, fillWranglerToml } from "./sync-config";

export interface ProxyDeployConfig {
  workerName?: string;
  databaseName?: string;
  databaseId: string;
  webUrls: string;
  policy?: string;
}

export function fillProxyWranglerToml(toml: string, config: ProxyDeployConfig): string {
  let out = fillWranglerToml(toml, config);
  const policy = config.policy?.trim();
  if (policy) {
    // 部署前先照代理讀的方式讀一次：格式錯的政策在這裡就擋下
    try {
      loadPolicy(policy);
    } catch (e) {
      throw new Error(`PROXY_POLICY 不對：${e instanceof Error ? e.message : String(e)}`);
    }
    const matches = out.match(/^PROXY_POLICY = ""$/gm);
    if (matches?.length !== 1) throw new Error("wrangler.toml 裡的 PROXY_POLICY 應該剛好一行");
    // JSON 字串的跳脫寫法在 TOML 的基本字串裡一樣能用
    out = out.replace(/^PROXY_POLICY = ""$/m, `PROXY_POLICY = ${JSON.stringify(JSON.stringify(JSON.parse(policy)))}`);
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const path = fileURLToPath(new URL("../apps/proxy/wrangler.toml", import.meta.url));
  const env = process.env;
  try {
    const config: ProxyDeployConfig = {
      workerName: env.WORKER_NAME || undefined,
      databaseName: env.DATABASE_NAME || undefined,
      databaseId: env.DATABASE_ID ?? "",
      webUrls: env.WEB_URLS ?? "",
      policy: env.PROXY_POLICY || undefined,
    };
    writeFileSync(path, fillProxyWranglerToml(readFileSync(path, "utf8"), config));
    // 只印公開的網址；D1 的 id 不印（Actions 的紀錄在公開的 repo 看得到）
    console.log(`Worker：${config.workerName ?? "（照 wrangler.toml）"}`);
    console.log(`允許的網頁來源：${allowedOrigins(config.webUrls).join(" ")}`);
    const policy = loadPolicy(config.policy);
    console.log(
      `政策：模型 ${policy.forceModel ?? "照請求"}、每天 ${policy.dailyMessages} 則、自動分析 ${policy.dailyAuto} 次、` +
        `每人每月 ${policy.defaultMonthlyBudgetUsd} 美元、合計 ${policy.totalMonthlyBudgetUsd ?? "不限"} 美元`,
    );
  } catch (e) {
    console.error(`::error::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
