// 驗證使用說明（規格 12.12）：頁首的 ❔、搜尋、教練回覆裡的「看完整說明」連結
const E2E = require("./env.cjs");
const { chromium } = E2E;
let step = "start";
(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [false, true]) {
    const tag = mobile ? "mobile" : "desktop";
    const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
    const tab = (label) => E2E.go(page, label);
    try {
      step = "頁首的使用說明";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await page.getByRole("button", { name: "使用說明" }).click();
      await page.getByRole("heading", { name: "使用說明", exact: true }).waitFor();
      const all = await page.locator("section.help-section").count();
      check[`${tag}.allSections`] = all >= 20;
      await page.getByLabel("搜尋使用說明").fill("密碼");
      const filtered = await page.locator("section.help-section h2").allInnerTexts();
      check[`${tag}.searchFilters`] = filtered.length > 0 && filtered.length < all && filtered.includes("密碼鎖");
      await page.getByLabel("搜尋使用說明").fill("");
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/help-mobile.png` });

      step = "問教練";
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });
      await tab("對話");
      await page.getByLabel("訊息").fill("多裝置同步怎麼用？");
      await page.getByLabel("訊息").press("Enter");
      // 存好的回覆（不是串流中的）才有「參考了」
      check[`${tag}.coachUsedHelp`] = await page.locator(".msg.assistant .sources", { hasText: "App 的使用說明" }).last().waitFor({ timeout: 20000 }).then(() => true, () => false);
      const link = page.locator(".msg.assistant").last().locator("a", { hasText: "看完整說明" }).first();
      await link.click();
      step = "跳到那一段";
      await page.locator("section.help-section.target").waitFor({ timeout: 5000 });
      check[`${tag}.linkOpensSection`] = (await page.locator("section.help-section.target h2").innerText()) === "多裝置同步";
      check[`${tag}.hashCleared`] = (await page.evaluate(() => location.hash)) === "";
      const top = await page.locator("section.help-section.target").evaluate((el) => el.getBoundingClientRect().top);
      check[`${tag}.scrolledTo`] = top >= 0 && top < 400;
      check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
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
