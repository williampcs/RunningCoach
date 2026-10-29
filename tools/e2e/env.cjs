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

/**
 * E2E_NOW（例：2026-10-29T23:50:00+08:00）：每個新的 context 的時鐘從那個時間開始照常走（Playwright 的 clock，計時器不受影響），
 * 搭配模擬上游的 MOCK_NOW 測跨日。不設時是真的時間
 */
function withClock(chromium) {
  const now = process.env.E2E_NOW;
  if (!now) return chromium;
  const offset = Date.parse(now) - Date.now();
  if (Number.isNaN(offset)) throw new Error(`E2E_NOW 不是時間：${now}`);
  const launch = chromium.launch.bind(chromium);
  return Object.assign(Object.create(chromium), {
    launch: async (...args) => {
      const browser = await launch(...args);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async (...options) => {
        const context = await newContext(...options);
        await context.clock.setSystemTime(new Date(Date.now() + offset));
        return context;
      };
      return browser;
    },
  });
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
 * 用模擬上游設定 AI 與 Intervals.icu（多數腳本的第一步）：開放相容服務、模擬的模型、同意資料流向與使用須知；
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
  await panel.getByLabel("我已閱讀使用須知").check();
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

/**
 * 選手頁（規格 12.30）：第一層是「我的數字」＋五列，點進去才是欄位。進到某一列（例：「目標」「身體」「練什麼、怎麼練」）；
 * 沒給 row 時回到第一層。在下一層時先按左上角的返回（每項運動那一層要按兩次）
 */
async function profile(page, row) {
  await go(page, "選手");
  const back = page.locator(".profile-subpage .back-button");
  for (let i = 0; i < 3 && (await back.count()); i++) await back.first().click();
  await page.locator(".profile-list").waitFor({ timeout: 10000 });
  if (!row) return;
  await page.locator(".profile-list").getByRole("button", { name: row, exact: true }).click();
  await page.locator(".profile-subpage .title", { hasText: row }).waitFor();
}

/** 選手資料改了就存：做完 action（填欄位、選選單）後離開欄位，等畫面下方出現新的「已儲存」 */
async function profileSave(page, action) {
  // 只算「已儲存」（「設定已儲存在這個瀏覽器。」不算）
  const saved = () => page.locator(".toast", { hasText: /^\s*已儲存\s*$/ }).count();
  const before = await saved();
  if (action) await action();
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
  await page
    .waitForFunction((n) => [...document.querySelectorAll(".toast")].filter((t) => t.textContent.trim() === "已儲存").length > n, before, { timeout: 5000 })
    .catch(() => undefined);
}

/**
 * 點使用須知或隱私說明的連結（KI-046）：在 App 的面板打開（標題、內容），沒有開新分頁、還在同一頁；
 * 看完按 ✕ 回到點之前的地方（從說明或設定點進來的回到那裡）
 */
async function opensLegalPanel(page, link, title) {
  const context = page.context();
  let popup = false;
  const onPage = () => (popup = true);
  context.on("page", onPage);
  const before = page.url().split("#")[0];
  await link.click();
  const head = page.locator("#side-panel .side-panel-head h2", { hasText: new RegExp(`^${title}$`) });
  const opened = await head.waitFor({ timeout: 5000 }).then(() => true, () => false);
  const content = opened && (await page.locator("#side-panel .legal-page section").count()) >= 4;
  const noBackLink = (await page.locator("#side-panel .legal-page a", { hasText: "回到 Zone2Mate" }).count()) === 0;
  await page.waitForTimeout(300);
  context.off("page", onPage);
  const samePage = page.url().split("#")[0] === before;
  if (opened) {
    await page.locator("#side-panel .side-panel-close").click();
    await head.waitFor({ state: "detached", timeout: 5000 }).catch(() => undefined);
  }
  return opened && content && noBackLink && samePage && !popup;
}

/**
 * 從 link 打開 first（使用須知或隱私說明），再在兩頁之間依序切換：first → 另一頁 → first → 另一頁（KI-046）.
 * 回傳每一步都換到對的面板；結束時停在另一頁，由呼叫的人按 ✕ 或返回
 */
async function hopLegal(page, link, first) {
  const other = first === "使用須知" ? "隱私說明" : "使用須知";
  const head = page.locator("#side-panel .side-panel-head h2");
  const at = (title) => head.filter({ hasText: new RegExp(`^${title}$`) }).waitFor({ timeout: 5000 }).then(() => true, () => false);
  await link.click();
  let ok = await at(first);
  for (const title of [other, first, other]) {
    await page.locator("#side-panel .legal-page").getByRole("link", { name: title }).first().click();
    ok = (await at(title)) && ok;
  }
  return ok;
}

/**
 * 模擬加到主畫面（display-mode: standalone）：先用 Chromium 的 CDP，不支援時把 matchMedia 的 display-mode 換成 standalone.
 * 只模擬 App 看得到的部分；真的加到主畫面時的視窗由使用者在手機上試
 */
async function emulateStandalone(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "display-mode", value: "standalone" }] }).catch(() => undefined);
  return page.evaluate(() => {
    if (!matchMedia("(display-mode: standalone)").matches) {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query) => {
        const result = original(query);
        if (!/display-mode:\s*standalone/.test(query)) return result;
        return Object.create(result, { matches: { value: true }, media: { value: query } });
      };
    }
    return matchMedia("(display-mode: standalone)").matches;
  });
}

module.exports = {
  go,
  opensLegalPanel,
  hopLegal,
  emulateStandalone,
  settings,
  profile,
  profileSave,
  setupMock,
  chromium: withClock(loadPlaywright().chromium),
  /** vite preview 的網址 */
  URL: process.env.E2E_URL || "http://localhost:4173/",
  /** 模擬上游（npm run dev:mock） */
  MOCK: process.env.E2E_MOCK || "http://127.0.0.1:8788",
  /** 截圖放這裡，不進版控 */
  OUT,
};
