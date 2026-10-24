// 驗證第一次抓紀錄的兩個選項（手機尺寸）：設定頁的下一步選「匯入全部的紀錄」、引導卡片選「同步最近 14 天」、紀錄頁沒有跑步時的選項
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;

async function setup(page, { intervals }) {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  if (intervals) await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();
  await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
}

async function newPage(browser, problems) {
  // 每次用新的 context：OPFS 與 localStorage 都是空的，等同第一次使用
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  return page;
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};

  // A. 設定頁的下一步：兩個選項，選「匯入全部的紀錄」
  let page = await newPage(browser, problems);
  await setup(page, { intervals: true });
  await page.getByText("下一步：抓進你的跑步紀錄").waitFor();
  check.settingsBoth =
    (await page.getByRole("button", { name: "同步最近 14 天" }).isVisible()) &&
    (await page.getByRole("button", { name: "匯入全部的紀錄" }).isVisible());
  await page.screenshot({ path: `${OUT}/first-1-settings.png`, fullPage: true });
  await page.getByRole("button", { name: "匯入全部的紀錄" }).click();
  await page.getByText(/更早的紀錄：匯入 \d+ 趟/).waitFor({ timeout: 60000 });
  const text = await page.locator(".notice.ok").filter({ hasText: "更早的紀錄" }).innerText();
  check.recentSynced = /同步完成/.test(text);
  check.olderAdded = Number(/匯入 (\d+) 趟/.exec(text)[1]) > 0;
  check.nextStepStays = await page.getByText("下一步：抓進你的跑步紀錄").isVisible();
  await page.screenshot({ path: `${OUT}/first-2-settings-done.png`, fullPage: true });
  // 紀錄頁：累積算進更早的跑步；最近的有分析
  await page.getByRole("button", { name: "紀錄", exact: true }).click();
  await page.locator(".runs li").first().waitFor();
  await page.locator(".blocks").waitFor({ timeout: 10000 });
  check.accumulationShown = Number(/共 (\d+) 趟/.exec(await page.locator(".blocks").getAttribute("aria-label"))[1]) > 5;
  await page.locator(".runs li").first().click();
  check.recentHasAnalysis = (await page.locator(".runs li .markdown").count()) > 0;
  await page.context().close();

  // B. 引導卡片裡選「同步最近 14 天」：完成後顯示「準備好了」
  page = await newPage(browser, problems);
  await setup(page, { intervals: true });
  await page.getByRole("button", { name: "對話", exact: true }).click();
  const card = page.locator(".getting-started");
  await card.getByText("抓進你的跑步紀錄").waitFor();
  check.cardBoth = (await card.getByRole("button", { name: "匯入全部的紀錄" }).count()) === 1;
  await page.screenshot({ path: `${OUT}/first-3-card.png`, fullPage: true });
  await card.getByRole("button", { name: "同步最近 14 天" }).click();
  await card.getByText("準備好了").waitFor({ timeout: 20000 });
  check.cardRecentOnly = !(await card.innerText()).includes("更早的紀錄");
  await page.context().close();

  // C. 紀錄頁沒有跑步時：同樣兩個選項，完成後顯示結果
  page = await newPage(browser, problems);
  await setup(page, { intervals: true });
  await page.getByRole("button", { name: "紀錄", exact: true }).click();
  await page.getByText("還沒有跑步紀錄。").waitFor();
  check.historyBoth = (await page.getByRole("button", { name: "匯入全部的紀錄" }).count()) === 1;
  await page.screenshot({ path: `${OUT}/first-4-history-empty.png`, fullPage: true });
  await page.getByRole("button", { name: "匯入全部的紀錄" }).click();
  await page.getByText(/更早的紀錄：匯入 \d+ 趟/).waitFor({ timeout: 60000 });
  check.historyListed = (await page.locator(".runs li").count()) > 0;
  check.historyChoicesGone = (await page.getByRole("button", { name: "匯入全部的紀錄" }).count()) === 0;
  await page.screenshot({ path: `${OUT}/first-5-history-done.png`, fullPage: true });
  await page.context().close();

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
