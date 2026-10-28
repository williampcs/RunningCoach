// 驗證傷病的安全機制（規格 12.33）：
// - 選手說膝蓋痛 → 教練先問固定的問題 → 回答後記進傷病紀錄（選手 → 身體看得到）
// - 已經排好的課：會痛的運動的強度課與長課標「先不要做」；再請教練排課時，強度課存不了（寫理由也不行）
// - 每日自評多一題「左膝蓋今天幾分？」，存了分數
// - 就醫提示：對話說胸痛時畫面上方與看板各一則（重新整理還在），按「我知道了」才收起；否定的說法不出現；自評的備註也會
// - 選手 → 身體：改分數、標成好了之後課表不再標「先不要做」、刪除
// - 手機淺色與電腦深色的截圖（injury-*），不左右捲動
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    const tag = mobile ? "mobile" : "desktop";
    const shot = (name) => page.screenshot({ path: `${E2E.OUT}/injury-${name}-${mobile ? "390-light" : "1280-dark"}.png`, fullPage: false });
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const c = (name, value) => (check[`${tag}.${name}`] = value);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const lastReply = () => page.locator(".msg.assistant").last().innerText();
    const send = async (text) => {
      await E2E.go(page, "對話");
      await page.getByLabel("訊息").fill(text);
      await page.getByLabel("訊息").press("Enter");
      // 等這則之後的回覆寫完：最後一則是教練的、前一則是剛送出的這則，沒有還在寫的
      await page.waitForFunction(
        (sent) => {
          const msgs = [...document.querySelectorAll(".msg")];
          const last = msgs.at(-1);
          const user = [...document.querySelectorAll(".msg.user .bubble.user")].at(-1);
          return !document.querySelector(".bubble.assistant.muted, .bubble.assistant.streaming") && last?.classList.contains("assistant") && user?.textContent.includes(sent);
        },
        text,
        { timeout: 20000 },
      );
      // 回覆的小標以下是收起的（12.30）：全部展開再讀
      for (const summary of await page.locator(".msg.assistant").last().locator("details:not([open]) > summary").all()) await summary.click();
    };
    const planSession = (title) => page.locator(".plan-session", { has: page.locator(".plan-session-name", { hasText: title }) }).first();
    const banner = page.locator(".notice.red-flag");
    const feedMedical = page.locator('.feed-item[data-kind="medical"]');
    const expandFeed = async () => {
      await page.locator(".feed").first().waitFor();
      const summary = page.locator(".feed.collapsed .feed-summary");
      if (await summary.count()) await summary.click();
      await page.locator(".feed:not(.collapsed)").waitFor();
    };
    try {
      step = "設定";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK, timeZone: "Asia/Taipei" });

      step = "先排好下週";
      await send("幫我排下週的課表");
      await E2E.go(page, "計畫");
      await page.locator(".plan-session-name", { hasText: "4×1 km 閾值" }).first().waitFor({ timeout: 10000 });
      c("planSavedBefore", (await page.getByText("先不要做").count()) === 0);

      step = "膝蓋痛：先問問題";
      await send("我的膝蓋有點痛");
      const questions = await lastReply();
      c("askedQuestions", ["哪一側", "什麼時候開始", "哪些運動會痛", "隔天早上", "按壓骨頭", "越來越痛", "夜裡"].every((q) => questions.includes(q)));

      step = "回答後記下";
      await send("左膝，前天開始，跑步會痛，跑步中 5 分，隔天早上 2 分，沒有腫");
      c("recorded", (await lastReply()).includes("已記下傷病"));
      c("recordedListsPlan", (await lastReply()).includes("4×1 km 閾值"));

      step = "選手 → 身體";
      await E2E.profile(page);
      c("profileSummary", await page.locator(".profile-list", { hasText: "左膝蓋進行中" }).waitFor({ timeout: 5000 }).then(() => true, () => false));
      await E2E.profile(page, "身體");
      const card = page.locator(".card.injuries");
      await card.waitFor();
      const item = card.locator(".injury").first();
      c("injuryShown", (await item.innerText()).includes("左膝蓋") && (await item.innerText()).includes("最近 5/10"));
      await item.locator("summary").click();
      c("injuryFields", (await item.getByLabel("狀態").inputValue()) === "active" && (await item.getByRole("checkbox", { name: "跑步" }).isChecked()));
      await shot("profile");
      c("profileNoOverflow", await noOverflow());

      step = "課表：先不要做";
      await E2E.go(page, "計畫");
      await planSession("4×1 km 閾值").locator(".plan-session-head").click();
      const tempoCard = planSession("4×1 km 閾值");
      c("tempoHeld", (await tempoCard.innerText()).includes("先不要做"));
      c("holdNotice", await tempoCard.locator(".injury-hold").isVisible());
      c("longHeld", (await planSession("長跑").innerText()).includes("先不要做"));
      c("easyNotHeld", !(await planSession("輕鬆跑").innerText()).includes("先不要做"));
      await tempoCard.scrollIntoViewIfNeeded();
      await shot("plan");

      step = "再排課：強度課存不了";
      await send("幫我排下週的課表");
      c("refused", (await lastReply()).includes("寫理由也不能保留"));
      await E2E.go(page, "計畫");
      c("planUnchanged", (await planSession("4×1 km 閾值").innerText()).includes("先不要做"));

      step = "自評多一題";
      await E2E.go(page, "對話");
      await expandFeed();
      await page.getByRole("button", { name: "回報身體狀況" }).click();
      const question = page.locator(".checkin .pain-question", { hasText: "左膝蓋今天幾分？" });
      c("checkinQuestion", await question.waitFor({ timeout: 5000 }).then(() => true, () => false));
      await question.getByRole("button", { name: "左膝蓋的疼痛 2", exact: true }).click();
      await shot("checkin");
      await page.locator(".checkin").getByRole("button", { name: "儲存" }).click();
      await page.locator(".checkin").waitFor({ state: "detached" });
      await E2E.profile(page, "身體");
      // 同一天有好幾個分數時摘要取最高的（運動中 5），自評的 2 在展開後的「最近的分數」
      const scored = page.locator(".card.injuries .injury").first();
      await scored.locator("summary").click();
      c("checkinScoreSaved", (await scored.innerText()).includes("每日自評 2"));
      c("summaryTakesHighest", (await scored.locator("summary").innerText()).includes("最近 5/10"));

      step = "就醫提示：胸痛";
      await send("間歇跑到一半突然胸痛");
      c("bannerShown", await banner.isVisible());
      c("bannerText", (await banner.innerText()).includes("胸痛") && (await banner.innerText()).includes("119"));
      c("bannerLinksTerms", (await banner.getByRole("link", { name: "使用須知" }).getAttribute("href")) === "/terms");
      await expandFeed();
      c("feedMedical", await feedMedical.isVisible());
      c("feedMedicalNoDismissX", (await feedMedical.locator(".feed-dismiss").count()) === 0);
      await shot("red-flag");
      c("redFlagNoOverflow", await noOverflow());
      await page.reload();
      await page.locator("nav.tabbar button").first().waitFor();
      c("bannerAfterReload", await banner.isVisible());
      await banner.getByRole("button", { name: "我知道了" }).click();
      c("bannerDismissed", (await banner.count()) === 0);
      await expandFeed();
      c("feedMedicalDismissed", (await feedMedical.count()) === 0);
      await page.reload();
      await page.locator("nav.tabbar button").first().waitFor();
      c("staysDismissed", (await banner.count()) === 0);

      step = "否定的說法不提示";
      await send("今天沒有胸痛，只是腿很痠");
      c("negationNoBanner", (await banner.count()) === 0);

      step = "自評的備註";
      await expandFeed();
      await page.getByRole("button", { name: "修改自評" }).first().click();
      await page.locator(".checkin").getByLabel("備註").fill("早上起床有點心悸");
      await page.locator(".checkin").getByRole("button", { name: "儲存" }).click();
      await page.locator(".checkin").waitFor({ state: "detached" });
      await banner.waitFor({ timeout: 10000 });
      c("checkinNotesBanner", (await banner.innerText()).includes("心悸"));
      await expandFeed();
      await feedMedical.getByRole("button", { name: "我知道了" }).click();
      c("feedAckDismissesBoth", (await banner.count()) === 0 && (await feedMedical.count()) === 0);

      step = "標成好了、刪除";
      await E2E.profile(page, "身體");
      const injury = page.locator(".card.injuries .injury").first();
      await injury.locator("summary").click();
      await E2E.profileSave(page, () => injury.getByLabel("狀態").selectOption("resolved"));
      await E2E.go(page, "計畫");
      c("holdClearedWhenResolved", (await page.getByText("先不要做").count()) === 0);
      await E2E.profile(page, "身體");
      await page.locator(".card.injuries").getByText("好了的（1）").click();
      const resolved = page.locator(".card.injuries .injury").first();
      await resolved.locator("summary").click();
      await resolved.getByRole("button", { name: "刪除" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".card.injuries .injury").length === 0, null, { timeout: 5000 });
      c("deleted", true);

      step = "自己新增";
      await page.getByRole("button", { name: "新增傷病" }).click();
      await page.locator(".card.injuries").getByLabel("部位").fill("足底");
      await page.locator(".card.injuries").getByLabel("哪一側").selectOption("right");
      await page.locator(".card.injuries").getByRole("button", { name: "新增", exact: true }).click();
      await page.locator(".card.injuries .injury", { hasText: "右足底" }).waitFor({ timeout: 5000 });
      c("addedByUser", (await page.locator(".card.injuries .injury").first().innerText()).includes("全部的運動"));
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      c("completed", false);
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
