// 設定精靈與先看看（規格 12.35 的 A、B，9.4 工作單「新手的第一步」；功能開關 onboarding）：
// A. 手機淺色：新的使用者第一頁（開始設定／先看看／在別台用過）→ 你用什麼記錄（手錶）→ 選 AI（Claude）→ 貼 key：
//    「去拿 key」直接開到產生 key 的那一頁、錯的 key 與沒有額度的 key 看到看得懂的錯誤、對的 key 馬上「可以用」並自動存
//    → 中途重新整理從同一步繼續 → 上一步 → 同意並繼續（兩項同意都記下版本與日期）→ Intervals.icu（API key 貼錯有錯誤、
//    對的連上了）→ 抓紀錄 → 略過選手資料 → 平常的對話頁、可以聊；重新整理後不再出現
// B. 電腦深色：沒有在記錄 → 手動記 → 記第一筆 → 填選手資料（到選手頁）
// C. 先看看：範例的標示一直在最上面、對話是預先寫好的範例（輸入框換成「開始設定後就能和教練聊」）、
//    課表、紀錄、看板、選手頁有範例的資料、設定不能改；整段沒有送出任何外部請求；「開始設定」後回到精靈，真的資料庫是空的
// D. 已經設定好的人（存過設定）打開不會看到精靈
// 每一頁檢查：最多一顆主要按鈕、按鈕至少 44 高、不左右捲動；手機淺色與電腦深色的截圖（wizard-*）
// 這個腳本自己建置一份開著 onboarding 的（4180 埠，Anthropic 指向模擬上游）；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4180;
const APP_URL = `http://localhost:${PORT}/`;
const OUT = E2E.OUT;

function build() {
  const outDir = path.join(OUT, "dist-wizard");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_ANTHROPIC_BASE_URL: E2E.MOCK,
      VITE_FEATURES: "onboarding",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(APP_URL)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${PORT} 開起來`);
}

const requests = async () => (await fetch(`${E2E.MOCK}/_mock/requests`)).json();

async function newPage(browser, problems, { width, height, scheme }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(APP_URL);
  return page;
}

/** 這一頁照設計準則：最多一顆主要按鈕、按鈕至少 44 高、不左右捲動 */
async function design(page) {
  return page.evaluate(() => {
    const visible = (el) => el.getBoundingClientRect().height > 0;
    const primaries = [...document.querySelectorAll(".wizard button.primary, main button.primary")].filter(visible).length;
    const short = [...document.querySelectorAll(".wizard button, .wizard a.button")].filter(visible).filter((b) => b.getBoundingClientRect().height < 43.5).length;
    const scroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    return primaries <= 1 && short === 0 && !scroll;
  });
}

const title = (page) => page.locator(".wizard-page .title").innerText();

(async () => {
  const outDir = build();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const designOk = [];
  try {
    // ---------- A. 手機淺色：手錶 → Claude → Intervals.icu ----------
    let page = await newPage(browser, problems, { width: 390, height: 844, scheme: "light" });
    await page.locator(".wizard-page[data-step=welcome]").waitFor();
    check.welcome = (await title(page)) === "Zone2Mate" && (await page.locator(".tabbar").count()) === 0;
    check.welcomeButtons =
      (await page.getByRole("button", { name: "開始設定" }).isVisible()) &&
      (await page.getByRole("button", { name: "先看看" }).isVisible()) &&
      (await page.getByRole("button", { name: "在別台用過？用同步帶過來" }).isVisible());
    designOk.push(["welcome", await design(page)]);
    await page.screenshot({ path: `${OUT}/wizard-1-welcome-390-light.png`, fullPage: true });

    await page.getByRole("button", { name: "開始設定" }).click();
    await page.locator(".wizard-page[data-step=record]").waitFor();
    check.recordDisabledFirst = await page.getByRole("button", { name: "繼續" }).isDisabled();
    await page.locator("label.choice", { hasText: "手錶" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=provider]").waitFor();
    check.stepCount = (await page.locator(".wizard-head").innerText()).includes("2 / 7");
    await page.locator("label.choice", { hasText: "Anthropic" }).click();
    designOk.push(["provider", await design(page)]);
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=key]").waitFor();
    check.keyLink = (await page.getByRole("link", { name: /去 Claude Console 拿 key/ }).getAttribute("href")) === "https://console.anthropic.com/settings/keys";
    check.keySteps = (await page.locator(".wizard-page ol.guide").innerText()).includes("Create Key");
    check.continueDisabledWithoutKey = await page.getByRole("button", { name: "繼續" }).isDisabled();
    const keyInput = page.getByLabel("API key", { exact: true });
    await keyInput.fill("bad-key");
    await page.locator(".field-error", { hasText: "key 不對" }).waitFor({ timeout: 10000 });
    check.badKeyError = true;
    await keyInput.fill("no-credit-key");
    await page.locator(".field-error", { hasText: "還沒有額度" }).waitFor({ timeout: 10000 });
    check.noCreditError = true;
    await page.screenshot({ path: `${OUT}/wizard-2-key-error-390-light.png`, fullPage: true });
    await keyInput.fill("mock-key");
    await page.getByText("可以用，已存在這個瀏覽器").waitFor({ timeout: 10000 });
    check.keyOk = await page.getByRole("button", { name: "繼續" }).isEnabled();
    const pings = (await requests()).filter((r) => r.kind === "llm" && JSON.stringify(r.body).includes('"ping"'));
    check.cheapCheck = pings.length > 0 && pings.every((r) => r.body.max_tokens === 16 && /haiku/.test(r.body.model) && !r.body.system);
    check.savedWithoutButton = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1") ?? "{}").apiKey === "mock-key");
    designOk.push(["key", await design(page)]);
    await page.screenshot({ path: `${OUT}/wizard-3-key-ok-390-light.png`, fullPage: true });

    // 中途重新整理：從同一步繼續
    await page.reload();
    await page.locator(".wizard-page[data-step=key]").waitFor();
    check.resumeSameStep = await page.getByText("可以用，已存在這個瀏覽器").isVisible();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=consent]").waitFor();
    // 上一步
    await page.getByRole("button", { name: "上一步" }).click();
    await page.locator(".wizard-page[data-step=key]").waitFor();
    check.back = true;
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=consent]").waitFor();
    check.consentContent =
      (await page.locator(".wizard-page").innerText()).includes("直接送到 Anthropic") &&
      (await page.locator(".wizard-page").getByRole("link", { name: "使用須知" }).count()) > 0 &&
      (await page.locator(".wizard-page").getByRole("link", { name: "隱私說明" }).count()) > 0;
    designOk.push(["consent", await design(page)]);
    await page.screenshot({ path: `${OUT}/wizard-4-consent-390-light.png`, fullPage: true });
    // 使用須知在面板打開，關掉後回到同一步
    await page.locator(".wizard-page").getByRole("link", { name: "使用須知" }).first().click();
    await page.locator("#side-panel .legal-page").waitFor();
    await page.locator("#side-panel .side-panel-close").click();
    await page.locator("#side-panel").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "同意並繼續" }).click();
    await page.locator(".wizard-page[data-step=source]").waitFor();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1") ?? "{}"));
    check.consentsRecorded = stored.consents?.includes("byok:anthropic") && stored.terms?.version >= 1 && /^\d{4}-\d{2}-\d{2}$/.test(stored.terms?.date ?? "");

    check.sourceWatchFirst = (await page.locator("label.choice").first().innerText()).includes("Intervals.icu");
    await page.locator("label.choice", { hasText: "連接 Intervals.icu" }).click();
    check.noLoginButtonWithoutConfig = (await page.getByRole("button", { name: /用 Intervals.icu 登入/ }).count()) === 0;
    const intervalsKey = page.locator(".wizard-page").getByLabel("API key", { exact: true });
    await intervalsKey.fill("bad-key");
    await page.locator(".field-error", { hasText: "key 不對" }).waitFor({ timeout: 10000 });
    check.intervalsBadKey = true;
    await intervalsKey.fill("mock-intervals-key");
    await page.getByText("連上了").waitFor({ timeout: 10000 });
    designOk.push(["source", await design(page)]);
    await page.screenshot({ path: `${OUT}/wizard-5-source-390-light.png`, fullPage: true });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=first]").waitFor();
    await page.getByRole("button", { name: "同步最近 14 天" }).click();
    await page.getByRole("button", { name: "繼續" }).waitFor({ timeout: 30000 });
    check.firstSync = (await page.locator(".wizard-page").innerText()).includes("抓好了，教練會看");
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=profile]").waitFor();
    designOk.push(["profile", await design(page)]);
    await page.getByRole("button", { name: "略過，開始用" }).click();
    await page.locator(".tabbar").waitFor();
    check.finishedToChat = await page.getByLabel("訊息").isVisible();
    await page.getByLabel("訊息").fill("你好");
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator(".bubble.assistant").last().waitFor({ timeout: 30000 });
    check.chatWorks = true;
    await page.reload();
    await page.locator(".tabbar").waitFor();
    check.noWizardAfterFinish = (await page.locator(".wizard").count()) === 0;
    await page.context().close();

    // ---------- B. 電腦深色：沒有在記錄 → 手動記 → 記第一筆 → 選手資料 ----------
    page = await newPage(browser, problems, { width: 1280, height: 860, scheme: "dark" });
    await page.getByRole("button", { name: "開始設定" }).click();
    await page.locator("label.choice", { hasText: "沒有在記錄" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator("label.choice", { hasText: "Anthropic" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByLabel("API key", { exact: true }).fill("mock-key");
    await page.getByText("可以用，已存在這個瀏覽器").waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${OUT}/wizard-6-key-1280-dark.png`, fullPage: true });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByRole("button", { name: "同意並繼續" }).click();
    await page.locator(".wizard-page[data-step=source]").waitFor();
    check.manualFirstForNoWatch = (await page.locator("label.choice").first().innerText()).includes("手動記");
    await page.locator("label.choice", { hasText: "手動記" }).click();
    await page.screenshot({ path: `${OUT}/wizard-7-source-1280-dark.png`, fullPage: true });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator(".wizard-page[data-step=first]").waitFor();
    check.manualTitle = (await title(page)) === "記第一筆";
    await page.getByLabel("距離（km）").fill("5");
    await page.getByLabel("分鐘").fill("35");
    await page.getByRole("button", { name: "體感 3", exact: true }).click();
    await page.screenshot({ path: `${OUT}/wizard-8-first-1280-dark.png`, fullPage: true });
    await page.getByRole("button", { name: "存起來" }).click();
    await page.getByText("記好了，教練會看").waitFor({ timeout: 30000 });
    check.manualSaved = true;
    designOk.push(["first", await design(page)]);
    await page.getByRole("button", { name: "繼續" }).click();
    await page.screenshot({ path: `${OUT}/wizard-9-profile-1280-dark.png`, fullPage: true });
    await page.getByRole("button", { name: "填選手資料" }).click();
    await page.locator(".tabbar").waitFor();
    check.toProfile = (await page.locator(".tabbar button[aria-current=true]").innerText()).includes("選手");
    await page.context().close();

    // ---------- C. 先看看 ----------
    for (const view of [
      { width: 390, height: 844, scheme: "light" },
      { width: 1280, height: 860, scheme: "dark" },
    ]) {
      const tag = `${view.width}-${view.scheme}`;
      page = await newPage(browser, problems, view);
      await page.locator(".wizard-page[data-step=welcome]").waitFor();
      const external = [];
      page.on("request", (r) => {
        const u = new URL(r.url());
        if (u.origin !== new URL(APP_URL).origin) external.push(r.url());
      });
      await page.getByRole("button", { name: "先看看" }).click();
      await page.locator(".demo-banner").waitFor({ timeout: 20000 });
      const banner = page.locator(".demo-banner");
      check[`demoBanner-${tag}`] = (await banner.innerText()).includes("這是範例") && (await banner.getByRole("button", { name: "開始設定" }).isVisible());
      // 對話：預先寫好的範例，輸入框換成說明
      await page.getByText("這週怎麼練？").first().waitFor();
      check[`demoChat-${tag}`] = (await page.locator(".bubble.assistant").count()) > 0 && (await page.getByLabel("訊息").count()) === 0 && (await page.getByText("開始設定後就能和教練聊").isVisible());
      await page.screenshot({ path: `${OUT}/wizard-demo-chat-${tag}.png`, fullPage: true });
      await E2E.go(page, "計畫");
      await page.locator(".plan-session").first().waitFor({ timeout: 10000 });
      check[`demoPlan-${tag}`] = (await page.locator(".demo-banner").isVisible()) && (await page.locator(".plan-session").count()) > 0;
      await page.screenshot({ path: `${OUT}/wizard-demo-plan-${tag}.png`, fullPage: true });
      await E2E.go(page, "紀錄");
      await page.locator("ul.runs > li").first().waitFor({ timeout: 10000 });
      check[`demoHistory-${tag}`] = (await page.locator("ul.runs > li").count()) > 5;
      await page.screenshot({ path: `${OUT}/wizard-demo-history-${tag}.png`, fullPage: true });
      await E2E.go(page, "選手");
      await page.getByText("明年三月完成第一場半馬").first().waitFor({ timeout: 10000 });
      check[`demoProfile-${tag}`] = await page.locator(".demo-banner").isVisible();
      await page.screenshot({ path: `${OUT}/wizard-demo-profile-${tag}.png`, fullPage: true });
      await E2E.go(page, "設定");
      check[`demoSettingsLocked-${tag}`] = await page.locator("#side-panel").getByText("範例裡不能改設定").isVisible();
      await page.locator("#side-panel .side-panel-close").click();
      await page.locator("#side-panel").waitFor({ state: "detached" });
      check[`demoNoRequests-${tag}`] = external.length === 0;
      if (external.length) problems.push(`先看看送出了外部請求：${external.join(" ")}`);
      // 開始設定：回到精靈，真的資料庫是空的
      await page.locator(".demo-banner").getByRole("button", { name: "開始設定" }).click();
      await page.locator(".wizard-page").waitFor({ timeout: 20000 });
      check[`demoEndsInWizard-${tag}`] = (await page.locator(".demo-banner").count()) === 0;
      await page.getByRole("button", { name: "在別台用過？用同步帶過來" }).click();
      await page.locator(".tabbar").waitFor();
      await page.locator("#side-panel .side-panel-close").click();
      await page.locator("#side-panel").waitFor({ state: "detached" });
      await E2E.go(page, "紀錄");
      await page.getByRole("button", { name: "記第一筆" }).waitFor();
      check[`realDbEmpty-${tag}`] = (await page.locator("ul.runs > li").count()) === 0;
      await E2E.go(page, "計畫");
      await E2E.go(page, "選手");
      check[`realProfileEmpty-${tag}`] = (await page.getByText("明年三月完成第一場半馬").count()) === 0;
      await page.context().close();
    }

    // ---------- D. 已經設定好的人不會看到 ----------
    {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(() => {
        if (!localStorage.getItem("running-coach.settings.v1")) localStorage.setItem("running-coach.settings.v1", JSON.stringify({ provider: "anthropic", apiKey: "mock-key" }));
      });
      page = await context.newPage();
      await page.goto(APP_URL);
      await page.locator(".tabbar").waitFor();
      check.oldUserNoWizard = (await page.locator(".wizard").count()) === 0;
      await page.reload();
      await page.locator(".tabbar").waitFor();
      check.oldUserStillNoWizard = (await page.locator(".wizard").count()) === 0;
      await context.close();
    }

    for (const [name, ok] of designOk) check[`design-${name}`] = ok;
  } catch (e) {
    problems.push(`例外：${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    await browser.close();
    server.kill();
  }

  let ok = true;
  for (const [name, value] of Object.entries(check)) {
    console.log(`${value ? "OK  " : "FAIL"} ${name}`);
    if (!value) ok = false;
  }
  for (const p of problems) console.log(`PROBLEM ${p}`);
  if (problems.length) ok = false;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
