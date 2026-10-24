// 驗證結構化課表：教練排的課表顯示換算後的目標與替代；跳過、改用替代、移到別天、恢復；訓練偏好
const E2E = require("./env.cjs");
const { chromium } = E2E;

const URL = E2E.URL;
const width = Number(process.argv[2] || 390);
const height = Number(process.argv[3] || 844);
const scheme = process.argv[4] || "light";
const mobile = width < 600;
let step = "start";
let failPage = null;

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
  const tab = (name) => page.getByRole("button", { name, exact: true }).click();
  // 調整後課表是非同步重新讀取的：等條件成立（最多 5 秒）
  const until = async (fn) => {
    for (let i = 0; i < 25; i++) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const field = (label, tag) => page.locator("label", { hasText: new RegExp(`^${label}`) }).locator(tag);

  step = "設定";
  await page.goto(URL);
  await tab("設定");
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();
  await tab("跑後回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

  step = "訓練偏好";
  await tab("選手資料");
  // 選手資料讀取完成前改的值，會被讀回來的資料蓋掉：等訓練數值卡片出現（同一時間讀取）
  await page.locator("section.training-values").waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
  await field("強度", "select").selectOption("moderate");
  await field("節奏", "select").selectOption("fixed");
  await field("每週最多幾次", "input").fill("4");
  await page.getByRole("button", { name: "儲存選手資料" }).click();
  await page.locator(".notice.ok", { hasText: "已儲存" }).waitFor({ timeout: 5000 });

  step = "請教練排課表";
  await tab("對話");
  await page.getByPlaceholder("輸入訊息…").fill("幫我排下週的課表");
  await page.getByRole("button", { name: "送出" }).click();
  await page.locator('.msg.user:has-text("幫我排下週的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
  const reply = await page.locator(".bubble.assistant").last().innerText();
  check.coachSaved = reply.includes("課表已儲存");

  step = "計畫頁";
  await tab("計畫與賽事");
  // 第一張卡片是目前的課表；先排好的下週課表另外列在後面
  const sessions = page.locator("section.card").first().locator("ul.sessions > li");
  await sessions.first().waitFor({ timeout: 10000 });
  check.threeSessions = (await sessions.count()) === 3;
  const t = sessions.filter({ hasText: "T 閾值" });
  const tText = await t.innerText();
  check.paceResolved = /\d:\d\d–\d:\d\d\/km（T）/.test(tText) && /心率 ≤\d+/.test(tText);
  check.fallbackShown = tText.includes("狀況不好時：改成 40 分鐘輕鬆跑");
  check.reasonShown = (await page.getByText("排課的原因：（模擬）依最近的跑量排下週").count()) === 1;
  // 模擬的紀錄只有兩趟，下週的跑量會超過漸進的上限：提醒與教練的理由一起顯示
  const notes = page.locator(".notice.warn", { hasText: "檢查器的提醒" });
  check.notesWithReason = (await notes.count()) === 0 || (await notes.innerText()).includes("教練的理由：（模擬）測試用的課表");
  check.outlineShown = (await page.getByText("之後幾週").count()) === 1;
  check.noEditForStructured = (await page.getByRole("button", { name: "編輯" }).count()) === 0;
  await page.screenshot({ path: `${E2E.OUT}/plan-${width}-${scheme}-1.png`, fullPage: true });

  step = "改用替代";
  await t.getByRole("button", { name: "改用替代" }).click();
  await page.locator(".notice.ok", { hasText: "已改用替代的課" }).waitFor({ timeout: 5000 });
  check.fallbackBadge = await until(async () => (await t.locator(".badge").innerText()) === "改用替代");

  step = "跳過";
  const easy = sessions.filter({ hasText: "輕鬆跑：輕鬆跑" });
  await easy.getByRole("button", { name: "跳過" }).click();
  await page.locator(".notice.ok", { hasText: "已跳過" }).waitFor({ timeout: 5000 });
  check.skipBadge = await until(async () => (await easy.locator(".badge").innerText()) === "已跳過");

  step = "移到別天";
  const long = sessions.filter({ hasText: "長跑：長跑" });
  const before = await long.locator(".session-when").innerText();
  await long.getByRole("button", { name: "移到別天" }).click();
  await long.locator(".session-actions button.small").first().click();
  await page.locator(".notice.ok", { hasText: "已移動" }).waitFor({ timeout: 5000 });
  const moved = sessions.filter({ hasText: "長跑：長跑" });
  check.moved = await until(async () => (await moved.locator(".session-when").innerText()) !== before);

  step = "恢復";
  await easy.getByRole("button", { name: "恢復原本的課" }).click();
  await page.locator(".notice.ok", { hasText: "已恢復原本的課" }).waitFor({ timeout: 5000 });
  check.restored = await until(async () => (await easy.locator(".badge").count()) === 0);

  step = "重新整理後";
  await page.reload();
  await tab("計畫與賽事");
  await sessions.first().waitFor({ timeout: 10000 });
  check.persisted = await until(async () => (await t.locator(".badge").innerText()) === "改用替代");
  check.prefsPersisted = await (async () => {
    await tab("選手資料");
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
  await tab("計畫與賽事");
  await page.getByText("排課的原因：（模擬）依最近的跑量排這週").waitFor({ timeout: 10000 });
  // 先排的下週課表沒有被這週的蓋掉，另外列出
  check.nextWeekKept = (await page.getByText(/^下週的課表（/).count()) === 1;
  const todayMd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit" }).format(new Date()).replace("/", "-");
  const labels = ["達成", "部分達成", "跑了不一樣的課", "沒跑"];
  let past = 0;
  check.pastSessionsJudged = true;
  for (const li of await sessions.all()) {
    const when = (await li.locator(".session-when").innerText()).slice(0, 5);
    if (when === todayMd) continue;
    if (when > todayMd) {
      // 今天以後的課沒有判斷
      if (await li.locator(".badge").count()) check.pastSessionsJudged = false;
      continue;
    }
    past++;
    const badge = (await li.locator(".badge").count()) ? await li.locator(".badge").innerText() : "";
    if (!labels.includes(badge)) check.pastSessionsJudged = false;
    // 配對到紀錄的課顯示實際，沒有調整的按鈕
    if (badge !== "沒跑") {
      const result = await li.locator(".session-result").innerText().catch(() => "");
      if (!result.startsWith("實際：") || (await li.locator(".session-actions").count()) > 0) check.pastSessionsJudged = false;
    } else if (!(await li.innerText()).includes("跳過即可，不要補")) check.pastSessionsJudged = false;
  }
  check.pastDateWarned = past === 0 || (await page.locator(".notice.warn", { hasText: "排在今天以前" }).count()) === 1;
  console.log(`這週今天以前的課：${past} 堂`);
  await page.screenshot({ path: `${E2E.OUT}/plan-${width}-${scheme}-2.png`, fullPage: true });
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
