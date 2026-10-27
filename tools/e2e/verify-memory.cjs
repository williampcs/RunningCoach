// 驗證記住的事、完整對話紀錄（動態載入、已整理的分隔線）、對話摘要、回覆、教練的 remember 與 search_conversations（規格 12.11）
const E2E = require("./env.cjs");
const { chromium } = E2E;
const URL = E2E.URL;

let step = "start";
(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const results = {};
  for (const mobile of [false, true]) {
    const tag = mobile ? "mobile" : "desktop";
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const tab = (label) => E2E.go(page, label);
    const c = {};
    try {
      step = "設定";
      await page.goto(URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK });

      step = "對話 12 次（超過 20 則會整理）";
      await tab("對話");
      const send = async (text) => {
        const before = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
        await page.getByLabel("訊息").fill(text);
        await page.getByLabel("訊息").press("Enter");
        await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, before, { timeout: 20000 });
        await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
      };
      for (let i = 1; i <= 12; i++) await send(`第 ${i} 個問題`);
      // 壓縮在背景：等摘要出現
      await tab("選手");
      c.summaryShown = await page.locator(".summary-text", { hasText: "模擬摘要" }).waitFor({ timeout: 20000 }).then(() => true, () => false);

      step = "動態載入與分隔線";
      await tab("對話");
      await page.locator(".bubble.user", { hasText: "第 12 個問題" }).waitFor();
      c.firstPage = (await page.locator(".msg").count()) === 20;
      c.oldestNotYet = (await page.locator(".bubble.user", { hasText: /^第 1 個問題$/ }).count()) === 0;
      await page.locator(".messages").evaluate((el) => (el.scrollTop = 0));
      c.olderLoaded = await page.locator(".bubble.user", { hasText: /^第 1 個問題$/ }).waitFor({ timeout: 10000 }).then(() => true, () => false);
      c.allLoaded = (await page.locator(".msg").count()) === 24;
      c.noMoreButton = (await page.getByRole("button", { name: "載入更早的對話" }).count()) === 0;
      c.divider = await page.locator(".archived-divider").isVisible();
      if (!mobile) await page.screenshot({ path: `${E2E.OUT}/memory-divider.png` });

      step = "回覆";
      const coachMsg = page.locator(".msg.assistant").last();
      await coachMsg.hover().catch(() => undefined);
      await coachMsg.getByRole("button", { name: "回覆" }).click();
      c.replyBar = await page.locator(".reply-bar .quote", { hasText: "回覆教練" }).isVisible();
      // 送出後、教練還在想的時候，送出中的訊息上方就有引用
      const before = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
      await page.getByLabel("訊息").fill("這堂可以換天嗎");
      await page.getByLabel("訊息").press("Enter");
      c.replyQuoteWhileSending = await page
        .locator(".msg.user", { hasText: "這堂可以換天嗎" })
        .locator(".quote", { hasText: "回覆教練" })
        .waitFor({ timeout: 3000 })
        .then(async () => (await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").count()) > 0, () => false);
      await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, before, { timeout: 20000 });
      await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
      c.replyQuoteShown = await page.locator(".msg.user", { hasText: "這堂可以換天嗎" }).locator(".quote", { hasText: "回覆教練" }).isVisible();
      c.replyBarCleared = (await page.locator(".reply-bar").count()) === 0;

      step = "按記住";
      const userMsg = page.locator(".msg.user", { hasText: "這堂可以換天嗎" });
      await userMsg.hover().catch(() => undefined);
      await userMsg.getByRole("button", { name: "記住" }).click();
      const field = page.getByLabel(/要記住的事/);
      c.prefilled = (await field.inputValue()) === "這堂可以換天嗎";
      await field.fill("週三晚上要接小孩，不能練");
      await page.locator(".remember-edit").getByRole("button", { name: "記住" }).click();
      c.rememberNotice = await page.getByText(/已記住。/).waitFor({ timeout: 5000 }).then(() => true, () => false);

      step = "請教練記住、找較早的對話";
      await send("幫我記住：鞋子跑到 600 公里要換");
      c.coachSaid = await page.locator(".bubble.assistant", { hasText: "已記下" }).last().isVisible();
      await send("我們之前聊過什麼？");
      c.searched = await page.locator(".bubble.assistant", { hasText: "找到的對話" }).last().isVisible();
      c.searchSource = await page.locator(".bubble.assistant .sources", { hasText: "較早的對話" }).last().isVisible();

      step = "選手資料頁：記住的事";
      await tab("選手");
      const card = page.locator("section.memories");
      await card.locator(".memory-list li").nth(1).waitFor();
      c.listed = (await card.locator(".memory-text").allInnerTexts()).join("|") === "週三晚上要接小孩，不能練|鞋子跑到 600 公里要換";
      c.sources = (await card.locator(".memory-meta").allInnerTexts()).map((t) => t.split("・")[0]).join("|") === "我記的|教練記的";
      await card.locator(".memory-list li").nth(1).getByRole("button", { name: "修改" }).click();
      await card.getByLabel("修改記住的事").fill("鞋子跑到 700 公里要換");
      await card.getByRole("button", { name: "儲存" }).click();
      c.edited = await card.locator(".memory-text", { hasText: "700 公里" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
      await card.getByLabel("新增記住的事").fill("右腳踝扭過，下坡要小心");
      await card.getByRole("button", { name: "新增" }).click();
      c.added = await card.locator(".memory-text", { hasText: "右腳踝" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
      await card.locator(".memory-list li", { hasText: "右腳踝" }).getByRole("button", { name: "刪除" }).click();
      c.deleted = await card.locator(".memory-text", { hasText: "右腳踝" }).waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/memory-profile-mobile.png`, fullPage: true });

      step = "重新整理後還在";
      await page.reload();
      await page.locator("nav.tabbar button").first().waitFor();
      await tab("選手");
      await page.locator("section.memories .memory-text").nth(1).waitFor({ timeout: 5000 }).catch(() => undefined);
      c.persisted = (await page.locator("section.memories .memory-text").count()) === 2;
      c.noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      c.completed = false;
    }
    results[tag] = c;
    await context.close();
  }
  for (const [tag, c] of Object.entries(results)) for (const [k, v] of Object.entries(c)) check[`${tag}.${k}`] = v;
  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
