// 用 Intervals.icu 登入（規格 12.37，OAuth；9.4 工作單「新手的第一步」第 1 項）。模擬上游扮演 Intervals.icu 的授權頁與換 token，
// 同步服務（模擬上游的 /sync）轉送換 token；不連真的 Intervals.icu。
// A. 手機淺色、設定精靈：紀錄從哪裡來 → 連接 Intervals.icu → 「用 Intervals.icu 登入」（貼 API key 收在「進階」）→ 授權頁收到的參數
//    （client_id、回呼網址是網站的根目錄、只有讀的權限、state、response_type）→ 回來時網址上的 code 與 state 已清掉 →
//    「已用 Intervals.icu 登入：名字」→ 抓紀錄用 Bearer 讀到活動、恢復資料與設定 → token 只在這台（存在設定，不在同步的資料裡）→
//    設定的「訓練紀錄」：已連接 → 中斷連結（Intervals.icu 收到取消、token 刪掉、按鈕回來）
// B. 電腦深色、設定頁：在 Intervals.icu 按了不同意 → 看得懂的錯誤、沒有換 token；state 對不上（別的分頁的回呼）→ 不換、網址清掉；
//    登入成功 → 開密碼鎖 → token 加密（明文的設定裡沒有）→ 重新整理、解鎖後仍是登入的
// 截圖（intervals-login-*）。這個腳本自己建置一份（4181 埠：onboarding、client_id mock-client、授權頁指向模擬上游）；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4181;
const APP_URL = `http://localhost:${PORT}/`;
const OUT = E2E.OUT;
const SCOPES = "ACTIVITY:READ,WELLNESS:READ,SETTINGS:READ";

function build() {
  const outDir = path.join(OUT, "dist-intervals-login");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_INTERVALS_OAUTH_URL: `${E2E.MOCK}/intervals/oauth/authorize`,
      VITE_INTERVALS_CLIENT_ID: "mock-client",
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

const oauth = async () => (await fetch(`${E2E.MOCK}/_mock/oauth`)).json();
const storedSettings = (page) => page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1") ?? "{}"));

async function newPage(browser, problems, { width, height, scheme }, { skipWizard = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, isMobile: width < 600, hasTouch: width < 600 });
  if (skipWizard) await E2E.skipWizard(context);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  await page.goto(APP_URL);
  return page;
}

(async () => {
  const outDir = build();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  let step = "start";
  try {
    // ---------- A. 精靈裡登入 ----------
    step = "A 精靈";
    let page = await newPage(browser, problems, { width: 390, height: 844, scheme: "light" });
    await page.getByRole("button", { name: "開始設定" }).click();
    await page.locator("label.choice", { hasText: "手錶" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.locator("label.choice", { hasText: "Anthropic" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByLabel("API key", { exact: true }).fill("mock-key");
    await page.getByText("可以用，已存在這個瀏覽器").waitFor({ timeout: 10000 });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByRole("button", { name: "同意並繼續" }).click();
    await page.locator(".wizard-page[data-step=source]").waitFor();
    await page.locator("label.choice", { hasText: "連接 Intervals.icu" }).click();
    const login = page.getByRole("button", { name: "用 Intervals.icu 登入" });
    check.loginButton = await login.isVisible();
    const keyDetails = page.locator(".wizard-page details", { hasText: "用 API key 連接（進階）" });
    check.apiKeyInAdvanced = (await keyDetails.count()) === 1 && !(await keyDetails.evaluate((d) => d.open));
    check.continueNeedsLogin = await page.getByRole("button", { name: "繼續" }).isDisabled();
    await page.screenshot({ path: `${OUT}/intervals-login-1-source-390-light.png`, fullPage: true });
    const before = await oauth();
    await login.click();
    await page.getByText("已用 Intervals.icu 登入：Mock Runner").waitFor({ timeout: 20000 });
    const after = await oauth();
    const q = after.authorize.at(-1) ?? {};
    check.authorizeParams =
      q.client_id === "mock-client" && q.redirect_uri === APP_URL && q.scope === SCOPES && q.response_type === "code" && (q.state ?? "").length >= 20;
    check.exchangedOnce = after.exchanges === before.exchanges + 1;
    check.urlCleaned = !page.url().includes("code=") && !page.url().includes("state=");
    check.backInWizardSource = (await page.locator(".wizard-page[data-step=source]").count()) === 1;
    const s = await storedSettings(page);
    check.tokenStoredHere = s.intervals?.accessToken === "mock-oauth-token" && s.intervals?.account?.id === "i777";
    check.continueAfterLogin = await page.getByRole("button", { name: "繼續" }).isEnabled();
    await page.screenshot({ path: `${OUT}/intervals-login-2-connected-390-light.png`, fullPage: true });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByRole("button", { name: "同步最近 14 天" }).click();
    await page.getByText("抓好了，教練會看").waitFor({ timeout: 30000 });
    const paths = (await oauth()).bearerPaths;
    check.bearerReads =
      paths.some((p) => p.endsWith("/activities")) && paths.some((p) => p.endsWith("/wellness")) && paths.some((p) => /\/athlete\/i777$/.test(p));
    check.usesTokenAthlete = paths.every((p) => p.startsWith("/intervals/athlete/i777"));
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByRole("button", { name: "略過，開始用" }).click();
    await page.locator(".tabbar").waitFor();
    // 設定的訓練紀錄：已連接、可以中斷連結
    step = "A 中斷連結";
    await E2E.settings(page, "訓練紀錄");
    const panel = page.locator("#side-panel");
    check.settingsShowsLogin = await panel.getByText("已用 Intervals.icu 登入：Mock Runner").isVisible();
    await page.screenshot({ path: `${OUT}/intervals-login-3-settings-390-light.png`, fullPage: true });
    const disconnects = (await oauth()).disconnects;
    await panel.getByRole("button", { name: "中斷連結" }).click();
    await panel.getByRole("button", { name: "用 Intervals.icu 登入" }).waitFor({ timeout: 10000 });
    check.disconnectCalled = (await oauth()).disconnects === disconnects + 1;
    const cleared = await storedSettings(page);
    check.tokenDeleted = cleared.intervals?.accessToken === "" && cleared.intervals?.account === null;
    await panel.locator(".back-button").click();
    check.rowNotConnected = (await panel.locator(".settings-list").innerText()).includes("還沒連接");
    await page.context().close();

    // ---------- B. 設定頁：拒絕、state 對不上、成功、密碼鎖 ----------
    step = "B 拒絕";
    page = await newPage(browser, problems, { width: 1280, height: 860, scheme: "dark" }, { skipWizard: true });
    await page.locator(".tabbar").waitFor();
    await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });
    await E2E.settings(page, "訓練紀錄");
    let panelB = page.locator("#side-panel");
    // Intervals.icu 的授權頁：當成選手按了不同意
    await page.route(`${E2E.MOCK}/intervals/oauth/authorize**`, (route) => {
      const u = new URL(route.request().url());
      const back = new URL(u.searchParams.get("redirect_uri"));
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", u.searchParams.get("state"));
      return route.fulfill({ status: 302, headers: { location: back.toString() } });
    });
    const ex0 = (await oauth()).exchanges;
    await panelB.getByRole("button", { name: "用 Intervals.icu 登入" }).click();
    await page.locator("#side-panel").getByText("你在 Intervals.icu 沒有按同意").waitFor({ timeout: 20000 });
    check.deniedMessage = true;
    check.deniedNoExchange = (await oauth()).exchanges === ex0;
    check.deniedUrlCleaned = !page.url().includes("error=");
    await page.screenshot({ path: `${OUT}/intervals-login-4-denied-1280-dark.png`, fullPage: true });
    await page.unroute(`${E2E.MOCK}/intervals/oauth/authorize**`);

    step = "B state";
    await page.goto(`${APP_URL}?code=mock-code-x&state=not-mine`);
    await page.locator("#side-panel").getByText("登入沒有完成").waitFor({ timeout: 20000 });
    check.badStateRejected = (await oauth()).exchanges === ex0 && !page.url().includes("code=");

    step = "B 成功";
    panelB = page.locator("#side-panel");
    await panelB.getByRole("button", { name: "用 Intervals.icu 登入" }).click();
    await page.locator("#side-panel").getByText("已用 Intervals.icu 登入：Mock Runner").waitFor({ timeout: 20000 });
    check.settingsLogin = true;
    check.apiKeyInSettingsAdvanced = (await page.locator('#side-panel details.advanced').getByLabel("API key", { exact: true }).count()) === 1;
    await page.screenshot({ path: `${OUT}/intervals-login-5-settings-1280-dark.png`, fullPage: true });

    step = "B 密碼鎖";
    await E2E.settings(page, "密碼鎖");
    const lockCard = page.locator('#side-panel .subpage[data-section="lock"] section.card');
    await lockCard.getByLabel("密碼", { exact: true }).fill("correct horse");
    await lockCard.getByLabel("再輸入一次", { exact: true }).fill("correct horse");
    await lockCard.getByRole("button", { name: "啟用密碼鎖" }).click();
    await lockCard.getByRole("button", { name: "停用密碼鎖" }).waitFor({ timeout: 30000 });
    const plain = await storedSettings(page);
    const sealed = await page.evaluate(() => localStorage.getItem("running-coach.lock.v1") ?? "");
    check.tokenEncrypted = plain.intervals?.accessToken === "" && !sealed.includes("mock-oauth-token") && sealed.length > 0;
    await page.reload();
    await page.getByLabel("密碼").fill("correct horse");
    await page.getByRole("button", { name: "解鎖" }).click();
    await page.locator(".tabbar").waitFor({ timeout: 30000 });
    await E2E.settings(page, "訓練紀錄");
    check.stillLoggedInAfterUnlock = await page.locator("#side-panel").getByText("已用 Intervals.icu 登入：Mock Runner").isVisible();
    await page.context().close();
  } catch (e) {
    problems.push(`例外（${step}）：${e instanceof Error ? e.stack : String(e)}`);
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
