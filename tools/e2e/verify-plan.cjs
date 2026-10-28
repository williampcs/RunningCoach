// 驗證課表頁（12.8、12.15、12.22 的 B 版）：未來幾天的時間軸、今天放大、其他天收起與展開、休息日沒有按鈕、
// 不到一分鐘寫秒、非跑步不寫公里、賽事排進時間軸、「為什麼這樣排」預設收起、沒有週的編號；
// 跳過、改用替代、移到別天、恢復；先排好的下週接在這週後面；這週稍早的課與實際的對照；訓練偏好
const E2E = require("./env.cjs");
const { chromium } = E2E;

const URL = E2E.URL;
const width = Number(process.argv[2] || 390);
const height = Number(process.argv[3] || 844);
const scheme = process.argv[4] || "light";
const mobile = width < 600;
let step = "start";
let failPage = null;

// 模擬上游的「今天」是台北時間
const taipei = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
const TODAY = taipei(new Date());
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const WEEKDAY = (new Date(`${TODAY}T00:00:00Z`).getUTCDay() + 6) % 7;
const NEXT_MONDAY = plusDays(TODAY, 7 - WEEKDAY);
// 課表頁的日期是 m/d，不補零（10/27、11/1）
const md = (iso) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }),
    colorScheme: scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  failPage = page;
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${step}] pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  const check = {};
  const tab = (name) => E2E.go(page, name);
  // 調整後課表是非同步重新讀取的：等條件成立（最多 5 秒）
  const until = async (fn) => {
    for (let i = 0; i < 25; i++) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const field = (label, tag) => page.locator("label", { hasText: new RegExp(`^${label}`) }).locator(tag);
  // 分頁的內容在 .page 裡捲動：截一張打開時看到的畫面，再截整張課表卡片
  const shot = async (name) => {
    await page.locator(".page").evaluate((el) => el.scrollTo(0, 0));
    await page.screenshot({ path: `${E2E.OUT}/plan-${width}-${scheme}-${name}.png` });
    // 暫時把視窗拉高到放得下整張卡片，截圖後還原
    const cardHeight = await page.locator("section.plan-card").evaluate((el) => el.scrollHeight);
    await page.setViewportSize({ width, height: Math.max(height, cardHeight + 400) });
    await page.locator("section.plan-card").screenshot({ path: `${E2E.OUT}/plan-${width}-${scheme}-${name}-card.png` });
    await page.setViewportSize({ width, height });
  };

  step = "設定";
  await page.goto(URL);
  await E2E.setupMock(page, { mock: E2E.MOCK });
  await tab("回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

  step = "訓練偏好";
  // 選手頁的「練什麼、怎麼練」（規格 12.30）：改了就存；節奏收在「更多」
  await E2E.profile(page, "練什麼、怎麼練");
  await page.waitForTimeout(300);
  await E2E.profileSave(page, () => field("強度", "select").selectOption("moderate"));
  await page.locator(".profile-more > summary").click();
  await E2E.profileSave(page, () => field("節奏", "select").selectOption("fixed"));
  await E2E.profileSave(page, () => field("每週最多幾次", "input").fill("4"));
  await page.locator(".toast", { hasText: /^\s*已儲存\s*$/ }).first().waitFor({ timeout: 5000 });

  step = "賽事";
  // 下週六的半馬排在時間軸的那天；40 天後的接在最後面；比完的不放
  await tab("計畫");
  const racesCard = page.locator("section#races");
  const addRace = async (name, date, km) => {
    await racesCard.getByRole("button", { name: "新增賽事" }).click();
    await racesCard.getByLabel("賽事名稱").fill(name);
    await racesCard.getByLabel("日期").fill(date);
    await racesCard.getByLabel("距離（km）").fill(String(km));
    await racesCard.getByRole("button", { name: "新增", exact: true }).click();
    await racesCard.getByText(name).first().waitFor({ timeout: 5000 });
  };
  await addRace("下週的半馬", plusDays(NEXT_MONDAY, 5), 21.0975);
  await addRace("秋季全馬", plusDays(TODAY, 40), 42.195);

  step = "請教練排下週的課表";
  await tab("對話");
  await page.getByPlaceholder("輸入訊息…").fill("幫我排下週的課表");
  await page.getByRole("button", { name: "送出" }).click();
  await page.locator('.msg.user:has-text("幫我排下週的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
  check.coachSaved = (await page.locator(".bubble.assistant").last().innerText()).includes("課表已儲存");

  step = "課表頁";
  await tab("計畫");
  const card = page.locator("section.plan-card");
  const sessions = card.locator(".plan-session");
  await sessions.first().waitFor({ timeout: 10000 });
  const cardText = await card.innerText();
  check.noWeekNumber = !/W\d\d/.test(await page.locator(".page").innerText());
  check.dateRange = cardText.includes(`${md(NEXT_MONDAY)} – ${md(plusDays(NEXT_MONDAY, 6))}`);
  // 日期一律 m/d（今天、明天照舊），沒有 MM-DD
  const dateLabels = await card.locator(".tl-date .tl-label").allInnerTexts();
  check.dateFormat = dateLabels.length > 0 && dateLabels.every((l) => /^(今天|明天|\d{1,2}\/\d{1,2})$/.test(l)) && !/\b\d\d-\d\d\b/.test(cardText);
  // 電腦上：卡片和上面那一行同寬、填滿；日期欄是一行的「m/d 星期X」。手機上日期與星期分兩行
  const widthOf = (loc) => loc.evaluate((el) => el.getBoundingClientRect().width);
  const topWidth = await widthOf(card.locator(".plan-top"));
  const timelineWidth = await widthOf(card.locator(".timeline"));
  const cardInner = await card.evaluate((el) => el.clientWidth - parseFloat(getComputedStyle(el).paddingLeft) - parseFloat(getComputedStyle(el).paddingRight));
  check.widthAligned = Math.abs(topWidth - timelineWidth) < 2 && Math.abs(timelineWidth - cardInner) < 2;
  const when = card.locator(".tl-day:not(:has(.tl-date.today)) .tl-when").nth(1);
  const whenText = (await when.innerText()).replace(/\s+/g, " ").trim();
  const whenBox = await when.boundingBox();
  const lineHeight = await when.locator(".tl-label").evaluate((el) => el.getBoundingClientRect().height);
  check.dateColumn = mobile
    ? whenBox.height > lineHeight * 1.5 && /^\d{1,2}\/\d{1,2} [一二三四五六日]$/.test(whenText)
    : whenBox.height < lineHeight * 1.5 && /^\d{1,2}\/\d{1,2} 星期[一二三四五六日]$/.test(whenText);
  check.topLine = /\d+(\.\d)? km · 3 次跑步/.test(cardText);
  check.noBoilerplate = !cardText.includes("配速與心率由程式依你的訓練數值換算");
  // 為什麼這樣排：預設收起；展開後是教練的理由，不是檢查器的警告
  const whyButton = card.getByRole("button", { name: "為什麼這樣排" });
  check.whyCollapsed = (await whyButton.getAttribute("aria-expanded")) === "false" && !cardText.includes("依最近的跑量排下週");
  // 時間軸：日期由小到大，從下週一排到下週日
  const dates = await card.locator(".tl-day[data-date]").evaluateAll((els) => els.map((e) => e.dataset.date));
  check.timelineOrder = dates.length >= 7 && dates.every((d, i) => i === 0 || dates[i - 1] < d) && dates[0] === NEXT_MONDAY;
  // 放大的是第一堂（下週二的輕鬆跑），步驟直列、有按鈕；同一天的肌力是小卡片
  const focus = card.locator(".plan-session.focus");
  const focusText = await focus.innerText();
  check.oneFocus = (await focus.count()) === 1 && focusText.includes("輕鬆跑");
  // 放大的課卡（規格 12.28）：圖示、標籤最多三個、一條強度條；步驟收在「細節」
  check.focusCard =
    (await focus.locator(".plan-sport-icon svg").count()) === 1 &&
    (await focus.locator(".chip").count()) <= 3 &&
    (await focus.locator(".strip .split-bar").count()) === 1 &&
    (await focus.getByRole("button", { name: "跳過" }).count()) === 1;
  check.stepsInDetails = (await focus.locator(".plan-step").count()) === 0;
  const tuesday = card.locator(`.tl-day[data-date="${plusDays(NEXT_MONDAY, 1)}"]`);
  check.twoOnSameDay = (await tuesday.locator(".plan-session").count()) === 2 && (await tuesday.locator(".tl-date").count()) === 1;
  // 細節（目的、完成的標準）預設收起
  check.detailsCollapsed = !focusText.includes("完成的標準");
  await focus.getByRole("button", { name: /細節/ }).click();
  check.detailsOpen = (await focus.innerText()).includes("完成的標準") && (await focus.locator(".plan-step").count()) >= 3;
  check.seconds = (await focus.innerText()).includes("20 秒") && !/0\.\d 分鐘/.test(cardText);
  // 其他天收起：只有課名與小標籤
  const others = card.locator(".plan-session:not(.focus)");
  check.othersCollapsed = (await others.locator(".plan-steps").count()) === 0 && (await others.getByRole("button", { name: "跳過" }).count()) === 0;
  const strength = sessions.filter({ hasText: "肌力" });
  check.nonRunNoKm = (await strength.innerText()).includes("20 分鐘") && !(await strength.innerText()).includes("km");
  check.kindOnce = !/休息：休息|輕鬆跑：輕鬆跑|長跑：長跑/.test(cardText);
  // 休息日只有一行，沒有按鈕
  const rests = card.locator(".plan-rest");
  check.restNoButton = (await rests.count()) >= 1 && (await card.locator(".tl-day").filter({ has: page.locator(".plan-rest") }).locator("button").count()) === 0;
  // 賽事：下週六在時間軸上，40 天後的接在虛線後面
  const raceDay = card.locator(`.tl-day[data-date="${plusDays(NEXT_MONDAY, 5)}"]`);
  check.raceOnDay = (await raceDay.locator(".plan-race", { hasText: "下週的半馬" }).count()) === 1 && (await raceDay.innerText()).includes("半馬");
  check.laterRace = (await card.locator(".tl-gap", { hasText: "之後的課表還沒排" }).count()) === 1 && (await card.locator(".plan-race", { hasText: "秋季全馬" }).count()) === 1;
  const lastDates = await card.locator(".timeline > li").evaluateAll((els) => els.map((e) => e.className));
  check.laterRaceAfterGap = lastDates.at(-1).includes("tl-day") && lastDates.at(-2).includes("tl-gap");
  await shot("1");

  step = "展開其他天";
  const t = sessions.filter({ hasText: "4×1 km 閾值" });
  await t.locator("button.plan-session-head").click();
  // 強度條：暖身、主課、緩和
  check.structureLabels = /^暖身\d+分主課\d+分緩和\d+分$/.test((await t.locator(".strip-labels").innerText()).replace(/\s+/g, ""));
  await t.getByRole("button", { name: /細節/ }).click();
  const tText = await t.innerText();
  check.expandOther = (await t.locator(".plan-step").count()) >= 3 && /\d:\d\d–\d:\d\d\/km/.test(tText) && /心率 ≤\d+/.test(tText);
  check.fallbackInDetails = tText.includes("改成 40 分鐘輕鬆跑");

  step = "點整張卡片展開與收合";
  // 點卡片裡標題以外的地方（小標籤）就展開；點卡片裡的按鈕不會收合；再點空白處收合
  const strengthCard = sessions.filter({ hasText: "肌力" });
  const expanded = async (loc) => (await loc.locator("button.plan-session-head").getAttribute("aria-expanded")) === "true";
  // 卡片的內距（標題以外的地方）
  await strengthCard.click({ position: { x: 4, y: 4 } });
  check.cardClickExpands = (await expanded(strengthCard)) && (await strengthCard.locator(".strip").count()) === 1;
  await strengthCard.getByRole("button", { name: /細節/ }).click();
  check.buttonKeepsOpen = (await expanded(strengthCard)) && (await strengthCard.innerText()).includes("完成的標準");
  await strengthCard.locator(".strip").click();
  check.cardClickCollapses = !(await expanded(strengthCard)) && (await strengthCard.locator(".strip").count()) === 0;
  // 放大的那張也可以點來收合、再展開
  await focus.locator(".strip").click();
  const focusCollapsed = !(await expanded(focus));
  await focus.click({ position: { x: 4, y: 4 } });
  check.focusToggles = focusCollapsed && (await expanded(focus));
  // 鍵盤：標題是真正的按鈕
  await strengthCard.locator("button.plan-session-head").focus();
  await page.keyboard.press("Enter");
  check.keyboardToggles = await expanded(strengthCard);
  await page.keyboard.press("Enter");

  step = "為什麼這樣排";
  await whyButton.click();
  const why = card.locator(".plan-why");
  const whyText = await why.innerText();
  check.whyOpen = whyText.includes("（模擬）依最近的跑量排下週") && whyText.includes("（模擬）測試用的課表") && whyText.includes("之後幾週");
  // 檢查器的警告不給選手看
  check.noCheckerWarnings = !(await card.innerText()).includes("檢查器") && !whyText.includes("教練的理由：") && (await card.locator(".notice.warn").count()) === 0;
  await shot("2");

  step = "點賽事捲到賽事區";
  await card.locator(".plan-race", { hasText: "秋季全馬" }).click();
  check.raceScrolls = await until(async () => {
    const box = await racesCard.boundingBox();
    return box !== null && box.y >= -2 && box.y < height;
  });

  step = "改用替代";
  await t.getByRole("button", { name: "改用替代" }).click();
  await page.locator(".notice.ok", { hasText: "已改用替代的課" }).waitFor({ timeout: 5000 });
  check.fallbackBadge = await until(async () => (await t.locator(".badge").innerText()) === "改用替代");

  step = "跳過";
  await focus.getByRole("button", { name: "跳過" }).click();
  await page.locator(".notice.ok", { hasText: "已跳過" }).waitFor({ timeout: 5000 });
  const easy = sessions.filter({ hasText: "輕鬆跑" });
  check.skipBadge = await until(async () => (await easy.first().locator(".badge").innerText()) === "已跳過");

  step = "移到別天";
  const long = sessions.filter({ hasText: "長跑" });
  const dayOf = (loc) => loc.evaluate((el) => el.closest(".tl-day").dataset.date);
  const before = await dayOf(long);
  await long.locator("button.plan-session-head").click();
  await long.getByRole("button", { name: "移到別天" }).click();
  await long.locator(".move-days button").first().click();
  await page.locator(".notice.ok", { hasText: "已移動" }).waitFor({ timeout: 5000 });
  check.moved = await until(async () => (await dayOf(sessions.filter({ hasText: "長跑" }))) !== before);

  step = "恢復";
  // 跳過之後放大的是下一堂：跳過的那堂收起，點開才有「恢復原本的課」
  const skipped = sessions.filter({ hasText: "輕鬆跑" }).first();
  check.focusMoved = !(await skipped.evaluate((el) => el.classList.contains("focus")));
  await skipped.locator("button.plan-session-head").click();
  await skipped.getByRole("button", { name: "恢復原本的課" }).click();
  await page.locator(".notice.ok", { hasText: "已恢復原本的課" }).waitFor({ timeout: 5000 });
  check.restored = await until(async () => (await sessions.filter({ hasText: "輕鬆跑" }).first().locator(".badge").count()) === 0);

  step = "重新整理後";
  await page.reload();
  await tab("計畫");
  await sessions.first().waitFor({ timeout: 10000 });
  check.persisted = await until(async () => (await t.locator(".badge").innerText()) === "改用替代");
  check.prefsPersisted = await (async () => {
    await E2E.profile(page, "練什麼、怎麼練");
    // 選手資料是非同步讀取的：等值出現
    for (let i = 0; i < 25; i++) {
      if ((await field("強度", "select").inputValue()) === "moderate" && (await field("每週最多幾次", "input").inputValue()) === "4") return true;
      await page.waitForTimeout(200);
    }
    return false;
  })();

  step = "這週的課表：配對已經跑的紀錄";
  await tab("對話");
  await page.getByPlaceholder("輸入訊息…").fill("幫我排這週的課表");
  await page.getByRole("button", { name: "送出" }).click();
  await page.locator('.msg.user:has-text("幫我排這週的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
  await tab("計畫");
  await card.locator(".plan-week", { hasText: "這週" }).waitFor({ timeout: 10000 });
  // 先排的下週接在這週後面
  check.nextWeekAppended = (await card.locator(".tl-week", { hasText: `下週 ${md(NEXT_MONDAY)} – ` }).count()) === 1;
  const days = await card.locator(".tl-day[data-date]").evaluateAll((els) => els.map((e) => e.dataset.date));
  check.startsToday = days[0] === TODAY && days.includes(plusDays(NEXT_MONDAY, 6));
  check.todayLabel = (await card.locator(".tl-date.today .tl-label").innerText()) === "今天";
  // 這週今天以前的課收成一行「這週稍早」，預設收起
  const earlier = card.locator("details.plan-earlier");
  const past = WEEKDAY >= 4 ? 2 : WEEKDAY >= 2 ? 1 : 0; // 這週的課在二（輕鬆跑＋肌力）、四、日；今天的不算稍早
  const pastSessions = WEEKDAY > 1 ? (WEEKDAY > 3 ? 3 : 2) : 0;
  check.pastSessionsJudged = true;
  if (past) {
    check.earlierCollapsed = (await earlier.count()) === 1 && !(await earlier.evaluate((d) => d.open));
    await earlier.locator("summary").click();
    const items = earlier.locator(".plan-session");
    check.earlierCount = (await items.count()) === pastSessions;
    const labels = ["達成", "部分達成", "跑了不一樣的課", "沒跑", "沒做", "有休息", "休息日有運動"];
    for (const li of await items.all()) {
      const badge = (await li.locator(".badge").count()) ? await li.locator(".badge").innerText() : "";
      if (!labels.includes(badge)) check.pastSessionsJudged = false;
      await li.locator("button.plan-session-head").click();
      // 配對到紀錄的課顯示實際，沒有調整的按鈕
      if (["達成", "部分達成", "跑了不一樣的課"].includes(badge)) {
        const result = await li.locator(".session-result").innerText().catch(() => "");
        if (!result.startsWith("實際：") || (await li.locator(".session-actions").count()) > 0) check.pastSessionsJudged = false;
      } else if (["沒跑", "沒做"].includes(badge) && !(await li.innerText()).includes("跳過即可，不要補")) check.pastSessionsJudged = false;
    }
  } else {
    check.noEarlier = (await earlier.count()) === 0;
  }
  // 排在今天以前的提醒只給教練看
  check.pastDateNotShown = (await page.getByText("排在今天以前").count()) === 0;
  console.log(`這週今天以前的課：${past ? pastSessions : 0} 堂`);
  await shot("3");
  check.noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch(async (e) => {
  console.error(`FAILED at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
  if (failPage) await failPage.screenshot({ path: `${E2E.OUT}/plan-fail.png`, fullPage: true }).catch(() => undefined);
  process.exit(1);
});
