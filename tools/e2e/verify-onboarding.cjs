// 驗證新手引導（手機尺寸）：引導卡片 → 設定 → 下一步同步 → 卡片消失；卡片內同步；跑後回報的 Markdown 摘要
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;

const setup = (page, { intervals }) => E2E.setupMock(page, { mock: E2E.MOCK, intervals });

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

  // A. 第一次打開：對話頁有引導卡片
  let page = await newPage(browser, problems);
  const card = page.locator(".getting-started");
  await card.waitFor();
  check.cardOnFirstVisit = await card.getByText("開始使用").isVisible();
  check.stepsPending = (await card.locator(".step:not(.done)").count()) === 5;
  await page.screenshot({ path: `${OUT}/onb-1-card.png`, fullPage: true });

  // Intervals.icu 的取得步驟與連結；「前往設定」直接打開設定的「AI 教練」
  const link = card.getByRole("link", { name: "Settings 頁面" });
  check.intervalsLink = (await link.getAttribute("href")) === "https://intervals.icu/settings";
  await card.getByRole("button", { name: "前往設定" }).first().click();
  check.openedAiSection = await page.locator("#side-panel .subpage .title", { hasText: "AI 教練" }).isVisible();
  await setup(page, { intervals: true });
  // 儲存後提示下一步，按下就在設定頁同步
  const next = page.getByText("下一步：抓進你的跑步紀錄");
  await next.waitFor();
  check.nextStepAfterSave = await next.isVisible();
  await page.screenshot({ path: `${OUT}/onb-2-settings-next.png`, fullPage: true });
  await page.locator("#side-panel").getByRole("button", { name: "同步最近 14 天" }).click();
  await page.getByText(/同步完成/).first().waitFor({ timeout: 20000 });
  check.syncFromSettings = true;
  // 回到對話頁：必要步驟都完成，卡片消失
  await E2E.go(page, "對話");
  await page.getByText("跟教練說說你的目標").waitFor();
  check.cardGoneAfterSetup = (await page.locator(".getting-started").count()) === 0;

  // 紀錄頁：AI 摘要的第一句是結論，其餘收起；以 Markdown 渲染（條列），不露出 ** 符號
  await E2E.go(page, "紀錄");
  const item = page.locator("ul.runs > li").first();
  await item.locator(".run-row").click();
  await item.locator(".run-summary").waitFor();
  check.summaryHeadline = (await item.locator(".run-summary > .markdown").first().innerText()).includes("穩定的有氧跑");
  await item.locator(".run-summary details summary").click();
  check.summaryList = (await item.locator(".run-summary details .markdown li").count()) > 0;
  check.noRawAsterisks = !(await page.locator("ul.runs").innerText()).includes("**");
  await page.screenshot({ path: `${OUT}/onb-3-report.png`, fullPage: true });
  await page.context().close();

  // B. 只完成設定、沒同步：卡片裡的「立即同步」可直接用，完成後顯示結果與下一步
  page = await newPage(browser, problems);
  await setup(page, { intervals: true });
  await E2E.go(page, "對話");
  const card2 = page.locator(".getting-started");
  await card2.waitFor();
  check.stepsDoneMarked = (await card2.locator(".step.done").count()) === 3; // 記錄方式（連好 Intervals.icu 就不用問）、AI、Intervals.icu
  await card2.getByRole("button", { name: "同步最近 14 天" }).click();
  await card2.getByText("準備好了").waitFor({ timeout: 20000 });
  check.syncFromCard = await card2.getByText(/同步完成/).isVisible();
  await page.screenshot({ path: `${OUT}/onb-4-card-done.png`, fullPage: true });
  await card2.getByRole("button", { name: "知道了" }).click();
  check.dismissed = (await page.locator(".getting-started").count()) === 0;
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
