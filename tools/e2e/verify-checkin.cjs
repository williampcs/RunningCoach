// 驗證每日的身體狀況在「回報」分頁（9.4 的工作單，2026-11-12）：
// - 沒跑步的日子（沒有連 Intervals.icu）「回報」最上面也有身體狀況的表單，下面是「記一趟跑步」
// - 看板只留提醒：「今天身體如何？」不能略過、按「去回報」切到「回報」並捲到身體狀況
// - 跑後回報從看板的「去回報」（那一趟）進來時捲到「哪一趟？」並選好那一趟，上面的身體狀況不擋住
// - 存了之後收成一行「今天的身體狀況」與「修改」（帶出原本的值、取消）；看板的提醒消失、沒有「已記錄」
// - 自評過了、傷今天還沒分數：「回報」的身體狀況下面問分數，看板的「…今天幾分？」也切過去；存了之後兩邊都沒有
// - 手機淺色與電腦深色的截圖（checkin-*），不左右捲動
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    const tag = mobile ? "mobile" : "desktop";
    const size = mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 };
    const shot = (name, fullPage = false) => page.screenshot({ path: `${E2E.OUT}/checkin-${name}-${mobile ? "390-light" : "1280-dark"}.png`, fullPage });
    const context = await browser.newContext({
      ...(mobile ? { viewport: size, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: size }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const c = (name, value) => (check[`${tag}.${name}`] = value);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const feedItem = (kind) => page.locator(`.feed-item[data-kind="${kind}"]`);
    const expandFeed = async () => {
      await E2E.go(page, "對話");
      await page.locator(".feed").first().waitFor();
      const summary = page.locator(".feed.collapsed .feed-summary");
      if (await summary.count()) await summary.click();
      await page.locator(".feed:not(.collapsed)").waitFor();
    };
    // 元素的上緣在畫面內（沒有被標題列蓋住、不在畫面下方）
    const inView = (locator) =>
      locator.evaluate((el) => {
        const top = el.getBoundingClientRect().top;
        const header = document.querySelector("header.topbar");
        const headerBottom = header ? header.getBoundingClientRect().bottom : 0;
        return top >= headerBottom - 4 && top < window.innerHeight / 2;
      });
    const currentTab = () => page.locator('nav.tabbar button[aria-current="true"]').innerText();
    try {
      step = "設定（沒有連 Intervals.icu）";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor({ timeout: 15000 });
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });

      step = "沒跑步的日子也有身體狀況";
      await E2E.go(page, "回報");
      const section = page.locator("#checkin");
      await section.locator(".checkin").waitFor({ timeout: 5000 });
      c("noRunDayForm", (await section.locator("h2").innerText()) === "今天身體如何？");
      c("noRunDayManualBelow", await page.getByRole("heading", { name: "記一趟跑步" }).isVisible());
      c("checkinAboveRun", await page.evaluate(() => {
        const a = document.querySelector("#checkin");
        const b = [...document.querySelectorAll("h2")].find((h) => h.textContent === "記一趟跑步");
        return !!a && !!b && a.getBoundingClientRect().top < b.getBoundingClientRect().top;
      }));
      await shot("no-run-day", true);
      c("noRunDayNoOverflow", await noOverflow());

      step = "連 Intervals.icu、同步";
      await E2E.settings(page, "訓練紀錄");
      await page.locator("#side-panel").getByLabel("API key", { exact: true }).fill("mock-intervals-key");
      await page.locator("#side-panel").getByRole("button", { name: "儲存設定" }).click();
      await page.getByText("設定已儲存在這個瀏覽器。").last().waitFor();
      await E2E.go(page, "回報");
      await page.getByRole("button", { name: /同步/ }).last().click();
      await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

      step = "看板：跑後回報捲到那一趟";
      await expandFeed();
      const runReminder = feedItem("report").first();
      c("runReminder", await runReminder.isVisible());
      await runReminder.getByRole("button", { name: "去回報" }).click();
      await page.locator("#report-run fieldset.choices .choice.selected").waitFor({ timeout: 10000 });
      c("runTabIsReport", (await currentTab()).includes("回報"));
      await page.waitForTimeout(500);
      c("runScrolledIntoView", await inView(page.locator("#report-run")));
      c("checkinStillAbove", (await page.locator("#checkin .checkin").count()) === 1);
      await shot("from-run-reminder");

      step = "看板：今天身體如何？";
      await page.evaluate(() => window.scrollTo(0, 0));
      await expandFeed();
      const reminder = feedItem("checkin");
      c("reminderTitle", (await reminder.locator(".feed-title").innerText()) === "今天身體如何？");
      c("reminderNotDismissible", (await reminder.locator(".feed-dismiss").count()) === 0);
      c("reminderPrimary", (await reminder.locator("button.primary", { hasText: "去回報" }).count()) === 1);
      c("noFormInFeed", (await page.locator(".feed .checkin").count()) === 0);
      await shot("feed-reminder");
      await reminder.getByRole("button", { name: "去回報" }).click();
      await section.locator(".checkin").waitFor({ timeout: 5000 });
      c("checkinTabIsReport", (await currentTab()).includes("回報"));
      await page.waitForTimeout(300);
      c("checkinScrolledIntoView", await inView(section));

      step = "存身體狀況";
      await section.getByLabel("精神").fill("4");
      await section.getByLabel("痠痛").fill("1");
      await section.getByLabel("備註").fill("睡得不錯");
      await section.getByRole("button", { name: "儲存" }).click();
      await section.locator(".checkin-summary").waitFor({ timeout: 5000 });
      c("summaryLine", (await section.locator(".checkin-summary").innerText()).includes("精神 4/5 · 痠痛 1/5 · 睡眠 3/5"));
      c("summaryNotes", (await section.innerText()).includes("睡得不錯"));
      c("summaryTitle", (await section.locator("h2").innerText()) === "今天的身體狀況");
      await shot("saved");
      await expandFeed().catch(() => undefined);
      c("feedReminderGone", (await feedItem("checkin").count()) === 0 && (await page.getByText("今天的身體狀況已記錄").count()) === 0);

      step = "修改：帶出原本的值、取消";
      await E2E.go(page, "回報");
      await section.getByRole("button", { name: "修改" }).click();
      c("editPrefilled", (await section.getByLabel("精神").inputValue()) === "4" && (await section.getByLabel("備註").inputValue()) === "睡得不錯");
      await section.getByRole("button", { name: "取消" }).click();
      c("cancelBackToSummary", await section.locator(".checkin-summary").isVisible());

      step = "傷的分數";
      await E2E.profile(page, "身體");
      await page.getByRole("button", { name: "新增傷病" }).click();
      await page.locator(".card.injuries").getByLabel("部位").fill("足底");
      await page.locator(".card.injuries").getByLabel("哪一側").selectOption("right");
      await page.locator(".card.injuries").getByRole("button", { name: "新增", exact: true }).click();
      await page.locator(".card.injuries .injury", { hasText: "右足底" }).waitFor({ timeout: 5000 });
      await expandFeed();
      const injuryReminder = feedItem("injury");
      c("injuryReminder", (await injuryReminder.locator(".feed-title").innerText()) === "右足底今天幾分？");
      await injuryReminder.getByRole("button", { name: "去回報" }).click();
      const painForm = page.locator("#pain-scores");
      await painForm.waitFor({ timeout: 5000 });
      c("painTabIsReport", (await currentTab()).includes("回報"));
      c("painQuestion", (await painForm.innerText()).includes("右足底今天幾分？"));
      c("painSaveDisabledUntilAnswered", await painForm.getByRole("button", { name: "儲存分數" }).isDisabled());
      await painForm.getByRole("button", { name: "右足底的疼痛 3", exact: true }).click();
      await shot("pain");
      c("painNoOverflow", await noOverflow());
      await painForm.getByRole("button", { name: "儲存分數" }).click();
      await painForm.waitFor({ state: "detached", timeout: 5000 });
      await expandFeed().catch(() => undefined);
      c("injuryReminderGone", (await feedItem("injury").count()) === 0);
      await E2E.profile(page, "身體");
      const injury = page.locator(".card.injuries .injury", { hasText: "右足底" }).first();
      await injury.locator("summary").click();
      c("painScoreSaved", (await injury.innerText()).includes("每日自評 3"));
      await E2E.go(page, "回報");
      await shot("report-all", true);
      c("reportNoOverflow", await noOverflow());
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
