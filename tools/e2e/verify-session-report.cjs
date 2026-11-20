// 驗證沒有紀錄的課的回報（規格 12.48，功能開關 report）：
// - 「回報」分頁的「課表上的課做了嗎？」列出今天（與最近幾天）還沒回報、也沒有手錶紀錄的課
// - 肌力課從課卡「回報」：做到多少（做了一部分）、花了多久（預設課表的時間）、體感、備註 → 課卡標「部分達成」與備註、「修改回報」
// - 回報後「回報」分頁不再列那堂；紀錄頁列出「肌力訓練」（標「手動」，點開看備註）
// - 開始同步，另一台用復原碼還原：課卡的結果與備註、紀錄頁都看得到
// - 取消回報後在對話說「肌力做完了，體感 5，棒式少做一組」→ 教練記下（report_session），課卡看得到
// - 開關關著的建置（E2E_URL，4173）：課卡照舊是「做完了」、「回報」分頁沒有那一塊
// - 設計：emoji、每張卡最多一顆實心按鈕、按鈕高度、不左右捲動；手機淺色與電腦深色的截圖（session-report-*）
// 這個腳本自己建置一份開著 multisport、report 的（$E2E_OUT 底下），用 4188 埠開 vite preview；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4188;
const URL = `http://localhost:${PORT}/`;
const taipei = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
const TODAY = taipei(new Date());

let step = "start";

function build() {
  const outDir = path.join(E2E.OUT, "dist-session-report");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_FEATURES: "multisport,report",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(URL)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${PORT} 開起來`);
}

/** 設計準則的檢查：emoji、每張卡最多一顆實心按鈕、看得到的按鈕高度至少 44、不左右捲動 */
function designOf(page) {
  return page.evaluate(() => {
    const emoji = /\p{Extended_Pictographic}/u.test(document.querySelector("main")?.innerText ?? "");
    const cards = [...document.querySelectorAll("main section.card, main .plan-session")];
    const primaries = cards.filter((c) => [...c.querySelectorAll("button.primary")].filter((b) => b.offsetParent && b.closest("section.card, .plan-session") === c).length > 1).length;
    const small = [...document.querySelectorAll("main .session-report button, main .unreported button")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 43.5).map((b) => b.innerText);
    return { emoji, primaries, small, overflow: document.documentElement.scrollWidth > window.innerWidth };
  });
}

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const open = async (name, mobile, url = URL) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${name} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    await page.goto(url);
    await page.locator("nav.tabbar button").first().waitFor();
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
  const strengthCard = (page) => page.locator(`.tl-day[data-date="${TODAY}"] .plan-session`, { has: page.locator(".plan-session-name", { hasText: "今天的肌力" }) }).first();
  const expand = async (c) => {
    const head = c.locator(".plan-session-head");
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  };
  const until = async (fn, times = 40) => {
    for (let i = 0; i < times; i++) {
      if (await fn().catch(() => false)) return true;
      await new Promise((r) => setTimeout(r, 250));
    }
    return false;
  };
  const syncCard = (page) => page.locator('#side-panel .subpage[data-section="sync"] section.card');

  let server = null;
  try {
    step = "建置";
    server = await serve(build());
  } catch (e) {
    problems.push(`[build] ${e.message.split("\n")[0]}`);
  }

  if (server) {
    const A = await open("A", true);
    const B = await open("B", false);
    try {
      step = "A：設定、排課表";
      await E2E.setupMock(A.page, { mock: E2E.MOCK, timeZone: "Asia/Taipei" });
      await send(A.page, "幫我排這週的課表");

      step = "回報分頁列出沒回報的課";
      await E2E.go(A.page, "回報");
      const list = A.page.locator("#report-sessions");
      await list.waitFor({ timeout: 10000 });
      check.listed = (await list.locator("li", { hasText: "今天的肌力" }).count()) === 1;
      check.listedToday = (await list.locator("li", { hasText: "今天的肌力" }).innerText()).includes("今天");
      await A.page.screenshot({ path: `${E2E.OUT}/session-report-list-390-light.png`, fullPage: true });

      step = "課卡回報";
      await E2E.go(A.page, "計畫");
      const card = strengthCard(A.page);
      await card.waitFor({ timeout: 10000 });
      await expand(card);
      await card.getByRole("button", { name: "回報", exact: true }).click();
      const form = card.locator("form.session-report");
      await form.waitFor();
      check.defaultMinutes = (await form.getByLabel("花了多久（分）").inputValue()) === "20";
      check.noDistanceForStrength = (await form.getByLabel(/距離/).count()) === 0;
      await form.getByRole("group", { name: "做到多少" }).getByRole("button", { name: "做了一部分" }).click();
      await form.getByLabel("花了多久（分）").fill("25");
      await form.getByRole("button", { name: "體感 6", exact: true }).click();
      await form.getByLabel("備註").fill("棒式撐不到 30 秒");
      const design = await designOf(A.page);
      check.designForm = !design.emoji && design.primaries === 0 && !design.small.length && !design.overflow;
      if (!check.designForm) problems.push(`[A 設計] ${JSON.stringify(design)}`);
      await card.screenshot({ path: `${E2E.OUT}/session-report-form-390-light.png` });
      await form.getByRole("button", { name: "存起來" }).click();
      check.badgePartial = await until(async () => (await card.locator(".badge").first().innerText()) === "部分達成");
      check.noteShown = await until(async () => (await card.innerText()).includes("備註：棒式撐不到 30 秒"));
      check.actualShown = (await card.innerText()).includes("實際：25 分鐘、體感 6");
      check.editButton = (await card.getByRole("button", { name: "修改回報" }).count()) === 1;
      await card.screenshot({ path: `${E2E.OUT}/session-report-card-390-light.png` });

      step = "回報分頁不再列";
      await E2E.go(A.page, "回報");
      await A.page.waitForTimeout(500);
      check.notListedAfter = (await A.page.locator("#report-sessions li", { hasText: "今天的肌力" }).count()) === 0;

      step = "紀錄頁";
      await E2E.go(A.page, "紀錄");
      const row = A.page.locator("li.other", { hasText: "肌力訓練" }).first();
      await row.waitFor({ timeout: 10000 });
      check.historyManual = (await row.locator(".badge", { hasText: "手動" }).count()) === 1 && (await row.innerText()).includes("25 分鐘");
      await row.locator("button.run-row").click();
      check.historyNote = (await row.innerText()).includes("備註：棒式撐不到 30 秒");
      await A.page.screenshot({ path: `${E2E.OUT}/session-report-history-390-light.png`, fullPage: true });

      step = "A 開始同步";
      await E2E.settings(A.page, "多裝置同步");
      await syncCard(A.page).getByRole("button", { name: "這是第一台：開始同步" }).click();
      const recovery = (await syncCard(A.page).locator(".recovery-code").innerText()).trim();
      await syncCard(A.page).getByLabel("我已經把復原碼存好了").check();
      await syncCard(A.page).getByRole("button", { name: "開始同步" }).click();
      await syncCard(A.page).getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
      await A.page.locator("#side-panel .back-button").click().catch(() => {});

      step = "B 用復原碼還原";
      await E2E.settings(B.page, "多裝置同步");
      await syncCard(B.page).getByRole("button", { name: "用復原碼還原" }).click();
      await syncCard(B.page).getByLabel("復原碼").fill(recovery);
      await syncCard(B.page).getByRole("button", { name: "還原" }).click();
      await syncCard(B.page).getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
      await B.page.locator("#side-panel .back-button").click().catch(() => {});
      await E2E.go(B.page, "計畫");
      const bCard = strengthCard(B.page);
      await bCard.waitFor({ timeout: 10000 });
      await expand(bCard);
      check.bBadge = await until(async () => (await bCard.locator(".badge").first().innerText()) === "部分達成");
      check.bNote = (await bCard.innerText()).includes("備註：棒式撐不到 30 秒");
      await bCard.screenshot({ path: `${E2E.OUT}/session-report-card-1280-dark.png` });
      await E2E.go(B.page, "紀錄");
      const bRow = B.page.locator("li.other", { hasText: "肌力訓練" }).first();
      check.bHistory = await until(async () => (await bRow.locator(".badge", { hasText: "手動" }).count()) === 1);
      const bDesign = await designOf(B.page);
      check.bNoOverflow = !bDesign.overflow && !bDesign.emoji;
      await B.page.screenshot({ path: `${E2E.OUT}/session-report-history-1280-dark.png`, fullPage: true });

      step = "取消回報";
      await E2E.go(A.page, "計畫");
      const again = strengthCard(A.page);
      await again.waitFor({ timeout: 10000 });
      await expand(again);
      await again.getByRole("button", { name: "修改回報" }).click();
      const editForm = again.locator("form.session-report");
      check.editPrefilled = (await editForm.getByLabel("備註").inputValue()) === "棒式撐不到 30 秒" && (await editForm.getByLabel("花了多久（分）").inputValue()) === "25";
      await editForm.getByRole("button", { name: "取消回報" }).click();
      await editForm.getByRole("button", { name: "確定取消回報" }).click();
      check.cancelled = await until(async () => (await again.getByRole("button", { name: "回報", exact: true }).count()) === 1);

      step = "對話：教練幫忙記";
      await send(A.page, "肌力做完了，體感 5，棒式少做一組");
      const reply = await A.page.locator(".bubble.assistant").last().innerText();
      check.coachRecorded = reply.includes("已記下「今天的肌力」的回報") && reply.includes("棒式少做一組");
      await E2E.go(A.page, "計畫");
      const after = strengthCard(A.page);
      await after.waitFor({ timeout: 10000 });
      await expand(after);
      check.coachCard = await until(async () => (await after.innerText()).includes("備註：棒式少做一組") && (await after.locator(".badge").first().innerText()) === "部分達成");
    } catch (e) {
      problems.push(`[${step}] ${e.message.split("\n")[0]}`);
      await A.page.screenshot({ path: `${E2E.OUT}/session-report-fail-A.png`, fullPage: true }).catch(() => {});
      await B.page.screenshot({ path: `${E2E.OUT}/session-report-fail-B.png`, fullPage: true }).catch(() => {});
    }
    await A.context.close();
    await B.context.close();
    server.kill();
  }

  // 開關關著的一般建置（4173）：照舊
  {
    const C = await open("C", true, E2E.URL);
    try {
      step = "開關關著";
      await E2E.setupMock(C.page, { mock: E2E.MOCK, timeZone: "Asia/Taipei" });
      await E2E.go(C.page, "回報");
      await C.page.waitForTimeout(800);
      check.offNoList = (await C.page.locator("#report-sessions").count()) === 0;
    } catch (e) {
      problems.push(`[off ${step}] ${e.message.split("\n")[0]}`);
    }
    await C.context.close();
  }

  await browser.close();
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
})();
