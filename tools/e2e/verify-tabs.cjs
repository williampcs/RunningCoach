// 驗證同一時間只有一個分頁用資料庫、第二個分頁可以接手（KI-046）：
// - 開著 App 時再開一個分頁：看到「已經在另一個分頁開著」，不退回記憶體資料庫（沒有「無法使用瀏覽器的持久儲存」）
// - 按「在這裡使用」：第二個分頁打開 App、看得到第一個分頁存的對話、可以寫；第一個分頁顯示「已經在另一個分頁使用」
// - 第一個分頁按「在這裡繼續」拿回來，兩邊的資料都在；再切回第二個也一樣；不會兩邊同時開著 App
// - 從使用須知的靜態頁按「← 回到 Zone2Mate」（原本的錯誤）：看到「已經在另一個分頁開著」而不是無法保存
// - 只有一個分頁時重新整理：照常打開，不會誤判成另一個分頁開著
// - 加到主畫面（模擬 display-mode: standalone）：點「使用須知」在面板打開，沒有新的視窗
// - 手機淺色與電腦深色的截圖（`tabs-*`）
const E2E = require("./env.cjs");
const { chromium } = E2E;

const TERMS = new URL("terms", E2E.URL).href;
const MEMORY_WARNING = "目前無法使用瀏覽器的持久儲存";
let step = "start";

const viewports = {
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" },
  desktop: { viewport: { width: 1280, height: 900 }, colorScheme: "dark" },
};

const appReady = (page) => page.locator("nav.tabbar button").first().waitFor({ timeout: 10000 }).then(() => true, () => false);
const gate = (page) => page.locator(".tab-gate");
const gateTitle = (page) => gate(page).locator("h2").innerText({ timeout: 10000 }).catch(() => "");
const hasApp = async (page) => (await page.locator("nav.tabbar").count()) > 0;

async function send(page, text) {
  await E2E.go(page, "對話");
  const before = await page.locator(".msg.assistant").count();
  await page.getByLabel("訊息").fill(text);
  await page.getByLabel("訊息").press("Enter");
  return page
    .waitForFunction((n) => document.querySelectorAll(".msg.assistant").length > n, before, { timeout: 20000 })
    .then(() => true, () => false);
}

const hasMessage = (page, text) =>
  page.locator(".msg.user", { hasText: text }).first().waitFor({ timeout: 5000 }).then(() => true, () => false);

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};

  for (const [tag, options] of Object.entries(viewports)) {
    const context = await browser.newContext(options);
    const watch = (page, name) => {
      page.on("console", (m) => m.type() === "error" && problems.push(`[${tag} ${name} ${step}] ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${tag} ${name} ${step}] ${e.message}`));
    };
    const a = await context.newPage();
    watch(a, "A");
    try {
      step = "第一個分頁";
      await a.goto(E2E.URL);
      check[`${tag}.aOpens`] = await appReady(a);
      await E2E.setupMock(a, { mock: E2E.MOCK, intervals: false });
      check[`${tag}.aWrites`] = await send(a, "第一個分頁的訊息");

      step = "重新整理";
      await a.reload();
      check[`${tag}.reloadOpens`] = (await appReady(a)) && (await gate(a).count()) === 0;
      check[`${tag}.reloadPersistent`] = !(await a.getByText(MEMORY_WARNING).isVisible());
      check[`${tag}.reloadKeepsData`] = await hasMessage(a, "第一個分頁的訊息");

      step = "第二個分頁";
      const b = await context.newPage();
      watch(b, "B");
      await b.goto(E2E.URL);
      check[`${tag}.bSeesBusy`] = (await gateTitle(b)) === "已經在另一個分頁開著";
      check[`${tag}.bNoApp`] = !(await hasApp(b));
      check[`${tag}.bNoMemoryFallback`] = (await b.getByText(MEMORY_WARNING).count()) === 0;
      await b.screenshot({ path: `${E2E.OUT}/tabs-busy-${tag}.png` });
      check[`${tag}.aStillWorks`] = (await hasApp(a)) && (await send(a, "還在第一個分頁"));

      step = "在這裡使用";
      await b.getByRole("button", { name: "在這裡使用" }).click();
      check[`${tag}.bOpens`] = await appReady(b);
      check[`${tag}.bPersistent`] = (await b.getByText(MEMORY_WARNING).count()) === 0;
      await E2E.go(b, "對話");
      check[`${tag}.bSeesAData`] = (await hasMessage(b, "第一個分頁的訊息")) && (await hasMessage(b, "還在第一個分頁"));
      check[`${tag}.aSeesMoved`] = (await gateTitle(a)) === "已經在另一個分頁使用";
      check[`${tag}.aNoApp`] = !(await hasApp(a));
      await a.screenshot({ path: `${E2E.OUT}/tabs-moved-${tag}.png` });
      check[`${tag}.bWrites`] = await send(b, "第二個分頁的訊息");

      step = "在這裡繼續";
      await a.getByRole("button", { name: "在這裡繼續" }).click();
      check[`${tag}.aBack`] = await appReady(a);
      check[`${tag}.aBackPersistent`] = (await a.getByText(MEMORY_WARNING).count()) === 0;
      await E2E.go(a, "對話");
      check[`${tag}.aSeesBData`] = (await hasMessage(a, "第一個分頁的訊息")) && (await hasMessage(a, "第二個分頁的訊息"));
      check[`${tag}.bSeesMoved`] = (await gateTitle(b)) === "已經在另一個分頁使用";
      check[`${tag}.aWritesAgain`] = await send(a, "回到第一個分頁");

      step = "再切到第二個";
      await b.getByRole("button", { name: "在這裡繼續" }).click();
      check[`${tag}.bBack`] = await appReady(b);
      await E2E.go(b, "對話");
      check[`${tag}.bSeesAll`] = (await hasMessage(b, "回到第一個分頁")) && (await hasMessage(b, "第二個分頁的訊息"));
      check[`${tag}.aMovedAgain`] = (await gateTitle(a)) === "已經在另一個分頁使用";
      check[`${tag}.onlyOneApp`] = (await hasApp(a)) !== (await hasApp(b));

      step = "從使用須知的靜態頁回到 App";
      const c = await context.newPage();
      watch(c, "C");
      await c.goto(TERMS);
      await c.getByRole("link", { name: "← 回到 Zone2Mate" }).click();
      check[`${tag}.staticBackSeesBusy`] = (await gateTitle(c)) === "已經在另一個分頁開著";
      check[`${tag}.staticBackNoMemory`] = (await c.getByText(MEMORY_WARNING).count()) === 0;
      await c.close();
      await a.close();

      step = "加到主畫面";
      await b.reload();
      check[`${tag}.bReloadOpens`] = (await appReady(b)) && (await gate(b).count()) === 0;
      check[`${tag}.standalone`] = await E2E.emulateStandalone(b);
      await E2E.go(b, "對話");
      check[`${tag}.standaloneTermsInPanel`] = await E2E.opensLegalPanel(b, b.locator(".chat-page .terms-short").getByRole("link", { name: "使用須知" }), "使用須知");
      check[`${tag}.standaloneOnePage`] = context.pages().length === 1;
      check[`${tag}.standaloneStillPersistent`] = (await b.getByText(MEMORY_WARNING).count()) === 0;
      await b.screenshot({ path: `${E2E.OUT}/tabs-standalone-${tag}.png` });
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      check[`${tag}.completed`] = false;
    }
    await context.close();
  }

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
