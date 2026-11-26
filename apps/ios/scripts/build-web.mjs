// 建置 App 要包的網頁（規格 12.49）：網頁版照常建置，複製到 www/，再加上 App 的測試頁。
// 網址等設定讀同一個資料夾的 app.env.local（不進版控），格式同 .env：VITE_SYNC_URL=...
import { execSync } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(dirname(fileURLToPath(import.meta.url)));
const repo = join(here, "..", "..");
const envFile = join(here, "app.env.local");

const env = { VITE_STAGING: "1" };
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trimStart().startsWith("#")) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
// 正式網址的搬家提示只給瀏覽器用；App 的來源是 capacitor://localhost
delete env.VITE_WEB_URL;

console.log(`建置網頁版（${env.VITE_STAGING === "1" ? "staging" : "正式"}的設定；設定了 ${Object.keys(env).join("、")}）`);
execSync("npm run build -w @running-coach/web", { cwd: repo, stdio: "inherit", env: { ...process.env, ...env } });

const www = join(here, "www");
rmSync(www, { recursive: true, force: true });
cpSync(join(repo, "apps", "web", "dist"), www, { recursive: true });
// Cloudflare Pages 的回應標頭檔，App 裡用不到
rmSync(join(www, "_headers"), { force: true });
cpSync(join(here, "probe"), www, { recursive: true });
writeFileSync(
  join(www, "ios-probe-config.js"),
  `window.IOS_PROBE_CONFIG = ${JSON.stringify({ syncUrl: env.VITE_SYNC_URL ?? "", proxyUrl: env.VITE_PROXY_URL ?? "" })};\n`,
);
console.log("已輸出到 apps/ios/www");
