// 驗證課表頁的「之前的週」與教練看到的最近 4 週（規格 12.34 第 1、2 點）：
// - 測試模式產生 12 週的假跑步（每週 3 次：週二輕鬆、週四強度、週日長跑），模擬的教練存過去 10 週的課表（週三多一堂不會有紀錄的）
// - 「之前的週」在計畫頁最下面、預設收起；展開後先 8 週、新的在上面、日期 m/d – m/d、計畫與實際的距離、每堂課一個小圖示（沒做是灰的，不是紅的）
// - 「再看更早的」多列 2 週；點開一週：每堂課的標題與結果；點配到紀錄的那堂到紀錄頁那一趟（30 天以前的也列得到、打開並捲到）
// - 教練的系統提示（會變的那一段）有【最近 4 週照課表的情形】與「週三的課」；固定的那一段有「不要責備選手」
// - 手機淺色與電腦深色的截圖（past-weeks-*），不左右捲動
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
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
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
        { timeout: 30000 },
      );
    };
    // 截圖：把視窗拉高到放得下整張「之前的週」
    const shot = async (name) => {
      const card = page.locator(".past-weeks-card");
      await card.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/past-weeks-${name}-${size}.png` });
      const h = await card.evaluate((el) => el.scrollHeight);
      const viewport = page.viewportSize();
      await page.setViewportSize({ width: viewport.width, height: Math.max(viewport.height, h + 200) });
      await card.screenshot({ path: `${E2E.OUT}/past-weeks-${name}-${size}-card.png` });
      await page.setViewportSize(viewport);
    };
    try {
      step = "設定與測試模式";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false, timeZone: "Asia/Taipei" });
      await E2E.settings(page, "測試模式");
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "啟用測試模式" }).click()]);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.settings(page, "測試模式");
      const panel = page.locator("#side-panel");
      await panel.getByLabel("週數").fill("12");
      await panel.getByLabel("每週次數").fill("3");
      await panel.getByRole("button", { name: /產生/ }).click();
      await panel.getByText(/已產生 \d+ 筆/).waitFor({ timeout: 20000 });
      await panel.getByRole("button", { name: "同步最近 14 天" }).click();
      await page.locator(".toast, .notice", { hasText: /同步完成|已是最新|新增/ }).first().waitFor({ timeout: 60000 });

      step = "沒有過去的課表時不顯示";
      await E2E.go(page, "計畫");
      await page.locator("section#races").waitFor();
      c("hiddenWithoutPlans", (await page.locator(".past-weeks-card").count()) === 0);

      step = "排過去 10 週與這週的課表";
      await send("排前幾週的課表");
      await send("幫我排課表");

      step = "教練看得到最近 4 週";
      const requests = (await (await fetch(`${E2E.MOCK}/_mock/requests`)).json()).filter((r) => r.kind === "llm");
      const last = requests.at(-1).body ?? requests.at(-1);
      const system = (last.messages ?? []).filter((m) => m.role === "system").map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content))).join("\n");
      c("summaryInPrompt", system.includes("【最近 4 週照課表的情形】") && system.includes("4 週都有課表"));
      c("summaryWeekday", /・週三的課：4 週排了 4 次，沒做到 4 次/.test(system));
      c("summaryKinds", /・輕鬆跑 \d+ 堂：/.test(system) && /・T 閾值 4 堂：/.test(system) && /・長跑 4 堂：/.test(system));
      c("instruction", system.includes("不要責備選手"));
      // 摘要在會變的那一段：日期之後
      c("summaryAfterDate", system.indexOf("【最近 4 週照課表的情形】（") > system.indexOf("今天日期："));

      step = "之前的週：預設收起";
      await E2E.go(page, "計畫");
      const card = page.locator(".past-weeks-card");
      await card.waitFor({ timeout: 10000 });
      c("atBottom", await page.evaluate(() => {
        const cards = [...document.querySelectorAll("main .card")];
        return cards.at(-1)?.classList.contains("past-weeks-card");
      }));
      c("collapsed", !(await card.locator("details.past-weeks").evaluate((d) => d.open)));
      c("timelineStill", (await page.locator(".plan-card .timeline").count()) === 1);
      await shot("collapsed");

      step = "展開：8 週、新的在上面";
      await card.locator("details.past-weeks > summary").click();
      const rows = card.locator(".past-week");
      await rows.first().waitFor();
      c("eightWeeks", (await rows.count()) === 8);
      const titles = await rows.locator(".list-row-title").allInnerTexts();
      c("newestFirst", titles[0] === range(1) && titles[7] === range(8));
      const sub = await rows.first().locator(".list-row-sub").innerText();
      c("totals", /^計畫 [\d.]+ km · 實際 [\d.]+ km$/.test(sub));
      const marks = rows.first().locator(".past-mark");
      c("fourMarks", (await marks.count()) === 4);
      c("legend", (await card.locator(".past-legend").innerText()).replace(/\s+/g, "") === "達成部分達成換了別的課跳過沒做");
      // 週三那堂沒做：灰的，不是紅的；做了的是綠的
      const colors = await rows.first().locator(".past-mark").evaluateAll((els) => els.map((e) => [e.getAttribute("class"), getComputedStyle(e).color]));
      const muted = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--muted").trim());
      const isRed = (rgb) => {
        const [r, g, b] = rgb.match(/\d+/g).map(Number);
        return r > 150 && r > g * 1.6 && r > b * 1.6;
      };
      c("missedGrey", colors.some(([cls]) => cls.includes("missed")) && colors.every(([, col]) => !isRed(col)));
      c("mutedVar", muted.length > 0);
      c("achievedGreen", colors.some(([cls]) => cls.includes("achieved")));
      c("marksLabel", /達成 \d.*沒跑 \d/.test(await rows.first().locator(".past-marks").getAttribute("aria-label")));
      c("noOverflowList", await noOverflow());
      await shot("open");

      step = "再看更早的";
      await card.getByRole("button", { name: "再看更早的" }).click();
      await page.waitForFunction(() => document.querySelectorAll(".past-week").length === 10, null, { timeout: 5000 });
      c("tenWeeks", (await rows.count()) === 10);
      c("noMoreButton", (await card.getByRole("button", { name: "再看更早的" }).count()) === 0);

      step = "點開一週";
      await rows.first().locator(".past-week-row").click();
      const sessions = rows.first().locator(".past-sessions > li");
      await sessions.first().waitFor();
      c("sessionsListed", (await sessions.count()) === 4);
      const wed = sessions.filter({ hasText: "週三的輕鬆跑" });
      c("wedMissed", (await wed.locator(".badge").innerText()) === "沒跑" && (await wed.locator("button").count()) === 0);
      c("expandedAria", (await rows.first().locator(".past-week-row").getAttribute("aria-expanded")) === "true");
      c("noOverflowWeek", await noOverflow());
      await shot("week");

      step = "點到紀錄頁那一趟";
      const longRun = sessions.filter({ hasText: "長跑" }).locator("button");
      c("longLinked", (await longRun.count()) === 1);
      await longRun.click();
      const opened = page.locator(".runs > li.open[data-workout]");
      await opened.waitFor({ timeout: 10000 });
      c("historyOpen", (await page.locator("nav.tabbar button[aria-current=true]").innerText()).includes("紀錄"));
      // 平滑捲動要一點時間
      await page.waitForTimeout(800);
      c("historyInView", await opened.evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top < window.innerHeight && r.bottom > 0;
      }));
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${E2E.OUT}/past-weeks-history-${size}.png` });

      step = "30 天以前的那一趟";
      await E2E.go(page, "計畫");
      await card.waitFor();
      if (!(await card.locator("details.past-weeks").evaluate((d) => d.open))) await card.locator("details.past-weeks > summary").click();
      const old = card.locator(".past-week", { has: page.locator(".list-row-title", { hasText: range(6) }) });
      await old.locator(".past-week-row").click();
      await old.locator(".past-sessions > li", { hasText: "長跑" }).locator("button").click();
      await page.locator(".runs > li.open[data-workout]").waitFor({ timeout: 10000 });
      const heading = await page.locator("section.card h2", { hasText: /^最近 \d+ 天/ }).innerText();
      c("olderRange", Number(heading.match(/\d+/)[0]) > 30);
      c("noOverflowHistory", await noOverflow());
    } catch (e) {
      problems.push(`[${tag} ${step}] ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: `${E2E.OUT}/past-weeks-fail-${size}.png` }).catch(() => {});
    }
    await context.close();
  }
  await browser.close();
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
})();
