// 驗證教練的長回覆（規格 12.30 第 2 點）：結論一直顯示、每個小標收成一列、全部展開；邊寫邊收（串流中小標一出現就是收起的一列、
// 正在寫的那列標「寫作中」、串流中可以點開、寫完前後版面不變）；
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

      step = "長回覆：邊寫邊收";
      const streaming = page.locator(".bubble.assistant.streaming");
      const openStates = (bubble) => bubble.locator(".reply-section").evaluateAll((els) => els.map((e) => e.open));
      const stream = {};
      const reply = await send("請詳細說明這週的安排", async () => {
        // 第一個小標一出現就是收起的一列，旁邊標「寫作中」；內文不在畫面上長出來
        const first = streaming.locator(".reply-section").first();
        await first.waitFor({ timeout: 20000 });
        stream.collapsedRow = (await first.getAttribute("open")) === null && (await streaming.locator("h2").count()) === 0;
        stream.writing = await first.locator(".reply-writing", { hasText: "寫作中" }).isVisible();
        if (!mobile) await page.screenshot({ path: `${E2E.OUT}/long-reply-streaming.png` });
        // 串流中點開正在寫的那一段：裡面照樣逐字出現
        await first.locator("summary").click();
        stream.openedWhileStreaming = await first.getByText("長跑後段的心率漂移").waitFor({ timeout: 15000 }).then(() => true, () => false);
        // 寫到第二段：第一段的「寫作中」移到第二段，第二段收著
        const second = streaming.locator(".reply-section").nth(1);
        await second.waitFor({ timeout: 15000 });
        stream.writingMoved = (await first.locator(".reply-writing").count()) === 0 && (await second.locator(".reply-writing").count()) === 1 && (await second.getAttribute("open")) === null;
        // 快寫完時的樣子（最後一段的最後幾個字）
        await streaming.locator(".reply-section").nth(2).waitFor({ timeout: 15000 });
        await page.waitForFunction(() => document.querySelector(".bubble.assistant.streaming")?.textContent.includes("輕鬆跑的心率以下"), null, { timeout: 20000 });
        stream.before = await openStates(streaming);
      });
      c.streamCollapsedRow = stream.collapsedRow === true;
      c.streamWriting = stream.writing === true;
      c.streamOpened = stream.openedWhileStreaming === true;
      c.streamWritingMoved = stream.writingMoved === true;
      // 寫完前後版面一樣：列數與打開的狀態沒變（不會突然收起）
      const after = await openStates(reply);
      c.noJumpAtEnd = JSON.stringify(stream.before) === JSON.stringify([true, false, false]) && JSON.stringify(after) === JSON.stringify(stream.before);
      c.noWritingAfter = (await reply.locator(".reply-writing").count()) === 0;
      // 回到全部收起，接著檢查寫完的樣子
      await reply.locator(".reply-section").first().locator("summary").click();

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
      // 打開有短的高度動畫：等它長出來
      const visible = (loc) => loc.waitFor({ timeout: 3000 }).then(() => true, () => false);
      c.oneOpened = (await visible(reply.getByText("組間慢跑 2 分鐘"))) && (await reply.locator(".reply-section[open]").count()) === 1;
      c.codeInBody = await visible(sections.nth(1).getByText("這行在程式碼區塊裡"));

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
