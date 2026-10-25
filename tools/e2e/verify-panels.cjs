// 驗證說明與設定的面板（規格 12.17）：同一個按鈕開關、✕、Esc、瀏覽器上一頁、說明與設定互換、
// 關閉後對話打到一半的字與捲動位置還在、「前往設定」與說明連結打開面板、電腦上點側邊的分頁；
// 卡片之間的間距、關閉時滑出、滑出途中再打開、減少動態效果時直接關閉、焦點、底下的頁面 inert（12.17 的後續）；手機與電腦、淺色與深色的截圖
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

async function send(page, text) {
  const before = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
  await page.getByLabel("訊息").fill(text);
  await page.getByLabel("訊息").press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, before, { timeout: 20000 });
  await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
}

const panel = (page) => page.locator("#side-panel");
const panelName = (page) => panel(page).getAttribute("aria-label");
const closed = (page) => panel(page).waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
// 面板裡相鄰的卡片之間的最小距離
const minCardGap = (page) =>
  panel(page).evaluate((el) => {
    const cards = [...el.querySelectorAll(".side-panel-body section.card")].filter((c) => c.offsetParent).map((c) => c.getBoundingClientRect());
    let min = Infinity;
    for (let i = 1; i < cards.length; i++) min = Math.min(min, cards[i].top - cards[i - 1].bottom);
    return cards.length >= 2 ? min : -1;
  });
const focusIn = (page, selector) => page.evaluate((s) => !!document.activeElement?.closest(s), selector);

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${mobile ? "390" : "1280"}-${scheme}`;
      const context = await browser.newContext({
        ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
        colorScheme: scheme,
        timezoneId: "Asia/Taipei",
      });
      const page = await context.newPage();
      page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
      const settingsButton = page.getByRole("button", { name: "設定", exact: true });
      const helpButton = page.getByRole("button", { name: "使用說明", exact: true });
      try {
        step = "前往設定";
        await page.goto(E2E.URL);
        await page.locator("nav.tabbar button").first().waitFor();
        await page.locator(".getting-started").getByRole("button", { name: "前往設定" }).first().click();
        check[`${tag}.gettingStartedOpens`] = (await panelName(page)) === "設定" && (await settingsButton.getAttribute("aria-expanded")) === "true";
        // 開始使用的卡片（底下的對話頁）還在
        check[`${tag}.underlyingMounted`] = (await page.locator(".getting-started").count()) === 1;
        step = "同一個按鈕關閉";
        await settingsButton.click();
        check[`${tag}.toggleCloses`] = (await closed(page)) && (await settingsButton.getAttribute("aria-expanded")) === "false";

        step = "設定";
        await E2E.go(page, "設定");
        await page.getByLabel("時區").fill("Asia/Taipei");
        await page.getByLabel("供應商").selectOption("openai-compatible");
        await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
        await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
        await page.getByLabel("主對話模型").fill("mock-model");
        await page.getByLabel("我了解並同意以上的資料流向").check();
        await page.getByRole("button", { name: "儲存設定" }).click();
        await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
        // 卡片之間有間距（和分頁上一樣 12px）
        check[`${tag}.settingsCardGap`] = (await minCardGap(page)) >= 11;
        await panel(page).getByRole("button", { name: "關閉設定" }).click();
        {
          const leaving = await panel(page).evaluate((el) => el.classList.contains("leaving") && el.inert).catch(() => false);
          const backdropLeaving = (await page.locator(".panel-backdrop.leaving").count()) === 1;
          check[`${tag}.slidesOut`] = leaving && backdropLeaving;
        }
        check[`${tag}.closeButton`] = await closed(page);
        // 打開前焦點在「前往設定」，卡片已經換成下一步了：焦點回到 ⚙️ 或那張卡片裡，不會留在 body
        check[`${tag}.focusNotLost`] = await page.evaluate(() => document.activeElement !== document.body);

        step = "對話";
        await page.locator(".getting-started").getByRole("button", { name: "先略過" }).click().catch(() => undefined);
        for (let i = 1; i <= 8; i++) await send(page, `第 ${i} 則：今天跑得怎麼樣？`);
        const messages = page.locator(".messages");
        const scrollable = await messages.evaluate((el) => el.scrollHeight > el.clientHeight + 200);
        check[`${tag}.chatScrollable`] = scrollable;
        // 捲到中間，打一半的字
        const target = await messages.evaluate((el) => {
          el.scrollTop = Math.round((el.scrollHeight - el.clientHeight) / 2);
          return el.scrollTop;
        });
        const draft = "打到一半的字，還沒送出";
        await page.getByLabel("訊息").fill(draft);
        const kept = async () =>
          (await page.getByLabel("訊息").inputValue()) === draft && Math.abs((await messages.evaluate((el) => el.scrollTop)) - target) <= 1;

        step = "Esc";
        await settingsButton.click();
        await panel(page).waitFor();
        // 焦點移進面板的標題；底下的頁面 inert，Tab 不會走到底下的對話
        check[`${tag}.focusMovesIn`] = await focusIn(page, "#side-panel h2");
        check[`${tag}.mainInert`] = await page.locator("main.page").evaluate((el) => el.inert);
        // 手機上底部的分頁被蓋住，也是 inert；電腦上側邊的分頁維持點得到（12.17）
        check[`${tag}.tabbarInert`] = (await page.locator("nav.tabbar").evaluate((el) => el.inert)) === mobile;
        await page.waitForTimeout(300);
        await page.screenshot({ path: `${E2E.OUT}/panels-${tag}-settings.png` });
        if (mobile) {
          // 手機：蓋滿標題列以下，底部的分頁被蓋住
          const box = await panel(page).boundingBox();
          check[`${tag}.coversWidth`] = Math.abs(box.width - 390) <= 1;
          check[`${tag}.coversTabbar`] = await page.evaluate(() => {
            const r = document.querySelector("nav.tabbar").getBoundingClientRect();
            return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("#side-panel");
          });
        } else {
          // 電腦：約一半寬，底下看得到（變暗）
          const box = await panel(page).boundingBox();
          check[`${tag}.halfWidth`] = box.width >= 1280 * 0.4 && box.width <= 1280 * 0.55 && Math.abs(box.x + box.width - 1280) <= 1;
          check[`${tag}.backdrop`] = await page.locator(".panel-backdrop").isVisible();
        }
        // 截圖之後才按 Tab（焦點移動會捲動面板）
        {
          let reachedPage = false;
          for (let i = 0; i < 12; i++) {
            await page.keyboard.press("Tab");
            if (await focusIn(page, "main.page")) reachedPage = true;
          }
          check[`${tag}.tabStaysOutOfPage`] = !reachedPage;
        }
        check[`${tag}.topbarStaysClickable`] = await page.evaluate(() => {
          const b = document.querySelector(".help-button").getBoundingClientRect();
          return !!document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2)?.closest(".help-button");
        });
        step = "設定換成說明";
        await helpButton.click();
        check[`${tag}.switchToHelp`] =
          (await panelName(page)) === "使用說明" &&
          (await panel(page).count()) === 1 &&
          (await settingsButton.getAttribute("aria-expanded")) === "false" &&
          (await helpButton.getAttribute("aria-expanded")) === "true";
        await page.waitForTimeout(300);
        check[`${tag}.helpCardGap`] = (await minCardGap(page)) >= 11;
        await page.screenshot({ path: `${E2E.OUT}/panels-${tag}-help.png` });
        await settingsButton.click();
        check[`${tag}.switchToSettings`] = (await panelName(page)) === "設定";
        await page.keyboard.press("Escape");
        check[`${tag}.escCloses`] = await closed(page);
        check[`${tag}.keptAfterEsc`] = await kept();
        // 焦點回到打開它的 ⚙️
        check[`${tag}.focusReturns`] = await focusIn(page, ".settings-button");
        check[`${tag}.mainNotInert`] = !(await page.locator("main.page").evaluate((el) => el.inert));

        step = "滑出途中再打開";
        await settingsButton.click();
        await panel(page).waitFor();
        await page.waitForTimeout(300);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(60);
        await settingsButton.click();
        await page.waitForTimeout(500);
        check[`${tag}.reopenWhileLeaving`] =
          (await panel(page).count()) === 1 &&
          !(await panel(page).evaluate((el) => el.classList.contains("leaving"))) &&
          (await settingsButton.getAttribute("aria-expanded")) === "true" &&
          (await panel(page).evaluate((el) => Math.round(el.getBoundingClientRect().right))) === (mobile ? 390 : 1280);
        await page.keyboard.press("Escape");
        await closed(page);

        step = "上一頁";
        const before = page.url();
        await helpButton.click();
        await panel(page).waitFor();
        await settingsButton.click(); // 換面板不會多一筆歷史紀錄
        await page.goBack();
        check[`${tag}.backCloses`] = (await closed(page)) && page.url() === before;
        check[`${tag}.keptAfterBack`] = await kept();

        step = "✕";
        await helpButton.click();
        await panel(page).getByLabel("搜尋使用說明").fill("密碼");
        await panel(page).getByRole("button", { name: "關閉使用說明" }).click();
        check[`${tag}.xCloses`] = await closed(page);
        check[`${tag}.keptAfterX`] = await kept();
        // 再點一次同一個按鈕關閉後，上一頁不會再打開面板
        await helpButton.click();
        await panel(page).waitFor();
        await helpButton.click();
        check[`${tag}.toggleCloses2`] = (await closed(page)) && (await kept());

        step = "說明連結";
        await page.getByLabel("訊息").fill("");
        await send(page, "多裝置同步怎麼用？");
        await page.locator(".msg.assistant").last().locator("a", { hasText: "看完整說明" }).first().click();
        await panel(page).locator("section.help-section.target").waitFor({ timeout: 5000 });
        check[`${tag}.helpLinkOpensPanel`] =
          (await panelName(page)) === "使用說明" && (await panel(page).locator("section.help-section.target h2").innerText()) === "多裝置同步";
        check[`${tag}.helpLinkHashCleared`] = (await page.evaluate(() => location.hash)) === "";
        await page.goBack();
        check[`${tag}.helpLinkBackCloses`] = (await closed(page)) && page.url().startsWith(E2E.URL) && (await page.locator(".messages").count()) === 1;

        if (!mobile) {
          step = "側邊的分頁";
          await settingsButton.click();
          await panel(page).waitFor();
          await page.locator("nav.tabbar").getByRole("button", { name: "紀錄", exact: true }).click();
          check[`${tag}.sideTabClosesAndSwitches`] =
            (await closed(page)) && (await page.locator("nav.tabbar").getByRole("button", { name: "紀錄", exact: true }).getAttribute("aria-current")) === "true";
          // 關閉面板時用掉的歷史紀錄：上一頁不會再打開面板
          step = "暗幕";
          await settingsButton.click();
          await panel(page).waitFor();
          await page.mouse.click(400, 600);
          check[`${tag}.backdropCloses`] = await closed(page);
        }
        check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.completed`] = false;
      }
      await context.close();
    }
  }

  // 從說明連結直接打開網址：開著說明，上一頁回到對話（不是離開網站）
  step = "直接打開說明連結";
  {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`[direct ${step}] ${e.message}`));
    try {
      await page.goto(`${E2E.URL}#help/weather`);
      await panel(page).locator("section.help-section.target").waitFor({ timeout: 10000 });
      check["direct.opensHelp"] = (await panel(page).locator("section.help-section.target h2").innerText()) === "天氣";
      await page.goBack();
      check["direct.backCloses"] = (await closed(page)) && page.url().startsWith(E2E.URL) && (await page.locator("nav.tabbar").count()) === 1;
    } catch (e) {
      console.error(`FAILED [direct] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      check["direct.completed"] = false;
    }
    await context.close();
  }

  // 減少動態效果：關閉時直接消失，不滑出
  step = "減少動態效果";
  for (const mobile of [true, false]) {
    const tag = `reduced-${mobile ? "390" : "1280"}`;
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
    try {
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      const settingsButton = page.getByRole("button", { name: "設定", exact: true });
      await settingsButton.click();
      await panel(page).waitFor();
      await page.keyboard.press("Escape");
      check[`${tag}.closesAtOnce`] = (await panel(page).count()) === 0 && (await page.locator(".panel-backdrop").count()) === 0;
      check[`${tag}.focusReturns`] = await focusIn(page, ".settings-button");
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
