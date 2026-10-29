// 驗證「沒有手錶也能用（第一批）」（規格 12.36）：
// - 新使用者在新手引導選「沒有在記錄」→ 沒有 Intervals.icu 的步驟、改成「記第一筆」；只設 AI 就能用
// - 「回報」是手動記一趟（日期、距離、時間、體感；沒有 Intervals.icu 的警告）→ 存了有分析、卡片沒有心率
// - 請教練排課表：教練看到「記錄方式」「心率：量不到」；課表的目標是體感＋說話測試（填了 5 km 的個人最佳後是配速），沒有心率
// - 照課表記一筆今天的輕鬆跑 → 比對成「達成」
// - 紀錄頁：「手動」的標記、「新增一筆」、「修改這一筆」、刪除；設定的「訓練紀錄」是「手動記」、Intervals.icu 是選用
// - 手機淺色與電腦深色的截圖（no-watch-*），不左右捲動
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

const localDate = (offsetDays = 0) => new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    const tag = mobile ? "mobile" : "desktop";
    const size = mobile ? "390-light" : "1280-dark";
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    const shot = (name) => page.screenshot({ path: `${E2E.OUT}/no-watch-${name}-${size}.png`, fullPage: true });
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    const c = (name, value) => (check[`${tag}.${name}`] = value);
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    const send = async (text) => {
      await E2E.go(page, "對話");
      await page.getByLabel("訊息").fill(text);
      await page.getByLabel("訊息").press("Enter");
      await page.waitForFunction(
        (sent) => {
          const msgs = [...document.querySelectorAll(".msg")];
          const user = [...document.querySelectorAll(".msg.user .bubble.user")].at(-1);
          return !document.querySelector(".bubble.assistant.muted, .bubble.assistant.streaming") && msgs.at(-1)?.classList.contains("assistant") && user?.textContent.includes(sent);
        },
        text,
        { timeout: 20000 },
      );
    };
    /** 手動記一趟（在目前的頁面上的表單） */
    const fillRun = async (form, { date, km, minutes, effort, notes }) => {
      if (date) await form.getByLabel("日期").fill(date);
      await form.getByLabel("距離（km）").fill(String(km));
      await form.getByLabel("分鐘").fill(String(minutes));
      await form.getByRole("button", { name: `體感 ${effort}`, exact: true }).click();
      if (notes) await form.getByLabel("一句話的感受").fill(notes);
      await form.getByRole("button", { name: "存起來" }).click();
    };
    try {
      step = "新手引導：選「沒有在記錄」";
      await page.goto(E2E.URL);
      const card = page.locator(".getting-started");
      await card.waitFor();
      c("firstStepAsks", await card.getByText("你用什麼記錄跑步？").isVisible());
      c("threeChoices", (await card.locator('input[name="record-with"]').count()) === 3);
      await shot("1-onboarding");
      await card.getByText("沒有在記錄").click();
      await card.getByText("記第一筆").first().waitFor();
      const titles = await card.locator(".step-head strong").allInnerTexts();
      c("noIntervalsStep", !titles.includes("連接 Intervals.icu") && !titles.some((t) => t.startsWith("抓進")) && titles.includes("記第一筆"));
      c("recordStepDone", (await card.locator(".step.done").count()) === 1);
      await shot("2-onboarding-manual");

      step = "只設 AI";
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false, timeZone: "Asia/Taipei" });
      await E2E.settings(page, "訓練紀錄");
      const panel = page.locator("#side-panel");
      c("settingsOptional", await panel.getByText("Intervals.icu（選用）").isVisible());
      await panel.locator(".back-button").click();
      c("settingsStatusManual", await panel.locator(".settings-list").getByText("手動記", { exact: true }).isVisible());
      await E2E.go(page, "對話");
      await card.waitFor();
      await card.getByRole("button", { name: "記第一筆" }).click();

      step = "記第一筆（回報）";
      const report = page.locator(".card.report");
      await report.getByText("記一趟跑步").waitFor();
      c("noIntervalsWarning", (await page.getByText("還沒連接 Intervals.icu").count()) === 0);
      c("dateDefaultsToday", (await report.getByLabel("日期").inputValue()) === localDate());
      await shot("3-report-form");
      // 沒點體感不能存
      await report.getByLabel("距離（km）").fill("5");
      await report.getByLabel("分鐘").fill("35");
      await report.getByRole("button", { name: "存起來" }).click();
      c("effortRequired", await report.getByText("點一下體感（1–10）").isVisible());
      await fillRun(report, { date: localDate(-1), km: 5, minutes: 35, effort: 4, notes: "第一次記" });
      const result = page.locator(".report-result .run-card");
      await result.waitFor({ timeout: 20000 });
      await result.locator(".run-summary").waitFor({ timeout: 20000 });
      c("firstSaved", (await result.innerText()).includes("沒有心率資料"));
      c("firstPace", (await result.innerText()).includes("7:00"));
      c("formCleared", (await report.getByLabel("距離（km）").inputValue()) === "");
      await shot("4-report-saved");

      step = "引導完成";
      await E2E.go(page, "對話");
      await page.waitForTimeout(300);
      c("onboardingGone", (await page.locator(".getting-started").count()) === 0);

      step = "請教練排課表";
      await send("幫我排這週的課表");
      const requests = (await (await fetch(`${E2E.MOCK}/_mock/requests`)).json()).filter((r) => r.kind === "llm");
      const system = JSON.stringify(requests.at(-1)?.body ?? requests.at(-1) ?? "");
      c("promptRecordWith", system.includes("記錄方式：沒有在記錄"));
      c("promptNoHr", system.includes("心率：量不到"));
      await E2E.go(page, "計畫");
      const today = page.locator(".plan-session", { has: page.locator(".plan-session-name", { hasText: "輕鬆跑" }) }).first();
      await today.waitFor();
      const planText = await page.locator("main").innerText();
      c("planTalkTest", planText.includes("體感 2–4/10"));
      c("planNoHr", !/心率/.test(planText));
      await shot("5-plan-rpe");

      step = "填 5 km 的個人最佳：目標變成配速＋說話測試";
      await E2E.profile(page, "個人最佳");
      await E2E.profileSave(page, async () => {
        await page.getByLabel("5km").fill("28:00");
        await page.getByLabel("5km").press("Enter");
      });
      await E2E.go(page, "計畫");
      await today.waitFor();
      // 打開今天的課的細節
      const details = today.getByRole("button", { name: /細節/ }).first();
      if (await details.count()) await details.click();
      const withPace = await page.locator("main").innerText();
      c("planPace", /\d:\d\d–\d:\d\d\/km/.test(withPace));
      c("planPaceTalkTest", withPace.includes("能說完整的句子"));
      c("planPaceNoHr", !/心率/.test(withPace));
      await shot("6-plan-pace");

      step = "照課表記今天的輕鬆跑 → 達成";
      await E2E.go(page, "回報");
      await fillRun(page.locator(".card.report"), { km: 4.5, minutes: 32, effort: 3, notes: "照課表，輕鬆" });
      await result.waitFor({ timeout: 20000 });
      await page.locator(".report-result .badge.achieved").waitFor({ timeout: 20000 });
      c("matchedAchieved", (await page.locator(".report-result .badge.achieved").innerText()).includes("達成"));
      await shot("7-report-achieved");

      step = "紀錄頁：手動、新增、修改、刪除";
      await E2E.go(page, "紀錄");
      const rows = page.locator("ul.runs > li");
      await rows.first().waitFor();
      c("twoRuns", (await rows.count()) === 2);
      c("manualBadge", (await page.locator("ul.runs .badge", { hasText: "手動" }).count()) === 2);
      await page.getByRole("button", { name: "新增一筆" }).click();
      const add = page.locator(".manual-add");
      await fillRun(add, { date: localDate(-3), km: 3, minutes: 20, effort: 5 });
      await page.waitForFunction(() => document.querySelectorAll("ul.runs > li").length === 3, null, { timeout: 20000 });
      c("addedFromHistory", true);
      await shot("8-history");
      // 最舊的那筆（剛加的）：修改距離，再刪除
      const oldest = rows.last();
      if (!(await oldest.getAttribute("class"))?.includes("open")) await oldest.locator(".run-row").click();
      await oldest.getByRole("button", { name: "修改這一筆" }).click();
      await oldest.getByLabel("距離（km）").fill("3.5");
      await oldest.getByRole("button", { name: "儲存並重新分析" }).click();
      await page.waitForFunction(() => document.querySelector("ul.runs > li:last-child")?.textContent.includes("3.5"), null, { timeout: 20000 });
      c("edited", true);
      await oldest.getByRole("button", { name: "修改這一筆" }).click();
      await oldest.getByRole("button", { name: "刪除這一筆" }).click();
      await oldest.getByRole("button", { name: "確定刪除" }).click();
      await page.waitForFunction(() => document.querySelectorAll("ul.runs > li").length === 2, null, { timeout: 20000 });
      c("deleted", true);

      step = "選手的數字：沒有心率、有輕鬆的配速";
      await E2E.profile(page);
      const numbers = await page.locator(".my-numbers").innerText();
      c("myNumbersEasyPace", numbers.includes("輕鬆 /km") && !numbers.includes("輕鬆跑上限"));
      c("noOverflow", await noOverflow());
    } catch (e) {
      problems.push(`[${tag} ${step}] ${e.message.split("\n")[0]}`);
      await shot("error").catch(() => undefined);
    }
    await context.close();
  }
  await browser.close();
  check.noProblems = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  console.log(Object.values(check).every(Boolean) ? "ALL OK" : "SOME CHECKS FAILED");
})();
