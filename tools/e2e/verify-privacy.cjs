// 驗證隱私說明頁（規格 12.20）：
// - /privacy 關掉 JavaScript 也看得到全部內容，樣式只從本站載入，沒有任何腳本或外部的請求
// - 手機與電腦、淺色與深色的截圖；不會左右捲動
// - App 裡的連結（新手引導、設定的資料流向、Intervals.icu、多裝置同步、設定最下面、使用說明的開頭與「隱私說明」一節、
//   教練用 get_app_help 回答時的連結）都在 App 的面板打開（KI-046，不開新分頁）；從設定的某一項點進來，✕ 回到那一項
// staging 的標示由 verify-environments.cjs 檢查（它自己建置 staging）。
const fs = require("fs");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const PRIVACY = new URL("privacy", E2E.URL).href;
let step = "start";

const viewports = {
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  1280: { viewport: { width: 1280, height: 900 } },
};

/** 點連結，確認在 App 的面板打開隱私說明、沒有新分頁（KI-046） */
const opensPrivacy = (context, link) => E2E.opensLegalPanel(link.page(), link, "隱私說明");

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
        const res = await page.goto(PRIVACY);
        check[`${tag}.status200`] = res.status() === 200;
        check[`${tag}.heading`] = await page.getByRole("heading", { name: "隱私說明", level: 1 }).isVisible();
        const headings = await page.locator("h2").allInnerTexts();
        check[`${tag}.sections`] = ["重點", "存在你裝置上的資料", "會送出去的資料", "多裝置同步（開了才有）", "我們不做的事", "你可以做的事", "要知道的限制", "開源與聯絡", "異動紀錄"].every((h) => headings.includes(h));
        check[`${tag}.contact`] = await page.locator('a[href="mailto:privacy@zone2mate.com"]').isVisible();
        check[`${tag}.signed`] = (await page.locator("main").innerText()).includes("Zone2Mate（個人開發的專案）");
        check[`${tag}.updated`] = /最後更新：\d{4}-\d{2}-\d{2}/.test(await page.locator("footer").innerText());
        check[`${tag}.noStaging`] = (await page.locator(".staging-banner").count()) === 0;
        check[`${tag}.noScripts`] = (await page.locator("script").count()) === 0;
        check[`${tag}.sameOriginOnly`] = requests.every((u) => u.startsWith(new URL(E2E.URL).origin));
        // 樣式有套用（CSP 只允許本站的樣式檔，頁面不能有行內樣式）
        const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
        check[`${tag}.styled`] = bg === (scheme === "dark" ? "rgb(11, 18, 32)" : "rgb(248, 250, 252)");
        check[`${tag}.noInlineStyle`] = (await page.locator("style, [style]").count()) === 0;
        check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        await page.screenshot({ path: `${E2E.OUT}/privacy-${width}-${scheme}.png` });
        await page.screenshot({ path: `${E2E.OUT}/privacy-${width}-${scheme}-full.png`, fullPage: true });
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.completed`] = false;
      }
      await context.close();
    }
  }

  // 2. 建置結果：privacy.html 套用和 App 一樣的安全標頭（_headers 的 /* 規則）
  step = "headers";
  const dist = path.join(__dirname, "../../apps/web/dist");
  if (fs.existsSync(path.join(dist, "_headers"))) {
    const headers = fs.readFileSync(path.join(dist, "_headers"), "utf8");
    check["build.headersForAll"] = /^\/\*\n(?:  .+\n)*  Content-Security-Policy: default-src 'self'/m.test(headers);
    check["build.privacyFiles"] = fs.existsSync(path.join(dist, "privacy.html")) && fs.existsSync(path.join(dist, "privacy.css"));
  }

  // 3. App 裡的連結
  for (const mobile of [false, true]) {
    const tag = mobile ? "mobile" : "desktop";
    const context = await browser.newContext(mobile ? viewports[390] : viewports[1280]);
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
    try {
      step = "新手引導";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      check[`${tag}.link.gettingStarted`] = await opensPrivacy(context, page.locator(".getting-started").getByRole("link", { name: "隱私說明" }));

      step = "使用說明";
      await E2E.go(page, "使用說明");
      check[`${tag}.link.helpTop`] = await opensPrivacy(context, page.locator("#side-panel .card").first().getByRole("link", { name: "隱私說明" }));
      check[`${tag}.link.helpSection`] = await opensPrivacy(context, page.locator("#help-privacy").getByRole("link", { name: "隱私說明" }));

      step = "設定";
      // 設定的每一項裡，說明收在 ⓘ（規格 12.28）：打開那一項的 ⓘ 再點連結
      const panel = page.locator("#side-panel");
      const viaInfo = async (section, info) => {
        await E2E.settings(page, section);
        await panel.getByRole("button", { name: info }).click();
        return opensPrivacy(context, panel.locator(".info-pop").getByRole("link", { name: "隱私說明" }));
      };
      check[`${tag}.link.dataFlow`] = await viaInfo("AI 教練", "資料會送到哪裡");
      check[`${tag}.link.intervals`] = await viaInfo("訓練紀錄", "怎麼取得 API key");
      check[`${tag}.link.deviceSync`] = await viaInfo("多裝置同步", "同步哪些資料");
      // ✕ 回到設定裡原本的那一項
      check[`${tag}.link.backToSection`] = await panel.locator('.subpage[data-section="sync"]').isVisible();
      // 從設定的某一項打開、在兩頁之間切換四次（隱私說明 → 使用須知 → 隱私說明 → 使用須知）：✕ 一次、返回一次都回到那一項
      for (const how of ["close", "back"]) {
        // 回到那一項時 ⓘ 的說明還開著（狀態留著）：沒開著才按
        if (!(await panel.locator(".info-pop").isVisible())) await panel.getByRole("button", { name: "同步哪些資料" }).click();
        const hopped = await E2E.hopLegal(page, panel.locator(".info-pop").getByRole("link", { name: "隱私說明" }), "隱私說明");
        if (how === "close") await panel.locator(".side-panel-close").click();
        else await page.goBack();
        const backHead = await panel.locator(".side-panel-head h2", { hasText: /^設定$/ }).waitFor({ timeout: 5000 }).then(() => true, () => false);
        check[`${tag}.link.hopFromSettings.${how}Once`] = hopped && backHead && (await panel.locator('.subpage[data-section="sync"]').isVisible());
      }
      await panel.locator(".back-button").click();
      check[`${tag}.link.settingsFooter`] = await opensPrivacy(context, panel.locator("p.center").getByRole("link", { name: "隱私說明" }));
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/privacy-settings-mobile.png` });

      step = "問教練";
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });
      await E2E.go(page, "對話");
      await page.getByLabel("訊息").fill("隱私說明在哪裡？");
      await page.getByLabel("訊息").press("Enter");
      const reply = page.locator(".msg.assistant", { has: page.locator(".sources", { hasText: "App 的使用說明" }) }).last();
      check[`${tag}.coachUsedHelp`] = await reply.waitFor({ timeout: 20000 }).then(() => true, () => false);
      // 模擬的回覆照抄工具的結果（開頭是「## 隱私說明」）：小標以下是收起的（12.30），先展開
      for (const summary of await reply.locator("details.reply-section:not([open]) > summary").all()) await summary.click();
      check[`${tag}.link.coachReply`] = await opensPrivacy(context, reply.getByRole("link", { name: "隱私說明" }).first());
      // 回覆裡的 #help 連結照常在 App 裡切換
      await reply.getByRole("link", { name: "看完整說明" }).first().click();
      await page.locator("section.help-section.target").waitFor({ timeout: 5000 });
      check[`${tag}.helpLinkStillInApp`] = (await page.locator("section.help-section.target h2").innerText()) === "隱私說明";
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
