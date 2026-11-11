// 免費試用（邀請碼，規格 12.39；功能開關 trial）：網頁版 → 真的代理（apps/proxy 的 Node 版）→ 模擬上游.
// A. 手機淺色：設定精靈選「免費試用（邀請碼）」→ 錯的邀請碼看到說明 → 對的啟用 → 資料流向寫「不保存對話的內容」→
//    同意 → 手動記第一筆（跑後分析算自動的次數，不扣則數）→ 對話：「今天還剩 3 則」→ 一則會跑工具迴圈的訊息只扣一則 →
//    用完時輸入框換成「今天的 3 則用完了，明天 00:00（台灣時間）恢復。也可以改用自己的 API key。」＋前往設定
//    送到上游的模型是 Claude Haiku、思考強度 low（不送 thinking，規格 12.43）；請求裡看不到選手的 key
// B. 電腦深色：設定的「AI 教練」→ 免費試用 → 貼邀請碼 → 已啟用、模型固定、今天還剩幾則 → 同意後存 → 對話可以聊
//    → 總預算用完（重開代理，總預算設得很小）→ 對話頁「這個月的免費額度用完了」→ 在另一台使用：連結碼 → 手機輸入 →
//    同一個帳號的兩台 → 手機移除電腦 → 電腦查不到用量 → 刪除試用帳號（代理那邊的帳號也刪掉）
// C. 沒開 trial 的建置（共用的 4173）：設定看不到免費試用（由 verify-design 等既有腳本的建置檢查，這裡只看選項）
// 每一頁：最多一顆主要按鈕、不左右捲動；截圖（trial-*）
// 這個腳本自己建置一份開著 onboarding 與 trial 的（4181 埠），自己開代理（8791 埠）；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4181;
const PROXY_PORT = 8791;
const APP_URL = `http://localhost:${PORT}/`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const ADMIN = "e2e-admin";
const OUT = E2E.OUT;
const DB = path.join(OUT, "trial-proxy.db");

function build() {
  const outDir = path.join(OUT, "dist-trial");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_FEATURES: "onboarding,trial",
      VITE_PROXY_URL: PROXY_URL,
    },
  });
  return outDir;
}

async function waitFor(url) {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} 沒有開起來`);
}

async function serveWeb(outDir) {
  // 自己一個行程群組：結束時連 npx 底下的 vite 一起關掉
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore", detached: true });
  await waitFor(APP_URL);
  return child;
}

/** 代理的 Node 版，上游是模擬服務；policy 覆寫政策（每天 3 則，方便用完） */
async function startProxy(policy) {
  const child = spawn("npx", ["tsx", "apps/proxy/src/node.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      ADMIN_TOKEN: ADMIN,
      ANTHROPIC_API_KEY: "operator-key-e2e",
      UPSTREAM_BASE_URL: E2E.MOCK,
      ALLOWED_ORIGINS: `http://localhost:${PORT}`,
      PROXY_DB_PATH: DB,
      PROXY_POLICY: JSON.stringify(policy),
    },
  });
  await waitFor(`${PROXY_URL}/healthz`);
  return child;
}

/** 關掉整個行程群組（npx 與它底下的 node） */
async function stop(child) {
  if (child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // 已經結束了
  }
  await done;
  // 埠放出來之前不要開下一個
  await new Promise((r) => setTimeout(r, 300));
}
const stopProxy = stop;

async function admin(method, p, body) {
  const response = await fetch(`${PROXY_URL}${p}`, { method, headers: { authorization: `Bearer ${ADMIN}` }, body: body ? JSON.stringify(body) : undefined });
  return response.json();
}

const requests = async () => (await fetch(`${E2E.MOCK}/_mock/requests`)).json();

async function newPage(browser, problems, { width, height, scheme }, init) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  await page.goto(APP_URL);
  return page;
}

/** 最多一顆主要按鈕、不左右捲動 */
async function design(page) {
  return page.evaluate(() => {
    const visible = (el) => el.getBoundingClientRect().height > 0;
    const scope = document.querySelector(".wizard") ?? document.querySelector("#side-panel:not([hidden])") ?? document;
    const primaries = [...scope.querySelectorAll("button.primary")].filter(visible).length;
    const scroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    return primaries <= 1 && !scroll;
  });
}

async function remaining(page) {
  const line = page.locator(".trial-remaining");
  await line.waitFor({ timeout: 15000 });
  return line.innerText();
}

/** 送一則，等教練回完（輸入框回到「送出」） */
async function send(page, text) {
  await page.getByLabel("訊息").fill(text);
  await page.getByRole("button", { name: "送出" }).click();
  // 先等送出開始（按鈕變成「停止」），再等回覆完成；不然還沒送出就以為完成了
  await page.getByRole("button", { name: "停止" }).waitFor({ timeout: 10000 }).catch(() => undefined);
  await page.getByRole("button", { name: "停止" }).waitFor({ state: "detached", timeout: 30000 });
}

(async () => {
  fs.rmSync(DB, { force: true });
  const outDir = build();
  const web = await serveWeb(outDir);
  let proxy = await startProxy({ dailyMessages: 3 });
  const browser = await chromium.launch();
  const check = {};
  const problems = [];
  const designOk = [];

  try {
    const { invites } = await admin("POST", "/admin/invites", { count: 2, label: "E2E" });
    const [codeA, codeB] = invites.map((i) => i.code);

    // ---------- A. 手機淺色：設定精靈 ----------
    let page = await newPage(browser, problems, { width: 390, height: 844, scheme: "light" });
    await page.getByRole("button", { name: "開始設定" }).click();
    await page.locator("label.choice", { hasText: "沒有在記錄" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    check.trialFirstChoice = (await page.locator("label.choice").first().innerText()).includes("免費試用（邀請碼）");
    await page.locator("label.choice", { hasText: "免費試用" }).click();
    await page.screenshot({ path: `${OUT}/trial-1-provider-390-light.png`, fullPage: true });
    await page.getByRole("button", { name: "繼續" }).click();
    check.inviteTitle = (await page.locator(".wizard-page .title").innerText()) === "輸入邀請碼";
    check.continueDisabledWithoutCode = await page.getByRole("button", { name: "繼續" }).isDisabled();
    designOk.push(["wizard-invite-empty", await design(page)]);
    await page.getByRole("textbox", { name: "邀請碼" }).fill("RC-2222-3333-4444");
    await page.getByRole("button", { name: "啟用" }).click();
    check.wrongCode = (await page.locator(".field-error").innerText({ timeout: 10000 })).includes("找不到這個邀請碼");
    await page.getByRole("textbox", { name: "邀請碼" }).fill(codeA.toLowerCase());
    await page.getByRole("button", { name: "啟用" }).click();
    await page.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    await page.screenshot({ path: `${OUT}/trial-2-invite-390-light.png`, fullPage: true });
    designOk.push(["wizard-invite", await design(page)]);
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")));
    check.storedOnDevice = stored.llmMode === "proxy" && /^rc_/.test(stored.proxy.token) && stored.proxy.url === "http://127.0.0.1:8791" && stored.models.chat === "claude-haiku-5-5";
    await page.getByRole("button", { name: "繼續" }).click();
    const flow = await page.locator(".wizard-page").innerText();
    check.dataFlow = flow.includes("經過 Zone2Mate 的代理") && flow.includes("不保存對話的內容") && flow.includes("只記次數與用量");
    await page.screenshot({ path: `${OUT}/trial-3-consent-390-light.png`, fullPage: true });
    await page.getByRole("button", { name: "同意並繼續" }).click();
    await page.locator("label.choice", { hasText: "手動記" }).click();
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByLabel("距離（km）").fill("5");
    await page.getByLabel("分鐘").fill("35");
    await page.getByRole("button", { name: "體感 3", exact: true }).click();
    await page.getByRole("button", { name: "存起來" }).click();
    await page.getByText("記好了，教練會看").waitFor({ timeout: 30000 });
    await page.getByRole("button", { name: "繼續" }).click();
    await page.getByRole("button", { name: "略過，開始用" }).click();
    await page.locator(".tabbar").waitFor();

    // 跑後分析算自動的分析，不扣則數
    check.startsWithThree = (await remaining(page)) === "今天還剩 3 則";
    const accountsAfterRun = (await admin("GET", "/admin/accounts")).accounts;
    check.autoCounted = accountsAfterRun.length === 1 && accountsAfterRun[0].today.auto === 1 && accountsAfterRun[0].today.messages === 0;

    // 模擬服務只留最近 50 筆：用這次訊息的內容找出這次的請求
    await send(page, "幫我看一下這週的課表");
    const chatCalls = (await requests()).filter((r) => r.kind === "llm" && JSON.stringify(r.body.messages).includes("幫我看一下這週的課表"));
    check.toolLoopRan = chatCalls.length >= 2;
    check.haikuLow = chatCalls.every((r) => r.body.model === "claude-haiku-5-5" && r.body.output_config?.effort === "low" && r.body.thinking === undefined);
    await page.locator(".trial-remaining", { hasText: "今天還剩 2 則" }).waitFor({ timeout: 10000 }).catch(() => undefined);
    check.oneMessageCounted = (await remaining(page)) === "今天還剩 2 則";
    if (!check.oneMessageCounted || !check.toolLoopRan) console.log(`debug: ${await remaining(page)} calls=${chatCalls.length} total=${(await requests()).length} last=${JSON.stringify((await requests()).slice(-3).map((r) => [r.kind, r.body.model, JSON.stringify(r.body.messages ?? "").slice(-120)]))}`);
    await page.screenshot({ path: `${OUT}/trial-4-chat-390-light.png`, fullPage: true });
    await send(page, "明天練什麼？");
    check.lowColor = await page.locator(".trial-remaining.low").isVisible();
    await send(page, "謝謝");
    const out = page.locator(".trial-out");
    await out.waitFor({ timeout: 15000 });
    const outText = await out.innerText();
    check.outNotice = outText.includes("今天的 3 則用完了，明天 00:00（台灣時間）恢復。") && outText.includes("也可以改用自己的 API key");
    check.noComposerWhenOut = (await page.getByLabel("訊息").count()) === 0;
    check.toSettings = await out.getByRole("button", { name: "前往設定" }).isVisible();
    await page.screenshot({ path: `${OUT}/trial-5-out-390-light.png`, fullPage: true });
    designOk.push(["chat-out", await design(page)]);
    await page.context().close();

    // ---------- B. 電腦深色：設定的「AI 教練」 ----------
    page = await newPage(browser, problems, { width: 1280, height: 860, scheme: "dark" }, () => {
      if (!localStorage.getItem("running-coach.wizard.v1")) localStorage.setItem("running-coach.wizard.v1", JSON.stringify({ done: true }));
    });
    await page.locator(".tabbar").waitFor();
    await page.getByRole("button", { name: "設定" }).first().click();
    await page.getByRole("button", { name: /AI 教練/ }).first().click();
    await page.getByRole("radio", { name: "免費試用（邀請碼）" }).check();
    check.noModelFieldsInTrial = (await page.getByText("主對話模型").count()) === 0;
    designOk.push(["settings-invite", await design(page)]);
    await page.getByRole("textbox", { name: "邀請碼" }).fill(codeB);
    await page.getByRole("button", { name: "啟用" }).click();
    await page.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    await page.locator(".trial-account .trial-remaining").waitFor({ timeout: 10000 });
    const panel = await page.locator(".trial-account").innerText();
    check.settingsModel = panel.includes("Claude Haiku 5.5") && panel.includes("少量思考") && !panel.includes("不思考");
    check.settingsRemaining = panel.includes("今天還剩 3 則（共 3 則");
    await page.getByLabel("我了解並同意以上的資料流向").check();
    await page.getByLabel("我已閱讀使用須知").check();
    await page.screenshot({ path: `${OUT}/trial-6-settings-1280-dark.png`, fullPage: true });
    designOk.push(["settings", await design(page)]);
    await page.getByRole("button", { name: "儲存" }).click();
    await page.getByText("設定已儲存在這個瀏覽器。").waitFor({ timeout: 10000 });
    await page.locator("#side-panel .side-panel-close").click();
    await page.getByRole("button", { name: "對話" }).first().click();
    await send(page, "嗨");
    await page.locator(".trial-remaining", { hasText: "今天還剩 2 則" }).waitFor({ timeout: 10000 }).catch(() => undefined);
    check.desktopChat = (await remaining(page)) === "今天還剩 2 則";
    await page.screenshot({ path: `${OUT}/trial-7-chat-1280-dark.png`, fullPage: true });

    // 總預算用完：重開代理，總預算設得很小（已經用掉的比它多）
    await stopProxy(proxy);
    proxy = await startProxy({ dailyMessages: 3, totalMonthlyBudgetUsd: 0.000001 });
    await page.reload();
    await page.locator(".tabbar").waitFor();
    await page.getByRole("button", { name: "對話" }).first().click();
    const paused = page.locator(".trial-out");
    await paused.waitFor({ timeout: 15000 });
    check.betaBudgetNotice = (await paused.innerText()).includes("這個月的免費額度用完了（所有試用的人合計）");
    await page.screenshot({ path: `${OUT}/trial-8-budget-1280-dark.png`, fullPage: true });

    // 在另一台裝置使用：電腦要一個連結碼 → 手機輸入 → 同一個帳號的兩台；手機移除電腦
    await paused.getByRole("button", { name: "前往設定" }).click();
    await page.getByRole("button", { name: "在另一台使用" }).click();
    const linkText = await page.locator(".trial-link").innerText({ timeout: 10000 });
    const linkCode = /[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}/.exec(linkText)?.[0];
    check.linkCodeShown = !!linkCode && linkText.includes("用一次");
    await page.screenshot({ path: `${OUT}/trial-9-link-1280-dark.png`, fullPage: true });
    const phone = await newPage(browser, problems, { width: 390, height: 844, scheme: "light" }, () => {
      if (!localStorage.getItem("running-coach.wizard.v1")) localStorage.setItem("running-coach.wizard.v1", JSON.stringify({ done: true }));
    });
    await phone.locator(".tabbar").waitFor();
    await phone.getByRole("button", { name: "設定" }).first().click();
    await phone.getByRole("button", { name: /AI 教練/ }).first().click();
    await phone.getByRole("radio", { name: "免費試用（邀請碼）" }).check();
    await phone.getByRole("textbox", { name: "邀請碼" }).fill(linkCode ?? "");
    await phone.getByRole("button", { name: "啟用" }).click();
    await phone.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    const phoneDevices = phone.locator(".trial-devices li");
    await phoneDevices.nth(1).waitFor({ timeout: 10000 });
    check.twoDevices = (await phoneDevices.count()) === 2 && (await phoneDevices.nth(1).innerText()).includes("（這台）");
    check.sameAccount = (await admin("GET", "/admin/accounts")).accounts.length === 2;
    await phone.screenshot({ path: `${OUT}/trial-10-devices-390-light.png`, fullPage: true });
    await phoneDevices.nth(0).getByRole("button", { name: "移除" }).click();
    await phoneDevices.nth(1).waitFor({ state: "detached", timeout: 10000 });
    check.removedOther = (await phoneDevices.count()) === 1;

    // 電腦被移除了：它的憑證查不到用量
    const desktopToken = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")).proxy.token);
    check.removedDeviceRejected = (await fetch(`${PROXY_URL}/v1/usage`, { headers: { "x-api-key": desktopToken } })).status === 401;
    await page.context().close();
    page = phone;

    // 刪除試用帳號（手機）
    await page.getByRole("button", { name: "刪除試用帳號" }).click();
    await page.getByRole("textbox", { name: "邀請碼" }).waitFor({ timeout: 10000 });
    const accounts = (await admin("GET", "/admin/accounts")).accounts;
    check.accountDeleted = accounts.length === 1;
    const after = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")));
    check.tokenCleared = after.proxy.token === "";
    await page.context().close();

    // 送到上游的請求都用作者的 key，選手的憑證不會到上游
    const all = await requests();
    check.noTrialTokenUpstream = !JSON.stringify(all).includes(stored.proxy.token);

    for (const [name, ok] of designOk) check[`design-${name}`] = ok;
  } catch (e) {
    problems.push(`例外：${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    await browser.close();
    await stop(web);
    await stopProxy(proxy);
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
