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
 * 關閉時面板會滑出，等它移除後才操作底下的頁面（滑出途中底下的頁面已經不是 inert，但等完比較穩）。
 */
async function go(page, label) {
  const button = page.getByRole("button", { name: label, exact: true });
  if (PANELS.includes(label)) {
    if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
    await page.locator("#side-panel").waitFor();
    return;
  }
  const close = page.locator("#side-panel:not(.leaving) .side-panel-close");
  if (await close.isVisible()) await close.click();
  await page.locator("#side-panel").waitFor({ state: "detached" });
  await button.click();
}

/**
 * 設定的第一層是清單，點進去才是欄位（規格 12.28）：打開設定並進到某一項（例：「AI 教練」「訓練紀錄」「天氣」）.
 * 已經在那一項就不再點；在別項時先按「設定」回到清單
 */
async function settings(page, section) {
  await go(page, "設定");
  const panel = page.locator("#side-panel");
  const current = panel.locator(".subpage");
  if (await current.count()) {
    if ((await panel.locator(".subpage .title").innerText()) === section) return;
    await panel.locator(".back-button").click();
  }
  await panel.locator(".settings-list").getByRole("button", { name: section, exact: true }).click();
  await panel.locator(".subpage .title", { hasText: section }).waitFor();
}

/**
 * 用模擬上游設定 AI 與 Intervals.icu（多數腳本的第一步）：開放相容服務、模擬的模型、同意資料流向；
 * intervals 為 false 時不填 Intervals.icu 的 key；timeZone 有值時填時區（訓練紀錄的「進階」）
 */
async function setupMock(page, { mock, intervals = true, timeZone = null } = {}) {
  await settings(page, "AI 教練");
  const panel = page.locator("#side-panel");
  await panel.getByLabel("供應商").selectOption("openai-compatible");
  await panel.getByLabel("API key", { exact: true }).fill("mock-key");
  await panel.getByLabel("服務網址").fill(`${mock}/v1`);
  await panel.getByLabel("主對話模型").fill("mock-model");
  await panel.getByLabel("我了解並同意以上的資料流向").check();
  if (intervals || timeZone) {
    await settings(page, "訓練紀錄");
    if (intervals) await panel.getByLabel("API key", { exact: true }).fill("mock-intervals-key");
    if (timeZone) {
      await panel.locator("details.advanced > summary").click();
      await panel.getByLabel("時區").fill(timeZone);
    }
  }
  await panel.getByRole("button", { name: "儲存設定" }).click();
  await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
}

module.exports = {
  go,
  settings,
  setupMock,
  chromium: loadPlaywright().chromium,
  /** vite preview 的網址 */
  URL: process.env.E2E_URL || "http://localhost:4173/",
  /** 模擬上游（npm run dev:mock） */
  MOCK: process.env.E2E_MOCK || "http://127.0.0.1:8788",
  /** 截圖放這裡，不進版控 */
  OUT,
};
