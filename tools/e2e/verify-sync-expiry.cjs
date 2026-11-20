// 驗證不活躍的空間到期刪除（規格 12.10「不活躍的空間到期刪除」，功能開關 devices）：
// - 開始同步、顯示復原碼、同步設定（裝置清單下面）寫「所有裝置 12 個月都沒有同步，雲端的備份會刪除；這台的資料不受影響」
// - 200 天後同步一次（讀寫都算連線）：同步服務的定時維護不刪
// - 之後 12 個月以上沒有連線：定時維護刪掉；這台打開後顯示「雲端的備份過期了」（不是同步失敗），按了才重建：
//   「用這台的資料重新建立」→ 新的復原碼 → 這台的資料送上去
// - 手機淺色、電腦深色各跑一次；不左右捲動；截圖（sync-expiry-*）
// 這個腳本自己開一份模擬上游（8795 埠，時間可以往後推）並建置一份開著 devices 的網頁版（4187 埠）
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4187;
const MOCK_PORT = 8795;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const URL = `http://localhost:${PORT}/`;
const DAY = 86_400_000;
const EXPIRY = "所有裝置 12 個月都沒有同步，雲端的備份會刪除；這台的資料不受影響。";

let step = "start";

function stop(child) {
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill();
  }
}

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

async function startMock() {
  const child = spawn("npx", ["tsx", "tools/mock-upstream.ts"], {
    cwd: ROOT,
    stdio: "ignore",
    detached: true,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT) },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-sync-expiry");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${MOCK}/intervals`,
      VITE_SYNC_URL: `${MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${MOCK}/weather`,
      VITE_FEATURES: "devices",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore", detached: true });
  await waitFor(URL);
  return child;
}

/** 同步服務的時間往後推 days 天並跑一次定時維護；回傳維護的結果 */
async function shift(days) {
  return (await fetch(`${MOCK}/mock-sync/shift?days=${days}`, { method: "POST" })).json();
}

(async () => {
  const problems = [];
  const check = {};
  const children = [];
  try {
    step = "build";
    children.push(await startMock());
    children.push(await serve(build()));
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message);
    for (const c of children) stop(c);
    process.exit(1);
  }
  const browser = await chromium.launch();
  /** 往後推的天數（同步服務與網頁一起） */
  let shifted = 0;

  async function run(name, { mobile, scheme }) {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    // 時鐘照常走，之後跟著同步服務往後撥
    await context.clock.install();
    const page = await context.newPage();
    page.on("console", (m) => {
      // 空間不在了：同步服務回 404；時鐘往後撥之後第一個簽章（401，以伺服器的時間校正後重送）
      if (/\b(404|401)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const card = page.locator('#side-panel .subpage[data-section="sync"] section.card');
    const toSync = () => E2E.settings(page, "多裝置同步");
    const later = async (days) => {
      shifted += days;
      const result = await shift(days);
      await context.clock.setSystemTime(new Date(Date.now() + shifted * DAY));
      return result;
    };
    const synced = () => card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });

    step = `${name} 準備`;
    await page.goto(URL);
    await page.locator("nav.tabbar button").first().waitFor();
    // 這台時間跟著之前推過的天數
    if (shifted) await context.clock.setSystemTime(new Date(Date.now() + shifted * DAY));
    await E2E.settings(page, "訓練紀錄");
    await page.getByLabel("API key", { exact: true }).fill("mock-intervals-key");
    await page.getByRole("button", { name: "儲存設定" }).click();
    await page.getByText("設定已儲存在這個瀏覽器。").waitFor();

    step = `${name} 開始同步`;
    await toSync();
    await card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await card.locator(".recovery-code").innerText({ timeout: 10000 })).trim();
    check[`${name}StartExplains`] = (await card.locator(".expiry-note", { hasText: EXPIRY }).count()) === 1;
    await card.screenshot({ path: `${E2E.OUT}/sync-expiry-${name}-start.png` });
    await card.getByLabel("我已經把復原碼存好了").check();
    await card.getByRole("button", { name: "開始同步" }).click();
    await synced();
    await card.locator(".device-list").waitFor({ timeout: 15000 });
    check[`${name}ListExplains`] = (await card.locator(".device-list .expiry-note", { hasText: EXPIRY }).count()) === 1;
    await card.screenshot({ path: `${E2E.OUT}/sync-expiry-${name}-on.png` });

    step = `${name} 顯示復原碼`;
    await card.getByRole("button", { name: "顯示復原碼" }).click();
    await card.getByRole("button", { name: "我了解，顯示" }).click();
    await card.locator(".recovery-code").waitFor({ timeout: 5000 });
    check[`${name}CodeExplains`] = (await card.locator(".expiry-note", { hasText: EXPIRY }).count()) === 1;
    await card.getByRole("button", { name: "收起" }).click();

    step = `${name} 200 天後同步一次`;
    const first = await later(200);
    check[`${name}NotExpiredEarly`] = first.inactive === 0;
    await page.reload();
    await page.locator("nav.tabbar button").first().waitFor();
    await toSync();
    await card.getByRole("button", { name: "立即同步裝置" }).click();
    await card.getByRole("button", { name: "立即同步裝置" }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1000);
    check[`${name}SyncAfter200Days`] = (await card.locator(".notice.error").count()) === 0 && (await card.locator(".sync-gone").count()) === 0;
    // 從建立算已經超過 12 個月，從上次同步算還沒
    const notYet = await later(300);
    check[`${name}ReadKeepsSpace`] = notYet.inactive === 0;

    step = `${name} 12 個月沒有連線`;
    const expired = await later(70);
    check[`${name}ExpiredByMaintenance`] = expired.inactive === 1;
    await page.reload();
    await page.locator("nav.tabbar button").first().waitFor();
    await toSync();
    const gone = card.locator(".notice.warn.sync-gone", { hasText: "雲端的備份過期了" });
    check[`${name}ShowsExpired`] = await gone.waitFor({ timeout: 15000 }).then(() => true, () => false);
    check[`${name}NoFailureNotice`] = (await card.locator(".notice.error").count()) === 0 && !(await card.innerText()).includes("同步失敗");
    // 按了才建：還沒有新的空間
    const rebuild = card.getByRole("button", { name: "用這台的資料重新建立" });
    check[`${name}NotRebuiltAutomatically`] = (await rebuild.count()) === 1 && (await card.locator(".recovery-code").count()) === 0;
    check[`${name}NoOverflowGone`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await card.screenshot({ path: `${E2E.OUT}/sync-expiry-${name}-expired.png` });

    step = `${name} 重新建立`;
    await rebuild.click();
    const fresh = (await card.locator(".recovery-code").innerText({ timeout: 10000 })).trim();
    check[`${name}NewRecoveryCode`] = fresh !== recovery && fresh.length > 0;
    await card.getByLabel("我已經把復原碼存好了").check();
    await card.getByRole("button", { name: "開始同步" }).click();
    await synced();
    // 這台沒有訓練資料（只有設定），送出的筆數可能是 0：看已開啟、沒有錯誤、過期的提示不見了、裝置清單回來
    await card.locator(".device-list").waitFor({ timeout: 15000 });
    check[`${name}Rebuilt`] =
      (await card.getByText("已開啟").count()) > 0 && (await card.locator(".notice.error").count()) === 0 && (await card.locator(".sync-gone").count()) === 0;
    await card.screenshot({ path: `${E2E.OUT}/sync-expiry-${name}-rebuilt.png` });
    check[`${name}NoOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await context.close();
  }

  try {
    await run("phone", { mobile: true, scheme: "light" });
    // 手機那份重新建立的空間先讓它過期，電腦那次的數量只算自己的
    shifted += 400;
    check.phoneRebuiltExpiresLater = (await shift(400)).inactive === 1;
    await run("desktop", { mobile: false, scheme: "dark" });
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
    check.completed = false;
  }
  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  for (const c of children) stop(c);
  process.exit(ok ? 0 : 1);
})();
