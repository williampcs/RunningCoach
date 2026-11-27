// staging 部署後的實測（規格 12.50、9.4「staging 部署後自動跑一輪實測」）：對線上的 staging（真的 Pages、同步服務、代理與 D1）
// 跑一輪不需要模型、不需要人機驗證的檢查。`.github/workflows/staging.yml` 部署完自動執行；本機也能跑：
//
//   SMOKE_WEB_URL=<staging 的網址> SMOKE_SYNC_URL=<staging 同步服務的網址> SMOKE_PROXY_URL=<staging 代理的網址> \
//     node tools/e2e/smoke-staging.cjs
//
// 網址只從環境變數讀（CI 裡是 repo 的 Variables），不寫進 repo。不需要任何金鑰，也不建立同步空間、不開配對碼、不打模型。
//
// 環境變數：
//   SMOKE_WEB_URL      網頁版（必填）
//   SMOKE_SYNC_URL     同步服務（選填；沒有時跳過同步服務的檢查）
//   SMOKE_PROXY_URL    免費試用的代理（選填；沒有時跳過代理的檢查）
//   SMOKE_COMMIT       期望的 commit（選填，CI 給 GITHUB_SHA）：等到 version.json 換成這個 commit 才開始，最多等 SMOKE_WAIT 秒
//   SMOKE_WAIT         上面等多久（秒，預設 180）
//   SMOKE_VERSION      期望的版號（預設是 package.json 的 version）
//   SMOKE_HUMAN_CHECK  「1」：同步服務開著人機驗證，檢查沒有人機驗證的 token 建立空間是 403（CI 由部署同步服務的那一步告訴它）；
//                      其他值或沒有設定時不送這個請求（沒開人機驗證時，送了會真的建立一個空的同步空間）
//
// 檢查：
//   網頁版：打得開、標題列是 Staging、完整的版號（設定頁最下面）與期望的一致、每一頁上方的 Staging 提醒、功能開關全開、
//          _headers 的安全標頭與 noindex、使用須知與隱私說明的靜態頁（Staging 標示，隱私說明寫的是 staging 的同步服務）、
//          新的使用者看到設定精靈、「先看看」能走完（對話、計畫、紀錄、選手），而且不送出任何外部請求
//   同步服務：staging 的來源通過 CORS、別的來源拿不到 CORS 標頭；沒有憑證讀同步空間是 401；（SMOKE_HUMAN_CHECK=1）沒有人機驗證建立空間是 403
//   代理：/healthz 回 ok、staging 的來源通過 CORS、別的來源拿不到；沒有帳號查用量是 401
//
// 最後一行印出 ALL OK 或 SOME CHECKS FAILED（失敗時結束碼是 1）。截圖放在 $E2E_OUT。
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const { version: PACKAGE_VERSION } = require("../../package.json");

const E2E = require("./env.cjs");
const { chromium, OUT } = E2E;

/** 別的來源：不在任何允許的清單裡 */
const OTHER_ORIGIN = "https://smoke-test.invalid";

function urlOf(name, required) {
  const value = process.env[name]?.trim();
  if (!value) {
    if (required) {
      console.error(`缺少 ${name}`);
      process.exit(2);
    }
    return null;
  }
  try {
    return new URL(value);
  } catch {
    console.error(`${name} 不是網址`);
    process.exit(2);
  }
}

const WEB = urlOf("SMOKE_WEB_URL", true);
const SYNC = urlOf("SMOKE_SYNC_URL", false);
const PROXY = urlOf("SMOKE_PROXY_URL", false);
const ORIGIN = WEB.origin;
const COMMIT = process.env.SMOKE_COMMIT?.trim().slice(0, 7) || null;
const WAIT_S = Number(process.env.SMOKE_WAIT) > 0 ? Number(process.env.SMOKE_WAIT) : 180;
const VERSION = process.env.SMOKE_VERSION?.trim() || PACKAGE_VERSION;
const HUMAN_CHECK = process.env.SMOKE_HUMAN_CHECK === "1";

/** 核心定義的所有功能開關（packages/core/src/features.ts 的 FEATURES）：staging 一律全開 */
function featureNames() {
  const source = fs.readFileSync(path.join(__dirname, "../../packages/core/src/features.ts"), "utf8");
  const block = source.slice(source.indexOf("export const FEATURES = {"), source.indexOf("} as const;"));
  const names = [...block.matchAll(/^\s+(\w+): "/gm)].map((m) => m[1]);
  if (!names.length) throw new Error("讀不到功能開關的清單");
  return names;
}

/** 網址的路徑接在服務的網址後面（服務的網址可能帶路徑） */
const join = (base, p) => new URL(`${base.pathname.replace(/\/+$/, "")}${p}`, base);

const check = {};
const problems = [];
const notes = [];

async function request(url, init = {}) {
  const response = await fetch(url, { redirect: "manual", ...init, signal: AbortSignal.timeout(20000) });
  let body = null;
  const text = await response.text();
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, headers: response.headers, body };
}

/** 部署完到新版上線可能差幾秒到幾分鐘：等 version.json 換成這次的 commit */
async function waitForCommit() {
  const deadline = Date.now() + WAIT_S * 1000;
  let last = null;
  while (true) {
    try {
      const r = await request(join(WEB, `/version.json?t=${Date.now()}`), { headers: { "cache-control": "no-cache" } });
      last = r.status === 200 && typeof r.body === "object" ? r.body.commit : `HTTP ${r.status}`;
      if (!COMMIT || last === COMMIT) return last;
    } catch (e) {
      last = e.message;
    }
    if (Date.now() > deadline) return last;
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

async function checkWebFiles(commit) {
  check.versionFile = COMMIT ? commit === COMMIT : typeof commit === "string" && /^[0-9a-f]{7}$|^dev$/.test(commit);
  if (!check.versionFile) problems.push(`version.json 的 commit 是 ${commit}，期望 ${COMMIT ?? "7 碼的 commit"}`);
  const home = await request(WEB);
  const headers = home.headers;
  check.homeLoads = home.status === 200 && typeof home.body === "string" && home.body.includes('<div id="root">');
  // 安全標頭與 noindex（vite.config.ts 輸出的 _headers）
  check.noindex = /noindex/i.test(headers.get("x-robots-tag") ?? "");
  check.securityHeaders =
    /frame-ancestors 'none'/.test(headers.get("content-security-policy") ?? "") &&
    headers.get("x-content-type-options") === "nosniff" &&
    headers.get("referrer-policy") === "no-referrer" &&
    /max-age=\d+/.test(headers.get("strict-transport-security") ?? "");
  if (!check.securityHeaders) {
    const names = ["content-security-policy", "x-content-type-options", "referrer-policy", "strict-transport-security"];
    problems.push(`安全標頭不對：${names.map((n) => `${n}=${headers.get(n) ? "有" : "沒有"}`).join(" ")}`);
  }
  const version = await request(join(WEB, "/version.json"));
  check.versionNoStore = /no-store/.test(version.headers.get("cache-control") ?? "");
}

async function checkLegal(browser) {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  for (const [file, title] of [
    ["/terms", "使用須知"],
    ["/privacy", "隱私說明"],
  ]) {
    const response = await page.goto(join(WEB, file).href);
    const banner = page.locator(".staging-banner");
    const ok =
      response?.status() === 200 &&
      (await page.getByRole("heading", { name: title, level: 1 }).isVisible()) &&
      (await banner.isVisible()) &&
      (await banner.innerText()).includes("Staging");
    check[`legal${file}`] = ok;
    if (file === "/privacy" && SYNC) {
      // 隱私說明寫的同步服務是 staging 的（不是正式的）
      check.privacyNamesSyncHost = (await page.locator("body").innerText()).includes(SYNC.host);
    }
    await page.screenshot({ path: path.join(OUT, `smoke${file.replace("/", "-")}.png`), fullPage: true });
  }
  await context.close();
}

async function newPage(browser, view, init) {
  const context = await browser.newContext({
    viewport: { width: view.width, height: view.height },
    colorScheme: view.scheme,
    ...(view.width < 600 ? { deviceScaleFactor: 1, isMobile: true, hasTouch: true } : {}),
  });
  if (init) await init(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`頁面錯誤（${view.width}）：${e.message}`));
  return page;
}

async function checkApp(browser) {
  // 新的使用者：設定精靈的第一頁（精靈蓋住整個畫面，標題列與 Staging 提醒在下面跳過精靈的那一頁檢查）
  const view = { width: 390, height: 844, scheme: "light" };
  let page = await newPage(browser, view);
  const external = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.protocol.startsWith("http") && u.origin !== ORIGIN) external.push(u.origin);
  });
  await page.goto(WEB.href);
  await page.locator(".wizard-page[data-step=welcome]").waitFor({ timeout: 30000 });
  check.wizardForNewUser = await page.getByRole("button", { name: "先看看" }).isVisible();
  await page.screenshot({ path: path.join(OUT, "smoke-welcome.png"), fullPage: true });

  // 先看看：範例的資料逛一圈，不送出外部請求
  await page.getByRole("button", { name: "先看看" }).click();
  await page.locator(".demo-banner").waitFor({ timeout: 20000 });
  await page.getByText("這週怎麼練？").first().waitFor({ timeout: 10000 });
  const demoChat = (await page.locator(".bubble.assistant").count()) > 0 && (await page.getByText("開始設定後就能和教練聊").isVisible());
  await E2E.go(page, "計畫");
  await page.locator(".plan-session").first().waitFor({ timeout: 10000 });
  const demoPlan = (await page.locator(".plan-session").count()) > 0;
  await E2E.go(page, "紀錄");
  await page.locator("ul.runs > li").first().waitFor({ timeout: 10000 });
  const demoHistory = (await page.locator("ul.runs > li").count()) > 5;
  await E2E.go(page, "選手");
  await page.locator(".profile-list").waitFor({ timeout: 10000 });
  const demoProfile = await page.locator(".demo-banner").isVisible();
  await page.screenshot({ path: path.join(OUT, "smoke-demo-profile.png"), fullPage: true });
  check.demo = demoChat && demoPlan && demoHistory && demoProfile;
  if (!check.demo) problems.push(`先看看：對話 ${demoChat}、計畫 ${demoPlan}、紀錄 ${demoHistory}、選手 ${demoProfile}`);
  check.demoNoRequests = external.length === 0;
  if (external.length) problems.push(`先看看送出了外部請求：${[...new Set(external)].join(" ")}`);
  await page.context().close();

  // 已經設定過的人（跳過精靈）：標題列是 Staging、上方的 Staging 提醒、版號；設定頁最下面的完整版號、功能開關全開（staging 一律全開，規格 12.25）
  page = await newPage(browser, { width: 1280, height: 860, scheme: "dark" }, E2E.skipWizard);
  await page.goto(WEB.href);
  await page.locator("nav.tabbar").waitFor({ timeout: 30000 });
  check.stagingLabel = (await page.locator(".topbar .version.staging").innerText({ timeout: 5000 })).trim() === "Staging";
  check.stagingBanner = (await page.locator(".staging-banner").innerText({ timeout: 5000 })).includes("Staging");
  const title = (await page.locator(".topbar .version").getAttribute("title")) ?? "";
  check.versionInTitle = title.startsWith(`v${VERSION} Staging`) && (!COMMIT || title.includes(COMMIT));
  if (!check.versionInTitle) problems.push(`標題列的版號是「${title}」，期望 v${VERSION} Staging${COMMIT ? `（${COMMIT}…）` : ""}`);
  await E2E.go(page, "設定");
  const foot = await page.locator("#side-panel").innerText();
  check.settingsVersion = foot.includes(`v${VERSION} Staging`) && (!COMMIT || foot.includes(COMMIT));
  const features = (await page.locator("#side-panel .features-on").innerText({ timeout: 5000 }).catch(() => "")) || "";
  const expected = featureNames();
  const missing = expected.filter((f) => !features.includes(`（${f}）`));
  check.allFeaturesOn = missing.length === 0;
  if (missing.length) problems.push(`staging 沒開的功能：${missing.join("、")}（${features || "沒有功能開關的說明"}）`);
  await page.screenshot({ path: path.join(OUT, "smoke-settings.png"), fullPage: true });
  await page.context().close();
}

/** 同步服務：CORS 只給 staging 的來源、沒有憑證的請求被拒 */
async function checkSync() {
  const space = crypto.randomBytes(16).toString("hex");
  const spaceUrl = join(SYNC, `/v1/spaces/${space}`);
  const preflight = (origin) =>
    request(spaceUrl, { method: "OPTIONS", headers: { origin, "access-control-request-method": "PUT", "access-control-request-headers": "authorization" } });
  const own = await preflight(ORIGIN);
  check.syncCorsStaging = own.status === 204 && own.headers.get("access-control-allow-origin") === ORIGIN;
  const other = await preflight(OTHER_ORIGIN);
  check.syncCorsOtherBlocked = other.headers.get("access-control-allow-origin") === null;
  // 沒有憑證讀一個不存在的空間：401（不讀資料庫以外的東西、不寫入）
  const read = await request(join(SYNC, `/v1/spaces/${space}/changes?since=0`), { headers: { origin: ORIGIN } });
  check.syncNoAuth401 = read.status === 401 && read.headers.get("access-control-allow-origin") === ORIGIN;
  if (!check.syncNoAuth401) problems.push(`同步服務沒有憑證時回 ${read.status}：${JSON.stringify(read.body)}`);
  if (!HUMAN_CHECK) {
    notes.push("沒有檢查「沒有人機驗證建立空間是 403」（SMOKE_HUMAN_CHECK 不是 1）");
    return;
  }
  // 沒有人機驗證的 token 建立空間：403（state human_check）。這個來源每小時建立空間的次數會加 1，不會建立空間
  const token = crypto.randomBytes(32).toString("base64url");
  const create = await request(join(SYNC, `/v1/spaces/${space}?create=1&devices=1`), {
    method: "PUT",
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
  });
  if (create.status === 429) {
    // 這個 runner 的網段剛好用完建立空間的次數：沒建立（也是被拒），但沒驗證到人機驗證
    notes.push("建立空間被次數限制擋下（429），這次沒驗證到人機驗證");
    console.log("::warning::staging 的同步服務回 429（建立空間的次數），這次沒驗證到人機驗證");
    check.syncCreateNeedsHuman = true;
    return;
  }
  check.syncCreateNeedsHuman = create.status === 403 && create.body?.state === "human_check";
  if (!check.syncCreateNeedsHuman) problems.push(`沒有人機驗證建立空間回 ${create.status}：${JSON.stringify(create.body)}`);
}

/** 代理：公開的端點正常、CORS 只給 staging 的來源、沒有帳號被拒 */
async function checkProxy() {
  const health = await request(join(PROXY, "/healthz"));
  check.proxyHealth = health.status === 200 && health.body?.ok === true;
  const preflight = (origin) =>
    request(join(PROXY, "/v1/messages"), { method: "OPTIONS", headers: { origin, "access-control-request-method": "POST", "access-control-request-headers": "content-type,x-api-key" } });
  const own = await preflight(ORIGIN);
  check.proxyCorsStaging = own.status === 204 && own.headers.get("access-control-allow-origin") === ORIGIN;
  const other = await preflight(OTHER_ORIGIN);
  check.proxyCorsOtherBlocked = other.headers.get("access-control-allow-origin") === null;
  const usage = await request(join(PROXY, "/v1/usage"), { headers: { origin: ORIGIN } });
  check.proxyNoAuth401 = usage.status === 401 && usage.headers.get("access-control-allow-origin") === ORIGIN;
  if (!check.proxyNoAuth401) problems.push(`代理沒有帳號查用量回 ${usage.status}：${JSON.stringify(usage.body)}`);
}

/** 整段最多跑多久（秒，預設 240）：卡住時印出卡在哪一步再失敗，不讓 workflow 等到逾時 */
const LIMIT_S = Number(process.env.SMOKE_LIMIT) > 0 ? Number(process.env.SMOKE_LIMIT) : 240 + WAIT_S;

(async () => {
  const started = Date.now();
  let step = "version";
  let browser;
  const at = (name) => {
    step = name;
    console.log(`… ${name}（${Math.round((Date.now() - started) / 1000)} 秒）`);
  };
  setTimeout(() => {
    console.log(`FAIL 卡在 [${step}] 超過 ${LIMIT_S} 秒`);
    console.log("SOME CHECKS FAILED");
    process.exit(1);
  }, LIMIT_S * 1000).unref();
  try {
    at("version");
    const commit = await waitForCommit();
    at("files");
    await checkWebFiles(commit);
    at("browser");
    browser = await chromium.launch();
    at("legal");
    await checkLegal(browser);
    at("app");
    await checkApp(browser);
    if (SYNC) {
      at("sync");
      await checkSync();
    } else notes.push("沒有 SMOKE_SYNC_URL，跳過同步服務");
    if (PROXY) {
      at("proxy");
      await checkProxy();
    } else notes.push("沒有 SMOKE_PROXY_URL，跳過代理");
  } catch (e) {
    check[`step.${step}`] = false;
    problems.push(`[${step}] ${e.message.split("\n")[0]}`);
  } finally {
    await browser?.close();
  }
  for (const [name, ok] of Object.entries(check)) console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  for (const note of notes) console.log(`note: ${note}`);
  for (const problem of problems) console.log(`problem: ${problem}`);
  console.log(`（${Math.round((Date.now() - started) / 1000)} 秒）`);
  const ok = Object.values(check).every(Boolean) && problems.length === 0;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
