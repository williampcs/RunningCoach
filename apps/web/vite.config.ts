import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * 內容安全政策：只執行本站的腳本，圖片只從本站載入（擋下模型回覆裡用圖片網址把資料帶出去）.
 * GitHub Pages 不能設定回應標頭，所以用 <meta>；frame-ancestors 在 <meta> 中無效。
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
  };
}

export default defineConfig({
  plugins: [react(), contentSecurityPolicy()],
  server: { port: 5173, strictPort: true },
  worker: { format: "es" },
  // sqlite-wasm 以相對路徑載入 .wasm，預先打包會讓路徑失效
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
});
