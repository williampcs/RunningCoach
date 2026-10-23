import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** 對外的版本號與建置資訊：版本來自 package.json；commit 在 GitHub Actions 取 GITHUB_SHA，本機取 git，都沒有時為 dev */
function buildInfo() {
  const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string };
  let commit = process.env.GITHUB_SHA?.slice(0, 7) ?? "";
  if (!commit) {
    try {
      commit = execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
    } catch {
      commit = "dev";
    }
  }
  return { version, commit, date: new Date().toISOString().slice(0, 10) };
}

/**
 * 內容安全政策：只執行本站的腳本，圖片只從本站載入（擋下模型回覆裡用圖片網址把資料帶出去）.
 * 建置結果同時有 <meta>（GitHub Pages 不能設定回應標頭）與 Cloudflare Pages 的 _headers（真正的回應標頭，
 * 另外加上 <meta> 做不到的 frame-ancestors 等，見 securityHeaders）.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  // sqlite-wasm 需要編譯 WebAssembly；這不允許 eval 一般的 JavaScript
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data:",
  // LLM 供應商與「其他相容服務」的網址由使用者填寫，無法事先列舉
  "connect-src 'self' https: http:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/**
 * Cloudflare Pages 的回應標頭（規格 12.13）：
 * - CSP 加上 frame-ancestors：不讓別的網站把這頁嵌進去騙使用者點按鈕
 * - 不讓瀏覽器猜檔案類型、不送出來源網址、關掉用不到的裝置權限（掃 QR code 用的是手機的相機 App）
 * - 只走 HTTPS
 */
const SECURITY_HEADERS: Record<string, string> = {
  "Content-Security-Policy": `${CONTENT_SECURITY_POLICY}; frame-ancestors 'none'`,
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  "Strict-Transport-Security": "max-age=31536000",
  "Cross-Origin-Opener-Policy": "same-origin",
};

/** 只加在建置結果：開發伺服器的熱更新需要行內腳本 */
function contentSecurityPolicy(): Plugin {
  return {
    name: "content-security-policy",
    apply: "build",
    transformIndexHtml: () => [
      {
        tag: "meta",
        attrs: { "http-equiv": "Content-Security-Policy", content: CONTENT_SECURITY_POLICY },
        injectTo: "head-prepend",
      },
    ],
    generateBundle() {
      const lines = Object.entries(SECURITY_HEADERS).map(([name, value]) => `  ${name}: ${value}`);
      this.emitFile({ type: "asset", fileName: "_headers", source: `/*\n${lines.join("\n")}\n` });
    },
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  define: { __APP_BUILD__: JSON.stringify(buildInfo()) },
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  // sqlite-wasm 以相對路徑載入 .wasm，預先打包會讓路徑失效
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
