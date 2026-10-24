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

const PANELS = ["設定", "使用說明"];

/**
 * 切到分頁，或打開說明、設定的面板（規格 12.17）。
 * 面板已經開著就不再點（再點一次會關閉）；手機上面板蓋住底部的分頁，切分頁前先按 ✕ 關閉面板。
 */
async function go(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  if (PANELS.includes(label)) {
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await page.locator("#side-panel").waitFor();
    return;
  }
  const close = page.locator(".side-panel-close");
  if (await close.isVisible()) {
    await close.click();
    await page.locator("#side-panel").waitFor({ state: "detached" });
  }
  await button.click();
}

module.exports = {
  go,
  chromium: loadPlaywright().chromium,
  /** vite preview 的網址 */
  URL: process.env.E2E_URL || "http://localhost:4173/",
  /** 模擬上游（npm run dev:mock） */
  MOCK: process.env.E2E_MOCK || "http://127.0.0.1:8788",
  /** 截圖放這裡，不進版控 */
  OUT,
};
