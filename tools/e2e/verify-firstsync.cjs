// 驗證第一次抓紀錄的兩個選項（手機尺寸）：設定頁的下一步選「匯入全部的紀錄」、引導卡片選「同步最近 14 天」、紀錄頁沒有跑步時的選項
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;

// 設定的第一層是清單（規格 12.28）：用 env.cjs 的 setupMock 進到「AI 教練」「訓練紀錄」填好
const setup = (page, { intervals, timeZone = null }) => E2E.setupMock(page, { mock: E2E.MOCK, intervals, timeZone });

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
    (await page.locator("#side-panel").getByRole("button", { name: "同步最近 14 天" }).isVisible()) &&
    (await page.locator("#side-panel").getByRole("button", { name: "匯入全部的紀錄" }).isVisible());
  await page.screenshot({ path: `${OUT}/first-1-settings.png`, fullPage: true });
  await page.locator("#side-panel").getByRole("button", { name: "匯入全部的紀錄" }).click();
  await page.getByText(/更早的紀錄：匯入 \d+ 趟/).waitFor({ timeout: 60000 });
  // 成功的結果是畫面下方的小提示（規格 12.28）；下一步完成後收起
  const text = await page.locator(".toast").filter({ hasText: "更早的紀錄" }).innerText();
  check.recentSynced = /同步完成/.test(text);
  check.olderAdded = Number(/匯入 (\d+) 趟/.exec(text)[1]) > 0;
  check.nextStepDone = (await page.getByText("下一步：抓進你的跑步紀錄").count()) === 0;
  await page.screenshot({ path: `${OUT}/first-2-settings-done.png`, fullPage: true });
  // 紀錄頁：累積算進更早的跑步；最近的有分析
  await E2E.go(page, "紀錄");
  await page.locator(".runs li").first().waitFor();
  await page.locator(".blocks").waitFor({ timeout: 10000 });
  check.accumulationShown = Number(/共 (\d+) 趟/.exec(await page.locator(".blocks").getAttribute("aria-label"))[1]) > 5;
  await page.locator(".runs li").first().click();
  check.recentHasAnalysis = (await page.locator(".runs li .markdown").count()) > 0;
  await page.context().close();

  // B. 引導卡片裡選「同步最近 14 天」：完成後顯示「準備好了」
  page = await newPage(browser, problems);
  await setup(page, { intervals: true });
  await E2E.go(page, "對話");
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
  await E2E.go(page, "紀錄");
  await page.getByText("還沒有跑步紀錄。").waitFor();
  check.historyBoth = (await page.locator("main").getByRole("button", { name: "匯入全部的紀錄" }).count()) === 1;
  await page.screenshot({ path: `${OUT}/first-4-history-empty.png`, fullPage: true });
  await page.locator("main").getByRole("button", { name: "匯入全部的紀錄" }).click();
  await page.getByText(/更早的紀錄：匯入 \d+ 趟/).waitFor({ timeout: 60000 });
  await page.locator(".runs li").first().waitFor({ timeout: 10000 }).catch(() => undefined);
  check.historyListed = (await page.locator(".runs li").count()) > 0;
  check.historyChoicesGone = (await page.locator("main").getByRole("button", { name: "匯入全部的紀錄" }).count()) === 0;
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
