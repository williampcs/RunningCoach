// 驗證選手自己快速改課（規格 12.34 第 3 點 B）：
// 手機淺色（測試模式）：
// - 模擬日期移到上週三，存過去 10 週的課表；上週的課：週三跳過、週四改用替代、週日的長跑改短（太累）
// - 回到實際日期後，「之前的週」看得到達成、部分達成（2 週前的長跑）、跳過、改用替代、自己改過
// - 這週與下週：下週的閾值「換成輕鬆」；這週的長跑改短 → 選原因 → 恢復；再改一半 → 「不舒服」→ 記下部位與分數 → 課卡標「先不要做」
// 電腦深色（一般的資料庫）：改短並選原因後開始同步，另一台用復原碼還原，看得到改過的課、原因與「自己改過」
// 截圖：self-change-*（手機淺色、電腦深色）；不左右捲動
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

const taipei = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
const TODAY = taipei(new Date());
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEEKDAY = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7;
const MONDAY = plusDays(TODAY, -WEEKDAY);
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const range = (weeksAgo) => `${md(plusDays(MONDAY, -7 * weeksAgo))} – ${md(plusDays(MONDAY, -7 * weeksAgo + 6))}`;
const LAST_WEDNESDAY = plusDays(MONDAY, -5);

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const open = async (name, mobile) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${name} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    return { page, context };
  };
  const send = async (page, text) => {
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
      { timeout: 30000 },
    );
  };
  // 時間軸上的一堂課（點開）；date 是 YYYY-MM-DD，沒給時是第一堂叫 title 的
  const card = (page, title, date) =>
    (date ? page.locator(`.tl-day[data-date="${date}"]`) : page).locator(".plan-session", { has: page.locator(".plan-session-name", { hasText: title }) }).first();
  const expand = async (c) => {
    const head = c.locator(".plan-session-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  };
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  const simulate = async (page, date) => {
    await E2E.settings(page, "測試模式");
    if (date) {
      await page.getByLabel("模擬日期").fill(date);
      await page.getByRole("button", { name: "套用" }).click();
      await page.getByText(`模擬日期改為 ${date}。`).waitFor();
    } else {
      await page.getByRole("button", { name: "回到實際日期" }).click();
      await page.getByText(/回到實際日期|模擬日期改為/).first().waitFor();
    }
    await page.getByRole("button", { name: "同步最近 14 天" }).click();
    await page.locator(".toast, .notice", { hasText: /同步完成|已是最新|新增/ }).first().waitFor({ timeout: 60000 });
  };

  // ---------------------------------------------------------------------------
  // 手機淺色：測試模式
  // ---------------------------------------------------------------------------
  {
    const { page, context } = await open("mobile", true);
    const c = (name, value) => (check[`mobile.${name}`] = value);
    try {
      step = "設定與測試模式";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false, timeZone: "Asia/Taipei" });
      await E2E.settings(page, "測試模式");
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "啟用測試模式" }).click()]);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.settings(page, "測試模式");
      await page.getByLabel("週數").fill("12");
      await page.getByLabel("每週次數").fill("3");
      await page.getByRole("button", { name: /產生/ }).click();
      await page.getByText(/已產生 \d+ 筆/).waitFor({ timeout: 20000 });

      step = "上週三：存過去的課表，調整上週的課";
      await simulate(page, LAST_WEDNESDAY);
      await send(page, "排前幾週的課表");
      await E2E.go(page, "計畫");
      const wed = card(page, "週三的輕鬆跑", LAST_WEDNESDAY);
      await expand(wed);
      await wed.getByRole("button", { name: "跳過" }).click();
      await wed.locator(".badge", { hasText: "已跳過" }).waitFor();
      const thu = card(page, "20 分鐘閾值", plusDays(LAST_WEDNESDAY, 1));
      await expand(thu);
      await thu.getByRole("button", { name: "改用替代" }).click();
      await thu.locator(".badge", { hasText: "改用替代" }).waitFor();
      const sun = card(page, "長跑", plusDays(LAST_WEDNESDAY, 4));
      await expand(sun);
      await sun.getByRole("button", { name: "改課" }).click();
      await sun.getByRole("button", { name: "短一點（約 3/4）" }).click();
      await sun.locator(".badge", { hasText: "自己改過" }).waitFor();
      await sun.getByRole("group", { name: "為什麼改" }).getByRole("button", { name: "太累" }).click();
      await page.waitForFunction(() => document.querySelector('[aria-label="為什麼改"] button[aria-pressed="true"]')?.textContent === "太累");
      c("lastWeekShortened", (await sun.locator(".self-change-note").innerText()).includes("自己改短到約 3/4"));

      step = "回到今天：之前的週";
      await simulate(page, null);
      await send(page, "幫我排課表");
      await send(page, "幫我排下週的課表");
      await E2E.go(page, "計畫");
      const past = page.locator(".past-weeks-card");
      await past.waitFor({ timeout: 10000 });
      await past.locator("details.past-weeks > summary").click();
      const rowOf = (weeksAgo) => past.locator(".past-week", { has: page.locator(".list-row-title", { hasText: range(weeksAgo) }) });
      const w1 = rowOf(1);
      const marks = await w1.locator(".past-mark").evaluateAll((els) => els.map((e) => e.getAttribute("class")));
      c("marksSkippedFallback", marks.some((m) => m.includes("skipped")) && marks.some((m) => m.includes("fallback")));
      await w1.locator(".past-week-row").click();
      const items = w1.locator(".past-sessions > li");
      await items.first().waitFor();
      const badgeOf = async (title) => items.filter({ hasText: title }).first().locator(".badge").innerText();
      c("pastSkipped", (await badgeOf("週三的輕鬆跑")) === "已跳過");
      c("pastFallback", (await badgeOf("20 分鐘閾值")) === "改用替代");
      c("pastSelfChanged", (await items.filter({ hasText: "長跑" }).first().locator(".list-row-sub").innerText()).includes("自己改短到約 3/4"));
      const w2 = rowOf(2);
      await w2.locator(".past-week-row").click();
      await w2.locator(".past-sessions > li").first().waitFor();
      c("pastPartial", (await w2.locator(".past-sessions > li").filter({ hasText: "長跑" }).first().locator(".badge").innerText()) === "部分達成");
      c("partialMark", (await w2.locator(".past-mark.partial").count()) >= 1);
      c("noOverflowPast", await noOverflow(page));
      await w1.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/self-change-past-390-light.png` });
      await past.locator("details.past-weeks > summary").click();

      step = "下週的閾值換成輕鬆";
      const nextMonday = plusDays(MONDAY, 7);
      const nextTempo = card(page, "4×1 km 閾值", plusDays(nextMonday, 3));
      await expand(nextTempo);
      await nextTempo.getByRole("button", { name: "改課" }).click();
      c("noLonger", (await nextTempo.getByRole("button", { name: /長一點|加量/ }).count()) === 0);
      await nextTempo.getByRole("button", { name: "換成輕鬆" }).click();
      const eased = card(page, "輕鬆跑", plusDays(nextMonday, 3));
      await eased.locator(".badge", { hasText: "自己改過" }).waitFor({ timeout: 5000 });
      await expand(eased);
      c("easyNote", (await eased.locator(".self-change-note").innerText()).includes("自己換成輕鬆・原本「4×1 km 閾值」"));
      c("easyNoChoiceAgain", (await eased.getByRole("button", { name: "改課" }).count()) === 1);

      step = "這週的長跑：改短、原因、恢復";
      const sunday = plusDays(MONDAY, 6);
      const longRun = card(page, "長跑", sunday);
      await expand(longRun);
      await longRun.getByRole("button", { name: "改課" }).click();
      await longRun.getByRole("button", { name: "短一點（約 3/4）" }).click();
      await longRun.locator(".badge", { hasText: "自己改過" }).waitFor();
      c("toastShown", await page.locator(".toast", { hasText: "已改短到約 3/4" }).first().isVisible().catch(() => false));
      c("chips7_5km", (await longRun.locator(".chips").innerText()).includes("7.5 km"));
      c("reasonOptional", (await longRun.getByRole("group", { name: "為什麼改" }).locator('button[aria-pressed="true"]').count()) === 0);
      await longRun.getByRole("group", { name: "為什麼改" }).getByRole("button", { name: "沒時間" }).click();
      await longRun.locator('[aria-label="為什麼改"] button[aria-pressed="true"]', { hasText: "沒時間" }).waitFor();
      c("noOverflowCard", await noOverflow(page));
      await longRun.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/self-change-card-390-light.png` });
      await longRun.getByRole("button", { name: "恢復原本的課" }).click();
      await page.waitForFunction((d) => !document.querySelector(`.tl-day[data-date="${d}"] .badge.edited`), sunday, { timeout: 5000 });
      await expand(longRun);
      c("restored", (await longRun.locator(".self-change-note").count()) === 0 && (await longRun.locator(".chips").innerText()).includes("10 km"));

      step = "一半、不舒服：接到傷病";
      await longRun.getByRole("button", { name: "改課" }).click();
      await longRun.getByRole("button", { name: "一半" }).click();
      await longRun.locator(".badge", { hasText: "自己改過" }).waitFor();
      await expand(longRun);
      c("halfChips", (await longRun.locator(".chips").innerText()).includes("5 km"));
      await longRun.getByRole("group", { name: "為什麼改" }).getByRole("button", { name: "不舒服" }).click();
      const unwell = longRun.locator(".unwell-panel");
      await unwell.waitFor();
      await unwell.getByRole("button", { name: "記下部位" }).click();
      await unwell.getByLabel("部位").fill("小腿");
      await unwell.getByRole("button", { name: "新增" }).click();
      await unwell.getByText("小腿現在幾分？").waitFor();
      await unwell.getByRole("button", { name: "小腿的疼痛 5" }).click();
      await unwell.getByText(/已記下小腿 5\/10/).waitFor();
      c("tellCoach", (await unwell.getByRole("button", { name: "跟教練說" }).count()) === 1);
      await longRun.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/self-change-unwell-390-light.png` });
      // 傷病的規則：疼痛 5 分、會痛的運動不知道（全部）→ 長跑標「先不要做」
      await longRun.locator(".badge", { hasText: "先不要做" }).waitFor({ timeout: 5000 });
      c("injuryHold", true);
      await E2E.profile(page, "身體");
      c("injuryRecorded", await page.locator(".injury", { hasText: "小腿" }).waitFor({ timeout: 5000 }).then(() => true, () => false));
    } catch (e) {
      problems.push(`[mobile ${step}] ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: `${E2E.OUT}/self-change-fail-390-light.png` }).catch(() => {});
    }
    await context.close();
  }

  // ---------------------------------------------------------------------------
  // 電腦深色：兩台裝置同步
  // ---------------------------------------------------------------------------
  {
    const A = await open("A", false);
    const B = await open("B", false);
    const c = (name, value) => (check[`desktop.${name}`] = value);
    const syncCard = (page) => page.locator('#side-panel .subpage[data-section="sync"] section.card');
    try {
      step = "A：改短並選原因";
      await A.page.goto(E2E.URL);
      await A.page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(A.page, { mock: E2E.MOCK, timeZone: "Asia/Taipei" });
      await send(A.page, "幫我排下週的課表");
      await E2E.go(A.page, "計畫");
      const nextSunday = plusDays(MONDAY, 13);
      const longRun = card(A.page, "長跑", nextSunday);
      await expand(longRun);
      await longRun.getByRole("button", { name: "改課" }).click();
      await longRun.getByRole("button", { name: "一半" }).click();
      await longRun.locator(".badge", { hasText: "自己改過" }).waitFor();
      await longRun.getByRole("group", { name: "為什麼改" }).getByRole("button", { name: "沒時間" }).click();
      await longRun.locator('[aria-label="為什麼改"] button[aria-pressed="true"]', { hasText: "沒時間" }).waitFor();
      await longRun.scrollIntoViewIfNeeded();
      await A.page.screenshot({ path: `${E2E.OUT}/self-change-card-1280-dark.png` });

      step = "A 開始同步";
      await E2E.settings(A.page, "多裝置同步");
      await syncCard(A.page).getByRole("button", { name: "這是第一台：開始同步" }).click();
      const recovery = (await syncCard(A.page).locator(".recovery-code").innerText()).trim();
      await syncCard(A.page).getByLabel("我已經把復原碼存好了").check();
      await syncCard(A.page).getByRole("button", { name: "開始同步" }).click();
      await syncCard(A.page).getByText(/上次同步 \d/).waitFor({ timeout: 15000 });

      step = "B 用復原碼還原";
      await B.page.goto(E2E.URL);
      await B.page.locator("nav.tabbar button").first().waitFor();
      await E2E.settings(B.page, "多裝置同步");
      await syncCard(B.page).getByRole("button", { name: "用復原碼還原" }).click();
      await syncCard(B.page).getByLabel("復原碼").fill(recovery);
      await syncCard(B.page).getByRole("button", { name: "還原" }).click();
      await syncCard(B.page).getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
      await E2E.go(B.page, "計畫");
      const bLong = card(B.page, "長跑", nextSunday);
      await bLong.locator(".badge", { hasText: "自己改過" }).waitFor({ timeout: 10000 });
      await expand(bLong);
      c("bNote", (await bLong.locator(".self-change-note").innerText()).includes("自己改短到一半"));
      c("bReason", (await bLong.locator('[aria-label="為什麼改"] button[aria-pressed="true"]').innerText()) === "沒時間");
      c("bChips", (await bLong.locator(".chips").innerText()).includes("5 km"));
      c("noOverflow", await noOverflow(B.page));
    } catch (e) {
      problems.push(`[desktop ${step}] ${e.message.split("\n")[0]}`);
      await A.page.screenshot({ path: `${E2E.OUT}/self-change-fail-A-1280-dark.png` }).catch(() => {});
      await B.page.screenshot({ path: `${E2E.OUT}/self-change-fail-B-1280-dark.png` }).catch(() => {});
    }
    await A.context.close();
    await B.context.close();
  }

  await browser.close();
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
})();
