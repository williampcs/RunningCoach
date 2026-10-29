// 驗證使用須知（規格 12.32）：
// - /terms 關掉 JavaScript 也看得到全部 16 節、樣式套用、沒有腳本與外部請求、不左右捲動；和隱私說明頁互相連結
// - 對話輸入框下方一直有精簡版（設定好之前與之後），「使用須知」在 App 的面板打開（KI-046，不開新分頁）；手機上不截斷、不左右捲動
// - 面板裡的使用須知：16 節、沒有「回到 Zone2Mate」、點「隱私說明」換到隱私說明、返回回到使用須知；加到主畫面（standalone）時一樣
// - 第一次用：設定的「AI 教練」只勾資料流向還不能對話，兩個都勾才行；記下確認的版本與日期
// - 用過的人（確認過資料流向、沒確認過使用須知）打開時先確認一次，勾了才能按「繼續」，確認前底下不能操作；
//   版本變了再確認一次；確認後重新整理不再出現
// - 連結：新手引導、設定最下面、使用說明的開頭與「使用須知」一節
// staging 的標示由 verify-environments.cjs 檢查。
const E2E = require("./env.cjs");
const { chromium } = E2E;

const TERMS = new URL("terms", E2E.URL).href;
const PRIVACY = new URL("privacy", E2E.URL).href;
const SHORT = "教練是 AI，建議僅供參考，不能取代醫師或專業教練；身體不適請停止訓練並就醫。";
const SETTINGS_KEY = "running-coach.settings.v1";
let step = "start";

const viewports = {
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  1280: { viewport: { width: 1280, height: 900 } },
};

/** 點連結，確認在 App 的面板打開使用須知、沒有新分頁（KI-046） */
const opensTerms = (context, link) => E2E.opensLegalPanel(link.page(), link, "使用須知");

const storedTerms = (page) => page.evaluate((key) => JSON.parse(localStorage.getItem(key) || "{}").terms ?? null, SETTINGS_KEY);

/** 輸入框下方的精簡版：看得到、文字完整、在輸入框下面、沒有被截斷 */
async function shortLine(page) {
  const line = page.locator(".chat-page .terms-short");
  if (!(await line.isVisible())) return { visible: false };
  const box = await line.boundingBox();
  const above = await page.locator(".chat-page .composer, .chat-page .notice.inline").last().boundingBox();
  const info = await line.evaluate((el) => {
    const style = getComputedStyle(el);
    return { text: el.textContent, clipped: el.scrollWidth > el.clientWidth + 1 || style.textOverflow === "ellipsis", fontSize: style.fontSize };
  });
  return { visible: true, below: box.y >= above.y + above.height - 1, ...info, link: line.getByRole("link", { name: "使用須知" }) };
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};

  // 1. 不用 JavaScript 的靜態頁
  for (const [width, options] of Object.entries(viewports)) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${width}.${scheme}`;
      step = `static ${tag}`;
      const context = await browser.newContext({ ...options, javaScriptEnabled: false, colorScheme: scheme });
      const page = await context.newPage();
      const requests = [];
      page.on("request", (r) => requests.push(r.url()));
      page.on("console", (m) => m.type() === "error" && problems.push(`[${tag}] ${m.text()}`));
      try {
        const res = await page.goto(TERMS);
        check[`${tag}.status200`] = res.status() === 200;
        check[`${tag}.heading`] = await page.getByRole("heading", { name: "使用須知", level: 1 }).isVisible();
        const numbered = (await page.locator("section h2").allInnerTexts()).filter((h) => /^\d+\. /.test(h));
        check[`${tag}.sixteenSections`] = numbered.length === 16;
        check[`${tag}.short`] = (await page.locator("section.summary").innerText()).includes(SHORT);
        check[`${tag}.emergency`] = (await page.locator("section.urgent").innerText()).includes("緊急狀況請撥 119");
        check[`${tag}.updated`] = /最後更新：\d{4}-\d{2}-\d{2}（第 \d+ 版）/.test(await page.locator("footer").innerText());
        check[`${tag}.linksPrivacy`] = (await page.locator('a[href="/privacy"]').count()) > 0;
        check[`${tag}.noScripts`] = (await page.locator("script").count()) === 0;
        check[`${tag}.noInlineStyle`] = (await page.locator("style, [style]").count()) === 0;
        check[`${tag}.sameOriginOnly`] = requests.every((u) => u.startsWith(new URL(E2E.URL).origin));
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        check[`${tag}.styled`] = bg === (scheme === "dark" ? "rgb(11, 18, 32)" : "rgb(248, 250, 252)");
        check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        await page.screenshot({ path: `${E2E.OUT}/terms-${width}-${scheme}.png` });
        await page.screenshot({ path: `${E2E.OUT}/terms-${width}-${scheme}-full.png`, fullPage: true });
        if (width === "390" && scheme === "light") {
          await page.goto(PRIVACY);
          check.privacyLinksTerms = (await page.locator('a[href="/terms"]').count()) > 0;
        }
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.completed`] = false;
      }
      await context.close();
    }
  }

  // 2. App 裡
  for (const mobile of [true, false]) {
    const tag = mobile ? "mobile" : "desktop";
    const context = await browser.newContext({ ...(mobile ? viewports[390] : viewports[1280]), colorScheme: mobile ? "light" : "dark" });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
    try {
      step = "第一次打開";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      check[`${tag}.noGateForNewUser`] = (await page.locator(".terms-gate").count()) === 0;
      let line = await shortLine(page);
      check[`${tag}.shortBeforeSetup`] = line.visible && line.text.includes(SHORT) && line.below && !line.clipped && line.fontSize === "13px";
      check[`${tag}.shortLinkBeforeSetup`] = line.visible && (await opensTerms(context, line.link));
      check[`${tag}.link.gettingStarted`] = await opensTerms(context, page.locator(".getting-started").getByRole("link", { name: "使用須知" }));
      check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

      step = "面板裡的使用須知";
      const head = page.locator("#side-panel .side-panel-head h2");
      await line.link.click();
      await head.filter({ hasText: /^使用須知$/ }).waitFor();
      const legal = page.locator("#side-panel .legal-page");
      const numbered = (await legal.locator("section h2").allInnerTexts()).filter((h) => /^\d+\. /.test(h));
      check[`${tag}.panel.sixteenSections`] = numbered.length === 16;
      check[`${tag}.panel.short`] = (await legal.locator("section.summary").innerText()).includes(SHORT);
      check[`${tag}.panel.emergency`] = (await legal.locator("section.urgent").innerText()).includes("緊急狀況請撥 119");
      check[`${tag}.panel.updated`] = /最後更新：\d{4}-\d{2}-\d{2}（第 \d+ 版）/.test(await legal.locator("footer").innerText());
      check[`${tag}.panel.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      // 外部的網站在新分頁打開，不離開 App
      check[`${tag}.panel.mailNewTab`] = (await legal.locator('a[href^="mailto:"]').first().getAttribute("target")) === "_blank";
      await page.waitForTimeout(400); // 滑入的動畫
      await page.screenshot({ path: `${E2E.OUT}/terms-panel-${tag}.png` });
      await legal.getByRole("link", { name: "隱私說明" }).first().click();
      check[`${tag}.panel.toPrivacy`] = await head.filter({ hasText: /^隱私說明$/ }).waitFor({ timeout: 5000 }).then(() => true, () => false);
      check[`${tag}.panel.privacyContent`] = (await page.locator("#side-panel .legal-page").innerText()).includes("資料存在哪裡");
      check[`${tag}.panel.onePage`] = context.pages().length === 1;
      // 兩頁之間切換是取代，不疊上去：返回一次就回到打開它的地方（對話）
      await page.goBack();
      check[`${tag}.panel.closedByBack`] = await page.locator("#side-panel").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
      // 使用須知 → 隱私說明 → 使用須知 → 隱私說明：✕ 一次、返回一次、Esc 一次都回到對話
      const shortLink = page.locator(".chat-page .terms-short").getByRole("link", { name: "使用須知" });
      for (const how of ["close", "back", "escape"]) {
        const hopped = await E2E.hopLegal(page, shortLink, "使用須知");
        if (how === "close") await page.locator("#side-panel .side-panel-close").click();
        else if (how === "back") await page.goBack();
        else await page.keyboard.press("Escape");
        const closed = await page.locator("#side-panel").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
        check[`${tag}.panel.hop.${how}Once`] = hopped && closed && (await page.locator(".chat-page").isVisible());
      }

      step = "只勾資料流向";
      const panel = page.locator("#side-panel");
      await E2E.settings(page, "AI 教練");
      await panel.getByLabel("供應商").selectOption("openai-compatible");
      await panel.getByLabel("API key", { exact: true }).fill("mock-key");
      await panel.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
      await panel.getByLabel("主對話模型").fill("mock-model");
      await panel.getByLabel("我了解並同意以上的資料流向").check();
      check[`${tag}.settingsShort`] = (await panel.locator(".terms-line").innerText()).includes(SHORT);
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/terms-settings-mobile.png` });
      await panel.getByRole("button", { name: "儲存設定" }).click();
      await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
      await E2E.go(page, "對話");
      check[`${tag}.blockedWithoutTerms`] = await page.getByText("尚未確認使用須知，目前無法對話。").isVisible();
      check[`${tag}.noComposerWithoutTerms`] = (await page.getByLabel("訊息").count()) === 0;
      // 這時候已經確認過資料流向：重新整理會變成「用過的人」，所以這裡不重新整理

      step = "兩個都勾";
      await E2E.settings(page, "AI 教練");
      await panel.getByLabel("我已閱讀使用須知").check();
      await page.locator(".toast").waitFor({ state: "detached", timeout: 6000 });
      await panel.getByRole("button", { name: "儲存設定" }).click();
      await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
      const terms = await storedTerms(page);
      check[`${tag}.storedVersionAndDate`] = terms?.version === 1 && /^\d{4}-\d{2}-\d{2}$/.test(terms?.date ?? "");
      await E2E.go(page, "對話");
      await page.getByLabel("訊息").fill("你好");
      await page.getByLabel("訊息").press("Enter");
      check[`${tag}.chatWorks`] = await page.locator(".msg.assistant").last().waitFor({ timeout: 20000 }).then(() => true, () => false);
      line = await shortLine(page);
      check[`${tag}.shortAfterSetup`] = line.visible && line.below && !line.clipped;
      check[`${tag}.shortLinkAfterSetup`] = line.visible && (await opensTerms(context, line.link));
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/terms-chat-mobile.png` });
      else await page.screenshot({ path: `${E2E.OUT}/terms-chat-desktop-dark.png` });
      check[`${tag}.chatNoOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

      step = "重新整理不再問";
      await page.reload();
      await page.locator("nav.tabbar button").first().waitFor();
      check[`${tag}.noGateAfterAccept`] = (await page.locator(".terms-gate").count()) === 0;

      step = "用過的人";
      await page.evaluate((key) => {
        const s = JSON.parse(localStorage.getItem(key));
        delete s.terms;
        localStorage.setItem(key, JSON.stringify(s));
      }, SETTINGS_KEY);
      await page.reload();
      const gate = page.locator(".terms-gate");
      check[`${tag}.gateForExistingUser`] = await gate.waitFor({ timeout: 5000 }).then(() => true, () => false);
      check[`${tag}.gateTitleFirst`] = (await gate.locator("h2").innerText()) === "請先看過使用須知";
      check[`${tag}.gateShort`] = (await gate.innerText()).includes(SHORT);
      const cont = gate.getByRole("button", { name: "繼續" });
      check[`${tag}.gateDisabledUntilChecked`] = await cont.isDisabled();
      check[`${tag}.shellInert`] = await page.evaluate(() => document.querySelector(".shell")?.inert === true);
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/terms-gate-mobile.png` });
      else await page.screenshot({ path: `${E2E.OUT}/terms-gate-desktop-dark.png` });
      check[`${tag}.gateLink`] = await opensTerms(context, gate.getByRole("link", { name: "使用須知" }));
      await gate.getByLabel("我已閱讀使用須知").check();
      await cont.click();
      check[`${tag}.gateClosed`] = await gate.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
      check[`${tag}.gateStored`] = (await storedTerms(page))?.version === 1;
      check[`${tag}.canChatAfterGate`] = await page.getByLabel("訊息").isVisible();

      step = "版本變了";
      await page.evaluate((key) => {
        const s = JSON.parse(localStorage.getItem(key));
        s.terms = { version: 0, date: "2026-01-01" };
        localStorage.setItem(key, JSON.stringify(s));
      }, SETTINGS_KEY);
      await page.reload();
      check[`${tag}.gateOnNewVersion`] = await gate.waitFor({ timeout: 5000 }).then(() => true, () => false);
      check[`${tag}.gateTitleUpdated`] = (await gate.locator("h2").innerText()) === "使用須知更新了";
      await gate.getByLabel("我已閱讀使用須知").check();
      await gate.getByRole("button", { name: "繼續" }).click();
      await gate.waitFor({ state: "detached", timeout: 5000 });
      check[`${tag}.newVersionStored`] = (await storedTerms(page))?.version === 1;

      step = "連結";
      await E2E.go(page, "設定");
      check[`${tag}.link.settingsFooter`] = await opensTerms(context, panel.locator("p.center").getByRole("link", { name: "使用須知" }));
      await E2E.go(page, "使用說明");
      check[`${tag}.link.helpTop`] = await opensTerms(context, panel.locator(".card").first().getByRole("link", { name: "使用須知" }));
      check[`${tag}.link.helpSection`] = await opensTerms(context, page.locator("#help-terms").getByRole("link", { name: "使用須知" }));
      // 從使用說明點進來，✕ 回到使用說明（捲動的位置還在）
      check[`${tag}.link.backToHelp`] = await page.locator("#help-terms").isVisible();
      // 從使用說明打開、在兩頁之間切換四次：✕ 一次、返回一次都回到使用說明
      for (const how of ["close", "back"]) {
        const hopped = await E2E.hopLegal(page, page.locator("#help-terms").getByRole("link", { name: "使用須知" }), "使用須知");
        if (how === "close") await page.locator("#side-panel .side-panel-close").click();
        else await page.goBack();
        const backHead = await page.locator("#side-panel .side-panel-head h2", { hasText: /^使用說明$/ }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        check[`${tag}.link.hopFromHelp.${how}Once`] = hopped && backHead && (await page.locator("#help-terms").isVisible());
      }

      step = "加到主畫面";
      check[`${tag}.standalone`] = await E2E.emulateStandalone(page);
      await E2E.go(page, "對話");
      check[`${tag}.standalone.shortLink`] = await opensTerms(context, page.locator(".chat-page .terms-short").getByRole("link", { name: "使用須知" }));
      check[`${tag}.standalone.onePage`] = context.pages().length === 1;
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
