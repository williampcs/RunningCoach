// E2E 的共用設定（用法見 tools/e2e/README.md）
const fs = require("fs");
const os = require("os");
const path = require("path");

function loadPlaywright() {
  try {
    return require("playwright");
  } catch {
    // 雲端開發環境預先裝好的位置
    return require("/opt/node22/lib/node_modules/playwright");
  }
}

const OUT = process.env.E2E_OUT || path.join(os.tmpdir(), "running-coach-e2e");
fs.mkdirSync(OUT, { recursive: true });

module.exports = {
  chromium: loadPlaywright().chromium,
  /** vite preview 的網址 */
  URL: process.env.E2E_URL || "http://localhost:4173/",
  /** 模擬上游（npm run dev:mock） */
  MOCK: process.env.E2E_MOCK || "http://127.0.0.1:8788",
  /** 截圖放這裡，不進版控 */
  OUT,
};
