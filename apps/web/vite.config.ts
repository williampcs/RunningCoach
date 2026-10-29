import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseFeatures } from "../../packages/core/src/features";
import { pageForApp } from "./privacy/in-app";
import { PRIVACY_CSS_FILE, PRIVACY_HTML_FILE, privacyCss, renderPrivacyPage } from "./privacy/render";
import { renderTermsPage, TERMS_HTML_FILE } from "./terms/render";

/** 對外的版本號與建置資訊：版本來自 repo 根目錄的 package.json（唯一的來源，規格 12.19）；commit 在 GitHub Actions 取 GITHUB_SHA，本機取 git，都沒有時為 dev */
function buildInfo() {
  const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
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
/**
 * 版本檔（規格 12.18）：網頁讀它判斷伺服器上有沒有更新的版本；不能被快取，否則永遠看到舊的.
 * Cloudflare Pages 的 _headers 裡同一個路徑符合多條規則時會合併
 */
const VERSION_FILE_HEADERS = "/version.json\n  Cache-Control: no-store\n";

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
      // staging 不讓搜尋引擎收錄（規格 12.19）
      const headers = process.env.VITE_STAGING === "1" ? { ...SECURITY_HEADERS, "X-Robots-Tag": "noindex" } : SECURITY_HEADERS;
      const lines = Object.entries(headers).map(([name, value]) => `  ${name}: ${value}`);
      this.emitFile({ type: "asset", fileName: "_headers", source: `/*\n${lines.join("\n")}\n${VERSION_FILE_HEADERS}` });
    },
  };
}

/** 這次建置的隱私說明頁與使用須知的內容（依環境、同步服務的網址與功能開關） */
function legalPages() {
  const staging = process.env.VITE_STAGING === "1";
  const build = {
    staging,
    syncUrl: process.env.VITE_SYNC_URL ?? "",
    devices: parseFeatures(process.env.VITE_FEATURES, { staging }).includes("devices"),
  };
  return { privacy: renderPrivacyPage(build), terms: renderTermsPage({ staging }) };
}

/** 隱私說明頁（規格 12.20）與使用須知（12.32）：不用 JavaScript 的靜態頁，Cloudflare Pages 提供在 /privacy、/terms；staging 的版本有 Staging 標示 */
function privacyPage(): Plugin {
  return {
    name: "privacy-page",
    apply: "build",
    generateBundle() {
      const pages = legalPages();
      this.emitFile({ type: "asset", fileName: PRIVACY_HTML_FILE, source: pages.privacy });
      this.emitFile({ type: "asset", fileName: PRIVACY_CSS_FILE, source: privacyCss() });
      // 使用須知（規格 12.32）：同一種靜態頁，共用 privacy.css，提供在 /terms
      this.emitFile({ type: "asset", fileName: TERMS_HTML_FILE, source: pages.terms });
    },
  };
}

/** App 裡的面板用的使用須知與隱私說明（KI-046）：和靜態頁同一份內容，import "virtual:legal-pages" */
function legalPagesModule(): Plugin {
  const id = "virtual:legal-pages";
  return {
    name: "legal-pages-module",
    resolveId: (source) => (source === id ? `\0${id}` : null),
    load(resolved) {
      if (resolved !== `\0${id}`) return null;
      const pages = legalPages();
      // 範本改了要重新產生
      for (const file of ["privacy/page.html", "terms/page.html"]) this.addWatchFile(new URL(`./${file}`, import.meta.url).pathname);
      return `export const TERMS_HTML = ${JSON.stringify(pageForApp(pages.terms, "terms"))};\nexport const PRIVACY_HTML = ${JSON.stringify(pageForApp(pages.privacy, "privacy"))};\n`;
    },
  };
}

/** 輸出 version.json：和 __APP_BUILD__ 同一份建置資訊 */
function versionFile(build: ReturnType<typeof buildInfo>): Plugin {
  return {
    name: "version-file",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "version.json", source: `${JSON.stringify({ commit: build.commit, date: build.date })}\n` });
    },
  };
}

const BUILD = buildInfo();

export default defineConfig({
  plugins: [react(), contentSecurityPolicy(), versionFile(BUILD), privacyPage(), legalPagesModule()],
  define: { __APP_BUILD__: JSON.stringify(BUILD) },
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  // sqlite-wasm 以相對路徑載入 .wasm，預先打包會讓路徑失效
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
