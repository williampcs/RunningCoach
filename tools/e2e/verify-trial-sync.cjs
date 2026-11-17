// 免費試用的帳號掛進加密的同步（規格 12.44 第 1 步；功能開關 trial、devices、onboarding）：網頁版 → 真的代理（Node 版）＋模擬的同步服務.
// A. 電腦淺色：設定的「AI 教練」用邀請碼啟用免費試用 → 多裝置同步「這是第一台：開始同步」
// B. 手機淺色：精靈「在別台用過？用同步帶過來」→ 用復原碼還原 → 自動取回（提示「已取回免費試用」）：同一個帳號、自己的憑證、
//    裝置清單兩台；同意資料流向後對話 → 今天的則數兩台共用
// C. 電腦深色：先設好自己的 API key 再配對加入 → 不改設定；「AI 教練」有「在這台也用免費試用」，按了才取回
// D. A 在試用的裝置清單移除 B → B 不自動取回（顯示「重新取回」）；B 自己按「移除這台」→ 之後同步也不自動取回
// E. A 在同步移除 C（換金鑰）→ 復原密鑰換新：C 拿過的舊的被代理拒絕；B 在設定按「在這台使用」用新的取回得了；提醒到試用的裝置清單也移除
// F. A 刪除試用帳號 → 同步裡的紀錄刪掉：B 的「在這台也用免費試用」消失
// 每一頁：最多一顆主要按鈕、不左右捲動；截圖（trial-sync-*）
// 這個腳本自己開模擬上游（8799 埠，冷卻期 20 秒）、代理（8792 埠，每天 5 則）與建置（4184 埠）；不需要其他服務.
// 復原密鑰與憑證只在這個程序的記憶體裡比對，不印出來.
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4184;
const MOCK_PORT = 8799;
const PROXY_PORT = 8792;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const APP_URL = `http://localhost:${PORT}/`;
const PROXY_URL = `http://127.0.0.1:${PROXY_PORT}`;
const ADMIN = "e2e-admin";
const OUT = E2E.OUT;
const DB = path.join(OUT, "trial-sync-proxy.db");
const COOLDOWN_MS = 20_000;
const SETTINGS_KEY = "running-coach.settings.v1";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
};

let step = "start";

async function waitFor(url) {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(url)).status < 500) return;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${url} 沒有開起來`);
}

/** 關掉整個行程群組（npx 與它底下的 node） */
async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const done = new Promise((resolve) => child.once("exit", resolve));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    return;
  }
  await done;
}

async function startMock() {
  const child = spawn("npx", ["tsx", "tools/mock-upstream.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SYNC_COOLDOWN_MS: String(COOLDOWN_MS) },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

async function startProxy() {
  const child = spawn("npx", ["tsx", "apps/proxy/src/node.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: {
      ...process.env,
      PORT: String(PROXY_PORT),
      ADMIN_TOKEN: ADMIN,
      ANTHROPIC_API_KEY: "operator-key-e2e",
      UPSTREAM_BASE_URL: MOCK,
      ALLOWED_ORIGINS: `http://localhost:${PORT}`,
      PROXY_DB_PATH: DB,
      PROXY_POLICY: JSON.stringify({ dailyMessages: 5 }),
    },
  });
  await waitFor(`${PROXY_URL}/healthz`);
  return child;
}

function build() {
  const outDir = path.join(OUT, "dist-trial-sync");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${MOCK}/intervals`,
      VITE_SYNC_URL: `${MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${MOCK}/weather`,
      VITE_FEATURES: "onboarding,trial,devices",
      VITE_PROXY_URL: PROXY_URL,
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore", detached: true });
  await waitFor(APP_URL);
  return child;
}

async function admin(method, p, body) {
  const response = await fetch(`${PROXY_URL}${p}`, { method, headers: { authorization: `Bearer ${ADMIN}` }, body: body ? JSON.stringify(body) : undefined });
  return response.json();
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

const until = async (fn, ms = 20000) => {
  const start = Date.now();
  for (;;) {
    if (await fn().catch(() => false)) return true;
    if (Date.now() - start > ms) return false;
    await new Promise((r) => setTimeout(r, 300));
  }
};

(async () => {
  fs.rmSync(DB, { force: true });
  const children = [];
  try {
    step = "build";
    children.push(await startMock());
    children.push(await startProxy());
    children.push(await serve(build()));
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message);
    for (const c of children) await stop(c);
    process.exit(1);
  }
  const browser = await chromium.launch();
  const check = {};
  const problems = [];
  const designOk = [];
  /** 各台送給代理的取回請求（記下用過的復原密鑰，之後確認舊的被拒；只在記憶體裡） */
  const recoverBodies = [];

  const device = async (name, { mobile = false, ua, scheme = "light", skipWizard = true } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      userAgent: ua,
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    if (skipWizard) await E2E.skipWizard(context);
    const page = await context.newPage();
    page.on("console", (m) => {
      // 被移除、舊的憑證、錯的密鑰：伺服器回 4xx，瀏覽器會自己記一筆
      if (/Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    page.on("request", (r) => {
      if (r.url() === `${PROXY_URL}/v1/recover` && r.method() === "POST") recoverBodies.push({ name, body: JSON.parse(r.postData() ?? "{}") });
    });
    const card = page.locator('#side-panel .subpage[data-section="sync"] section.card');
    const ai = page.locator('#side-panel .subpage[data-section="ai"]');
    return { name, page, context, card, ai };
  };
  const syncTab = (d) => E2E.settings(d.page, "多裝置同步");
  const aiTab = (d) => E2E.settings(d.page, "AI 教練");
  const syncNow = async (d) => {
    await syncTab(d);
    await d.card.getByRole("button", { name: "立即同步裝置" }).click();
    await d.card.getByRole("button", { name: "立即同步裝置" }).waitFor({ timeout: 15000 });
  };
  const stored = (d) => d.page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), SETTINGS_KEY);
  const trialDevices = async () => {
    const { accounts } = await admin("GET", "/admin/accounts");
    return accounts;
  };
  const devicesOf = async (token) => {
    const response = await fetch(`${PROXY_URL}/v1/devices`, { headers: { "x-api-key": token } });
    return response.ok ? (await response.json()).devices : null;
  };

  try {
    const { invites } = await admin("POST", "/admin/invites", { count: 1, label: "E2E" });

    // ---------- A. 電腦淺色：免費試用＋開始同步 ----------
    step = "A 啟用免費試用";
    const A = await device("A", { ua: UA.mac });
    await A.page.goto(APP_URL);
    await A.page.locator(".tabbar").waitFor();
    await aiTab(A);
    await A.page.getByRole("radio", { name: "免費試用（邀請碼）" }).check();
    await A.page.getByRole("textbox", { name: "邀請碼" }).fill(invites[0].code);
    await A.page.getByRole("button", { name: "啟用" }).click();
    await A.page.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    await A.page.getByLabel("我了解並同意以上的資料流向").check();
    await A.page.getByLabel("我已閱讀使用須知").check();
    await A.page.getByRole("button", { name: "儲存" }).click();
    await A.page.getByText("設定已儲存在這個瀏覽器。").waitFor({ timeout: 10000 });
    const aSettings = await stored(A);
    check.aStoresAccount = /^acct_/.test(aSettings.proxy.account ?? "");

    step = "A 開始同步";
    await syncTab(A);
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card.locator(".recovery-code").innerText()).trim();
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    const startedAt = Date.now();
    // 同步完 → 存試用帳號的紀錄 → 幾秒後再同步一次（送上去）
    await A.page.waitForTimeout(6000);
    await syncNow(A);

    // ---------- B. 手機淺色：精靈 → 用復原碼還原 → 自動取回 ----------
    step = "B 用復原碼還原";
    const B = await device("B", { mobile: true, ua: UA.iphone, skipWizard: false });
    await B.page.goto(APP_URL);
    await B.page.getByRole("button", { name: "在別台用過？用同步帶過來" }).click();
    await B.card.getByRole("button", { name: "用復原碼還原" }).click();
    await B.card.getByLabel("復原碼").fill(recovery);
    await B.card.getByRole("button", { name: "還原" }).click();
    await B.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    check.bToastRecovered = await B.page
      .locator(".toast", { hasText: "已取回免費試用" })
      .waitFor({ timeout: 15000 })
      .then(() => true, () => false);
    await B.page.screenshot({ path: `${OUT}/trial-sync-B-recovered-390-light.png` });
    const bSettings = await stored(B);
    check.bProxyMode = bSettings.llmMode === "proxy" && /^rc_/.test(bSettings.proxy.token) && bSettings.proxy.url === PROXY_URL;
    check.bSameAccount = bSettings.proxy.account === aSettings.proxy.account && (await trialDevices()).length === 1;
    check.bOwnToken = bSettings.proxy.token !== aSettings.proxy.token;
    check.bApiKeyNotCarried = bSettings.apiKey === "";
    check.bRecoveredOnce = recoverBodies.filter((r) => r.name === "B").length === 1;
    // 復原密鑰不出現在網址或設定裡
    check.bSecretNotStored = !JSON.stringify(bSettings).includes(recoverBodies[0]?.body.secret ?? "∅");

    step = "B 的設定與對話";
    await aiTab(B);
    await B.page.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    const bList = B.page.locator(".trial-devices li");
    await bList.nth(1).waitFor({ timeout: 10000 });
    check.bListsTwoDevices = (await bList.count()) === 2 && (await bList.nth(1).innerText()).includes("（這台）");
    await B.page.getByLabel("我了解並同意以上的資料流向").check();
    await B.page.getByLabel("我已閱讀使用須知").check();
    designOk.push(["B-settings", await design(B.page)]);
    await B.page.screenshot({ path: `${OUT}/trial-sync-B-settings-390-light.png`, fullPage: true });
    await B.page.getByRole("button", { name: "儲存" }).click();
    await B.page.getByText("設定已儲存在這個瀏覽器。").waitFor({ timeout: 10000 });
    await E2E.go(B.page, "對話");
    await B.page.getByLabel("訊息").fill("嗨");
    await B.page.getByRole("button", { name: "送出" }).click();
    await B.page.getByRole("button", { name: "停止" }).waitFor({ timeout: 10000 }).catch(() => undefined);
    await B.page.getByRole("button", { name: "停止" }).waitFor({ state: "detached", timeout: 30000 });
    // A 看到同一份每天的則數
    await A.page.reload();
    await A.page.locator(".tabbar").waitFor();
    await aiTab(A);
    check.sharedDailyCount = await until(async () => (await A.page.locator(".trial-account .trial-remaining").innerText()).startsWith("今天還剩 4 則"));

    // ---------- C. 電腦深色：自己的 API key → 配對 → 不改設定、按了才取回 ----------
    step = "C 配對";
    const C = await device("C", { ua: UA.edge, scheme: "dark" });
    await C.page.goto(APP_URL);
    await C.page.locator(".tabbar").waitFor();
    await E2E.setupMock(C.page, { mock: MOCK, intervals: false });
    await syncTab(C);
    await C.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    const code = (await C.card.locator(".pair-code").innerText({ timeout: 10000 })).trim();
    await syncTab(A);
    await A.card.getByRole("button", { name: "新增裝置" }).click();
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByLabel("新裝置上顯示的配對碼").fill(code);
    await A.card.getByRole("button", { name: "下一步" }).click();
    const digits = (await C.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    await A.card.getByLabel("新裝置上顯示的六位數字").fill(digits);
    await A.card.getByRole("button", { name: "傳送" }).click();
    await A.card.getByText("已傳送").waitFor();
    await C.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await C.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    await A.card.getByRole("button", { name: "完成" }).click();
    await C.page.waitForTimeout(2000);
    const cSettings = await stored(C);
    check.cKeepsOwnKey = cSettings.llmMode === "byok" && cSettings.apiKey === "mock-key" && !cSettings.proxy.token;
    check.cNoAutoRecover = recoverBodies.filter((r) => r.name === "C").length === 0;
    await aiTab(C);
    const offer = C.page.locator(".trial-from-sync");
    check.cOffersTrial = await offer.waitFor({ timeout: 10000 }).then(async () => (await offer.innerText()).includes("在這台也用免費試用"), () => false);
    designOk.push(["C-offer", await design(C.page)]);
    await C.page.screenshot({ path: `${OUT}/trial-sync-C-offer-1280-dark.png`, fullPage: true });
    await offer.getByRole("button", { name: "在這台使用" }).click();
    await C.page.locator(".toast", { hasText: "已在這台啟用免費試用" }).waitFor({ timeout: 10000 });
    await C.page.getByText("已啟用免費試用").waitFor({ timeout: 10000 });
    const cAfter = await stored(C);
    check.cRecoveredOnClick = cAfter.llmMode === "proxy" && /^rc_/.test(cAfter.proxy.token) && cAfter.proxy.account === aSettings.proxy.account;
    check.threeTrialDevices = (await devicesOf(aSettings.proxy.token))?.length === 3;
    await C.page.screenshot({ path: `${OUT}/trial-sync-C-recovered-1280-dark.png`, fullPage: true });

    // ---------- D. A 在試用的裝置清單移除 B；B 自己移除 ----------
    step = "A 移除 B（試用）";
    await aiTab(A);
    const aList = A.page.locator(".trial-devices li");
    await aList.nth(2).waitFor({ timeout: 10000 });
    await aList.filter({ hasText: "iPhone" }).getByRole("button", { name: "移除" }).click();
    await until(async () => (await aList.count()) === 2);
    const bRecoversBefore = recoverBodies.filter((r) => r.name === "B").length;
    await B.page.reload();
    await B.page.locator(".tabbar").waitFor();
    await syncNow(B);
    await B.page.waitForTimeout(2000);
    check.bRemovedNoAuto = recoverBodies.filter((r) => r.name === "B").length === bRecoversBefore && (await devicesOf(aSettings.proxy.token))?.length === 2;
    await aiTab(B);
    const again = B.page.getByRole("button", { name: "重新取回" });
    check.bOffersRecoverAgain = await again.waitFor({ timeout: 10000 }).then(() => true, () => false);
    await B.page.screenshot({ path: `${OUT}/trial-sync-B-removed-390-light.png`, fullPage: true });
    await again.click();
    check.bRecoveredAgain = await until(async () => (await devicesOf(aSettings.proxy.token))?.length === 3);

    step = "B 自己移除這台";
    await B.page.reload();
    await B.page.locator(".tabbar").waitFor();
    await aiTab(B);
    const bOwn = B.page.locator(".trial-devices li", { hasText: "（這台）" });
    await bOwn.waitFor({ timeout: 10000 });
    await bOwn.getByRole("button", { name: "移除" }).click();
    await B.page.locator(".toast", { hasText: "已移除這台" }).waitFor({ timeout: 10000 });
    const bRecovers = recoverBodies.filter((r) => r.name === "B").length;
    await B.page.reload();
    await B.page.locator(".tabbar").waitFor();
    await syncNow(B);
    await B.page.waitForTimeout(2000);
    check.bDeclinedNoAuto = recoverBodies.filter((r) => r.name === "B").length === bRecovers && !(await stored(B)).proxy.token;
    await aiTab(B);
    check.bStillOffersManual = await B.page.locator(".trial-from-sync").waitFor({ timeout: 10000 }).then(() => true, () => false);

    // ---------- E. A 在同步移除 C：換金鑰 → 復原密鑰換新 ----------
    step = "A 在同步移除 C";
    const oldSecret = recoverBodies.find((r) => r.name === "C")?.body;
    const waitLeft = COOLDOWN_MS - (Date.now() - startedAt) + 1500;
    if (waitLeft > 0) await A.page.waitForTimeout(waitLeft);
    await syncNow(A);
    const cRow = A.card.locator("li.device").filter({ hasText: "Windows · Edge" });
    await cRow.getByRole("button", { name: "移除" }).click();
    await A.card.getByRole("button", { name: "移除並換金鑰" }).click();
    await A.card.locator(".new-code .recovery-code").waitFor({ timeout: 20000 });
    check.aWarnsTrialList = await A.card.locator(".notice.warn", { hasText: "裝置清單也移除" }).isVisible();
    await A.page.screenshot({ path: `${OUT}/trial-sync-A-rekey-1280-light.png`, fullPage: true });
    await A.card.getByLabel("我已經把新的復原碼存好了").check();
    await A.card.getByRole("button", { name: "完成" }).click();
    await A.page.waitForTimeout(5000);
    await syncNow(A);
    const oldRejected = oldSecret
      ? await fetch(`${PROXY_URL}/v1/recover`, { method: "POST", body: JSON.stringify({ account: oldSecret.account, secret: oldSecret.secret }) })
      : null;
    check.oldSecretRejected = oldRejected?.status === 400;

    step = "B 用新的取回";
    await syncNow(B);
    await aiTab(B);
    const bOffer = B.page.locator(".trial-from-sync");
    await bOffer.waitFor({ timeout: 10000 });
    const bBefore = recoverBodies.filter((r) => r.name === "B").length;
    await bOffer.getByRole("button", { name: "在這台使用" }).click();
    await B.page.locator(".toast", { hasText: "已在這台啟用免費試用" }).waitFor({ timeout: 10000 });
    const newBody = recoverBodies.filter((r) => r.name === "B")[bBefore]?.body;
    check.bUsesNewSecret = !!newBody && newBody.secret !== oldSecret?.secret && /^rc_/.test((await stored(B)).proxy.token);

    // ---------- F. A 刪除試用帳號：紀錄刪掉 ----------
    step = "A 刪除試用帳號";
    // 先讓 B 回到沒有試用的狀態（自己移除），才看得到「在這台也用免費試用」會不會消失
    await aiTab(B);
    const bOwn2 = B.page.locator(".trial-devices li", { hasText: "（這台）" });
    await bOwn2.waitFor({ timeout: 10000 });
    await bOwn2.getByRole("button", { name: "移除" }).click();
    await B.page.locator(".toast", { hasText: "已移除這台" }).last().waitFor({ timeout: 10000 });
    await aiTab(A);
    await A.page.getByRole("button", { name: "刪除試用帳號" }).click();
    await A.page.getByRole("textbox", { name: "邀請碼" }).waitFor({ timeout: 10000 });
    check.accountDeleted = (await trialDevices()).length === 0;
    await A.page.waitForTimeout(5000);
    await syncNow(A);
    await syncNow(B);
    await aiTab(B);
    check.recordGoneOnB = await until(async () => (await B.page.locator(".trial-from-sync").count()) === 0, 10000);

    for (const [name, ok] of designOk) check[`design-${name}`] = ok;
  } catch (e) {
    problems.push(`例外 [${step}]：${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    await browser.close();
    for (const c of children.reverse()) await stop(c);
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
