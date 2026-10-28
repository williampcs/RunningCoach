// 驗證教練的長回覆（規格 12.30 第 2 點）：結論一直顯示、每個小標收成一列、全部展開；串流時全部展開，寫完才收起；
// 程式碼區塊裡的 ## 不算小標；記住時預填完整的內容；沒有小標的回覆照舊整段
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";
(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
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
    const c = {};
    try {
      step = "設定";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK });
      await E2E.go(page, "對話");

      step = "沒有小標的回覆照舊整段";
      const done = ".bubble.assistant:not(.muted):not(.streaming)";
      const send = async (text, whileStreaming) => {
        const before = await page.locator(done).count();
        await page.getByLabel("訊息").fill(text);
        await page.getByLabel("訊息").press("Enter");
        if (whileStreaming) await whileStreaming();
        await page.waitForFunction(([sel, n]) => document.querySelectorAll(sel).length > n, [done, before], { timeout: 30000 });
        await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
        return page.locator(done).last();
      };
      const short = await send("你好");
      c.shortNoSections = (await short.locator(".reply-section").count()) === 0 && (await short.getByRole("button", { name: "全部展開" }).count()) === 0;

      step = "長回覆：串流時全部展開";
      const streaming = page.locator(".bubble.assistant.streaming");
      let streamedHeading = false;
      let streamedCollapsed = true;
      const reply = await send("請詳細說明這週的安排", async () => {
        // 寫到第二個小標時：小標是一般的標題（沒有收起），內容看得到
        await streaming.locator("h2", { hasText: "週四的閾值課" }).waitFor({ timeout: 20000 });
        streamedHeading = await streaming.locator("h2", { hasText: "這週的狀況" }).isVisible();
        streamedCollapsed = (await streaming.locator("details").count()) > 0;
        if (!mobile) await page.screenshot({ path: `${E2E.OUT}/long-reply-streaming.png` });
      });
      c.streamingExpanded = streamedHeading && !streamedCollapsed;

      step = "寫完：結論顯示、小標收起";
      const sections = reply.locator(".reply-section");
      c.leadShown = await reply.getByText("週四的閾值課縮短成 3 × 1.5 km").isVisible();
      // 中文標點旁的粗體（「…照排。**這週」）顯示成粗體、沒有星號
      c.cjkBold = (await reply.locator("strong", { hasText: "週末長跑照排。" }).count()) === 1 && !(await reply.innerText()).includes("**");
      c.threeSections = (await sections.count()) === 3;
      c.titles = JSON.stringify(await sections.locator("summary").allInnerTexts()) === JSON.stringify(["這週的狀況", "週四的閾值課", "週末的長跑"]);
      c.collapsed = (await reply.locator(".reply-section[open]").count()) === 0 && !(await reply.getByText("組間慢跑 2 分鐘").isVisible());
      c.codeNotHeading = (await sections.locator("summary", { hasText: "程式碼區塊" }).count()) === 0;
      await page.emulateMedia({ colorScheme: "light" });
      await reply.screenshot({ path: `${E2E.OUT}/long-reply-${tag}-light.png` });
      await page.emulateMedia({ colorScheme: "dark" });
      await reply.screenshot({ path: `${E2E.OUT}/long-reply-${tag}-dark.png` });
      await page.emulateMedia({ colorScheme: "light" });

      step = "點開一段";
      await sections.nth(1).locator("summary").click();
      c.oneOpened = (await reply.getByText("組間慢跑 2 分鐘").isVisible()) && (await reply.locator(".reply-section[open]").count()) === 1;
      c.codeInBody = await sections.nth(1).getByText("這行在程式碼區塊裡").isVisible();

      step = "全部展開、全部收起";
      await reply.getByRole("button", { name: "全部展開" }).click();
      c.allOpened = (await reply.locator(".reply-section[open]").count()) === 3 && (await reply.getByRole("button", { name: "全部收起" }).isVisible());
      await page.emulateMedia({ colorScheme: "light" });
      await reply.screenshot({ path: `${E2E.OUT}/long-reply-${tag}-open.png` });
      await reply.getByRole("button", { name: "全部收起" }).click();
      c.allClosed = (await reply.locator(".reply-section[open]").count()) === 0;

      step = "點開的保持打開（再送一則訊息之後）";
      await sections.nth(0).locator("summary").click();
      await send("謝謝");
      // reply 是「最後一則」，送了新的之後要重新找有小標的那一則
      const long = page.locator(".bubble.assistant", { has: page.locator(".reply-section") }).last();
      c.keptOpen = (await long.locator(".reply-section").nth(0).getAttribute("open")) !== null;

      step = "記住時預填完整的內容";
      const msg = page.locator(".msg.assistant", { has: page.locator(".reply-section") }).last();
      await msg.hover().catch(() => undefined);
      await msg.getByRole("button", { name: "記住" }).click();
      const field = page.getByLabel(/要記住的事/);
      const text = await field.inputValue();
      c.rememberFull = text.includes("週四的閾值課縮短") && text.includes("這週的狀況");
      c.noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      c.completed = false;
    }
    for (const [k, v] of Object.entries(c)) check[`${tag}.${k}`] = v;
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
