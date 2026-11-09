// 拿不到內容的活動（空殼，KI-048、規格 12.40）：模擬上游切成「Garmin 的活動只剩空殼」後同步，
// 看板的提示（幾筆、來自哪裡、手動記一趟、其他方式 → 使用說明）、紀錄頁沒有 0 公里的紀錄、之前存的照舊留著、✕ 收起後當天不再出現.
// 參數：寬 高 配色（預設 390 844 light）。會改模擬上游的狀態（POST /_mock/shells），跑完改回來：不要和其他腳本同時跑
const E2E = require("./env.cjs");
const { chromium } = E2E;
const width = Number(process.argv[2] || 390), height = Number(process.argv[3] || 844), scheme = process.argv[4] || "light";
const mobile = width < 600;
let step = "start";
let failPage = null;

const shells = (mode) => fetch(`${E2E.MOCK}/_mock/shells?mode=${mode}`, { method: "POST" }).then((r) => r.json());

async function syncNow(page) {
  await E2E.go(page, "回報");
  const before = await page.locator(".toast, .notice").count();
  await page.getByRole("button", { name: /同步/ }).last().click();
  const done = page.locator(".toast, .notice", { hasText: /同步完成|已是最新|無跑步活動/ });
  await done.nth(0).waitFor({ timeout: 30000 });
  await page.waitForTimeout(300);
  void before;
  return (await done.allInnerTexts()).join(" | ");
}

async function openFeed(page) {
  await E2E.go(page, "對話");
  await page.locator(".feed-summary, .feed-list").first().waitFor({ timeout: 10000 });
  if (await page.locator(".feed-summary").count()) await page.locator(".feed-summary").click();
  await page.locator(".feed-item").first().waitFor({ timeout: 10000 });
}

(async () => {
  await shells("off");
  const browser = await chromium.launch();
  const context = await browser.newContext({ ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }), colorScheme: scheme, timezoneId: "Asia/Taipei" });
  const page = await context.newPage();
  failPage = page;
  const problems = [];
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${step}] pageerror: ${e.message}`));
  const check = {};

  step = "設定";
  await page.goto(E2E.URL);
  await page.locator("nav.tabbar button, nav.sidebar button").first().waitFor({ timeout: 15000 });
  await E2E.setupMock(page, { mock: E2E.MOCK });

  step = "平常的同步";
  await syncNow(page);
  await openFeed(page);
  check.noHintBefore = (await page.locator('.feed-item[data-kind="unavailable"]').count()) === 0;

  step = "Garmin 變成空殼後同步";
  await shells("garmin");
  // 等上一則同步的提示消失，才分得出這次的
  await page.waitForTimeout(500);
  const text = await syncNow(page);
  console.log("SYNC", text);
  check.syncNote = text.includes("另有 1 筆來自 Garmin、1 筆來自 Strava 的活動，Intervals.icu 不能提供內容");
  check.syncKeepsStored = !text.includes("移除");

  step = "看板的提示";
  await openFeed(page);
  const item = page.locator('.feed-item[data-kind="unavailable"]');
  await item.waitFor({ timeout: 10000 });
  const title = await item.locator(".feed-title").innerText();
  const detail = await item.locator(".feed-sub").innerText();
  console.log("ITEM", title, "/", detail);
  check.hintTitle = title === "1 筆來自 Garmin、1 筆來自 Strava 的活動，拿不到內容";
  check.hintDetail = detail.includes("不記成跑步") && detail.includes("不算負荷") && detail.includes("手動記");
  // 說明最多兩行：沒有被截掉
  check.detailNotClamped = await item.locator(".feed-sub").evaluate((el) => el.scrollHeight <= el.clientHeight + 1);
  check.hintButtons = (await item.locator(".feed-actions button").allInnerTexts()).join(",") === "手動記一趟,其他方式";
  check.hintDismissible = (await item.locator(".feed-dismiss").count()) === 1;
  check.buttonHeight = (await item.locator(".feed-actions button").evaluateAll((els) => els.every((b) => b.getBoundingClientRect().height >= 44)));
  await item.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${E2E.OUT}/shells-${width}-${scheme}-1-feed.png` });

  step = "其他方式 → 使用說明";
  await item.getByRole("button", { name: "其他方式" }).click();
  const section = page.locator("#side-panel #help-unavailable");
  await section.waitFor({ timeout: 10000 });
  await page.waitForTimeout(400);
  const helpText = await section.innerText();
  check.helpSection = helpText.includes("Garmin 的個人 API") && helpText.includes("手動記") && helpText.includes("健康資料");
  check.helpScrolled = await section.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return r.top >= 0 && r.top < window.innerHeight;
  });
  await page.screenshot({ path: `${E2E.OUT}/shells-${width}-${scheme}-2-help.png` });

  step = "手動記一趟";
  await openFeed(page);
  await page.locator('.feed-item[data-kind="unavailable"]').getByRole("button", { name: "手動記一趟" }).click();
  await page.getByRole("button", { name: /手動記一趟/ }).first().waitFor({ timeout: 10000 });
  check.manualGoesToReport = (await page.getByRole("button", { name: /手錶沒記到？手動記一趟/ }).count()) === 1;

  step = "紀錄頁";
  await E2E.go(page, "紀錄");
  const rows = page.locator("ul.runs > li");
  await rows.first().waitFor({ timeout: 10000 });
  const rowTexts = (await rows.locator(".run-row").allInnerTexts()).map((t) => t.replace(/\s+/g, " "));
  console.log("ROWS", rowTexts.join(" || "));
  // 今天的 10 km（之前存的，現在 Intervals.icu 只給空殼）還在、三天前的 COROS 還在；空殼沒有變成 0 公里的紀錄
  check.storedRunKept = rowTexts.length === 2 && rowTexts.some((t) => /10(\.0)? km/.test(t));
  check.noZeroKm = rowTexts.every((t) => !/(^|\s)0(\.0+)? km/.test(t));
  await page.screenshot({ path: `${E2E.OUT}/shells-${width}-${scheme}-3-history.png` });

  step = "收起";
  await openFeed(page);
  await page.locator('.feed-item[data-kind="unavailable"] .feed-dismiss').click();
  check.dismissed = (await page.locator('.feed-item[data-kind="unavailable"]').count()) === 0;
  await page.reload();
  await page.locator("nav.tabbar button, nav.sidebar button").first().waitFor({ timeout: 15000 });
  await openFeed(page);
  check.staysDismissedToday = (await page.locator('.feed-item[data-kind="unavailable"]').count()) === 0;

  step = "回到平常";
  await shells("off");
  await syncNow(page);
  await openFeed(page);
  const restore = page.getByRole("button", { name: /顯示略過的/ });
  if (await restore.count()) await restore.click();
  check.goneAfterNormalSync = (await page.locator('.feed-item[data-kind="unavailable"]').count()) === 0;

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
  if (failPage) await failPage.screenshot({ path: `${E2E.OUT}/shells-fail.png`, fullPage: true }).catch(() => undefined);
  await shells("off").catch(() => undefined);
  process.exit(1);
});
