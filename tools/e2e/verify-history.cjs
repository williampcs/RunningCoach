// 驗證紀錄頁（規格 12.9）：底部 5 個分頁、設定在標題列；跑後回報的結果卡片；紀錄頁的列、點開的卡片、補填體感、請教練分析
const E2E = require("./env.cjs");
const { chromium } = E2E;
const width = Number(process.argv[2] || 390), height = Number(process.argv[3] || 844), scheme = process.argv[4] || "light";
const mobile = width < 600;
let step = "start";
let failPage = null;

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }), colorScheme: scheme, timezoneId: "Asia/Taipei" });
  const page = await context.newPage();
  failPage = page;
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${step}] pageerror: ${e.message}`));
  const tab = (name) => E2E.go(page, name);
  const check = {};

  step = "分頁";
  await page.goto(E2E.URL);
  await page.locator("nav.tabbar button").first().waitFor({ timeout: 15000 });
  check.fiveTabs = (await page.locator("nav.tabbar button").allInnerTexts()).map((t) => t.replace(/\s+/g, "")).join(",") === "💬對話,🏃跑後回報,📖紀錄,📅計畫與賽事,👤選手資料";
  await E2E.go(page, "設定");
  check.gearOpensSettings = (await page.getByRole("heading", { name: "LLM 服務" }).count()) > 0 || (await page.getByLabel("供應商").count()) === 1;

  step = "設定";
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();

  step = "排這週的課表";
  await tab("對話");
  await page.getByPlaceholder("輸入訊息…").fill("幫我排這週的課表");
  await page.getByRole("button", { name: "送出" }).click();
  await page.locator('.msg.user:has-text("幫我排這週的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });

  step = "跑後回報的結果卡片";
  await tab("跑後回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });
  await page.locator("fieldset.choices .choice").first().click();
  await page.locator('input[type="range"]').fill("7");
  await page.getByPlaceholder("例如：腿有點重").fill("後段有點喘");
  await page.getByRole("button", { name: /^存到/ }).click();
  const result = page.locator(".report-result .run-card");
  await result.waitFor({ timeout: 30000 });
  const resultText = await result.innerText();
  check.resultStats = /距離 km\s*10\.02/.test(resultText) && /配速 \/km\s*5:30/.test(resultText) && /心率\s*152/.test(resultText);
  check.resultEffort = resultText.includes("體感 7/10") && (await result.locator(".effort-scale span.mark").count()) === 1;
  check.resultNotes = resultText.includes("「後段有點喘」");
  check.resultBar = (await result.locator(".split-bar").count()) === 1;
  check.summaryCollapsed = resultText.includes("穩定的有氧跑") && !(await result.locator("details").evaluate((d) => d.open));
  check.noOldTextBlock = (await page.locator(".report-result pre").count()) === 0;
  await page.screenshot({ path: `${E2E.OUT}/history-${width}-${scheme}-1-result.png` });
  await result.getByRole("button", { name: "看所有紀錄" }).click();

  step = "紀錄頁";
  const rows = page.locator("ul.runs > li");
  await rows.first().waitFor({ timeout: 10000 });
  check.twoRows = (await rows.count()) === 2;
  await page.waitForTimeout(1200); // 數字從 0 跑到總量
  const totals = await page.locator("section.totals").innerText();
  console.log("TOTALS", totals.replace(/\s+/g, " "));
  check.totalsShown = /累積跑了\s*18(\.0)?\s*km/.test(totals) && totals.includes("跑了") && (await page.locator("section.totals .block").count()) === 2;
  check.collapsedByDefault = (await page.locator("ul.runs .run-card").count()) === 0;
  const older = rows.nth(1);
  const olderRow = await older.locator(".run-row").innerText();
  // 模擬的課表在這週的二、四、日，較早那趟是三天前：依今天是星期幾，它會配到課、在課表外，或落在上週（沒有課表）
  const taipeiToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
  const olderIndex = ((new Date(`${taipeiToday}T00:00:00Z`).getUTCDay() + 6) % 7) - 3;
  const expected = olderIndex < 0 ? "none" : [1, 3, 6].includes(olderIndex) ? "matched" : "outside";
  const badges = await older.locator(".run-tags .badge").allInnerTexts();
  console.log("OLDER", expected, badges.join("|"));
  check.rowTags =
    badges.includes("未填體感") &&
    (expected === "outside" ? badges.includes("課表外") : expected === "matched" ? badges.length === 2 && !badges.includes("課表外") : badges.length === 1);
  await page.screenshot({ path: `${E2E.OUT}/history-${width}-${scheme}-2-list.png` });

  step = "點開、補填體感";
  await older.locator(".run-row").click();
  await older.locator(".run-card").waitFor({ timeout: 5000 });
  check.expands = (await older.locator(".run-row").getAttribute("aria-expanded")) === "true";
  check.noDuplicateInRow = !(await older.locator(".run-row").innerText()).includes("km") && (await older.locator(".run-row .split-bar").count()) === 0;
  check.noDuplicateHead = (await older.locator(".run-card-head").count()) === 0;
  check.noEffortYet = (await older.innerText()).includes("還沒填體感");
  await older.getByRole("button", { name: "補填體感" }).click();
  await older.locator('input[type="range"]').fill("8");
  await older.getByLabel("主觀感受").fill("最後兩公里很喘");
  await older.getByRole("button", { name: "儲存並重新分析" }).click();
  await older.getByRole("button", { name: "請教練分析" }).waitFor({ timeout: 20000 });
  const text = await older.innerText();
  check.effortSaved = text.includes("體感 8/10") && text.includes("「最後兩公里很喘」");
  check.labelNowEdit = (await older.getByRole("button", { name: "修改體感" }).count()) === 1;
  check.rowTagUpdated = !(await older.locator(".run-row").innerText()).includes("未填體感");
  await page.screenshot({ path: `${E2E.OUT}/history-${width}-${scheme}-3-open.png` });

  step = "請教練分析";
  await older.getByRole("button", { name: "請教練分析" }).click();
  check.chatRequest = await page.locator(".bubble.user", { hasText: /我補記了 \d{4}-\d{2}-\d{2} 那次跑步的感受/ }).waitFor({ timeout: 10000 }).then(() => true, () => false);

  step = "匯入完整歷史";
  await tab("紀錄");
  const totalsCard = page.locator("section.totals");
  await totalsCard.getByRole("button", { name: "匯入 Intervals.icu 的完整歷史" }).click();
  const done = totalsCard.locator(".notice.ok", { hasText: "匯入完成" });
  await done.waitFor({ timeout: 60000 });
  const doneText = await done.innerText();
  console.log("IMPORT", doneText.replace(/\s+/g, " "));
  check.importAdded = /新增 \d+ 趟/.test(doneText) && doneText.includes("最早的一趟是 2024-01-05") && doneText.includes("2024：");
  check.importStravaNote = doneText.includes("另有 1 筆是從 Strava 匯入");
  await page.waitForTimeout(1500);
  const after = await totalsCard.innerText();
  check.totalsGrew = /從 2024-01-05 起/.test(after) && (await totalsCard.locator(".block").count()) > 100;
  check.medalsAndTowers = (await totalsCard.locator(".medal").count()) > 0 && (await totalsCard.locator("svg.tower").count()) > 0;
  check.journey = (await totalsCard.locator(".journey-runner").count()) === 1;
  check.importRerun = (await totalsCard.getByRole("button", { name: "再匯入一次" }).count()) === 1;
  await page.screenshot({ path: `${E2E.OUT}/history-${width}-${scheme}-4-imported.png` });
  // 重跑不重複
  await totalsCard.getByRole("button", { name: "再匯入一次" }).click();
  await totalsCard.locator(".notice.ok", { hasText: "新增 0 趟" }).waitFor({ timeout: 60000 });
  check.importIdempotent = true;

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
  if (failPage) await failPage.screenshot({ path: `${E2E.OUT}/history-fail.png`, fullPage: true }).catch(() => undefined);
  process.exit(1);
});
