// 驗證「我的鑰匙與帳號」與 API key、Intervals.icu 的連線跟著加密的同步（規格 12.47，功能開關 devices）：
// - A（電腦淺色）設 key、開始同步：「把 API key 與 Intervals.icu 的連線也帶到其他裝置」預設勾
// - B（手機淺色）配對加入：自動有 A 的 key 與 Intervals.icu 的連線（提示；資料流向要自己確認）
// - B 改 key：A 同步後跟著換並看到「API key 已經更新成另一台設定的」
// - 一覽頁：每一樣的有沒有、存在哪、換手機、弄丟了；點一列到那一項的設定
// - A 取消勾選：B 也變成不勾；B 再改 key，A 不再收到
// - 再勾回來；C（電腦深色）先開密碼鎖再用復原碼還原：拿到 key，瀏覽器裡只有密文；重新整理要解鎖，解鎖後 key 還在
// - 同步服務收到的內容沒有明文的 key（模擬上游的請求紀錄）；不左右捲動；截圖（keys-*）
// 這個腳本自己開一份模擬上游（8794 埠）並建置一份開著 devices 的網頁版（4188 埠）。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4188;
const MOCK_PORT = 8794;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const URL = `http://localhost:${PORT}/`;

const KEY_A = "mock-key-from-device-a";
const KEY_B = "mock-key-from-device-b";
const KEY_B2 = "mock-key-b-after-unshare";
const INTERVALS = "mock-intervals-key";
const PASSWORD = "correct horse battery";

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
};

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
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SYNC_COOLDOWN_MS: "20000" },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-keys-sync");
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
  /** 送到同步服務的內容（檢查沒有明文的 key） */
  const syncBodies = [];

  const device = async (name, { mobile = false, ua, scheme = "light" } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      userAgent: ua,
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      if (/\b(410|403|404)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    page.on("request", (r) => {
      if (r.url().startsWith(`${MOCK}/sync`) && r.postData()) syncBodies.push(r.postData());
    });
    const card = page.locator('#side-panel .subpage[data-section="sync"] section.card');
    const d = { name, page, card, context };
    d.sync = () => E2E.settings(page, "多裝置同步");
    return d;
  };
  const open = async (d) => {
    await d.page.goto(URL);
    await d.page.locator("nav.tabbar button").first().waitFor();
  };
  const syncNow = async (d) => {
    await d.sync();
    await d.card.getByRole("button", { name: "立即同步裝置" }).click();
    await d.card.getByRole("button", { name: "立即同步裝置" }).waitFor({ timeout: 15000 });
  };
  const aiKey = async (d) => {
    await E2E.settings(d.page, "AI 教練");
    return d.page.locator("#side-panel").getByLabel("API key", { exact: true }).inputValue();
  };
  const intervalsKey = async (d) => {
    await E2E.settings(d.page, "訓練紀錄");
    return d.page.locator("#side-panel").getByLabel("API key", { exact: true }).inputValue();
  };
  const setAiKey = async (d, key) => {
    await E2E.settings(d.page, "AI 教練");
    await d.page.locator("#side-panel").getByLabel("API key", { exact: true }).fill(key);
    await d.page.getByRole("button", { name: "儲存設定" }).click();
    await d.page.getByText("設定已儲存在這個瀏覽器。").first().waitFor();
  };
  /** 等某一則提示出現 */
  const toast = (d, re, timeout = 15000) =>
    d.page
      .locator(".toast", { hasText: re })
      .first()
      .waitFor({ timeout })
      .then(() => true, () => false);
  const waitValue = async (fn, expected, tries = 30) => {
    for (let i = 0; i < tries; i++) {
      if ((await fn()) === expected) return true;
      await new Promise((r) => setTimeout(r, 300));
    }
    return false;
  };
  const shareBox = (d) => d.card.getByLabel("把 API key 與 Intervals.icu 的連線也帶到其他裝置");

  try {
    // --- A：設 key、開始同步 ---
    step = "A 開始同步";
    const A = await device("A", { ua: UA.mac });
    await open(A);
    await E2E.setupMock(A.page, { mock: MOCK });
    await setAiKey(A, KEY_A);
    await A.sync();
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card.locator(".recovery-code").innerText()).trim();
    // 預設不勾（規格 12.47：先由使用者自己選）
    check.startShareUncheckedByDefault = !(await shareBox(A).isChecked());
    await shareBox(A).check();
    await A.card.screenshot({ path: `${E2E.OUT}/keys-A-start.png` });
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    check.settingsHasShareChecked = await shareBox(A).isChecked();
    await A.page.waitForTimeout(1500);
    await syncNow(A);

    // --- B：配對加入（手機） ---
    step = "B 配對加入";
    const B = await device("B", { mobile: true, ua: UA.iphone });
    await open(B);
    await B.sync();
    await B.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    const code = (await B.card.locator(".pair-code").innerText({ timeout: 10000 })).trim();
    await A.sync();
    await A.card.getByRole("button", { name: "新增裝置" }).click();
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByLabel("新裝置上顯示的配對碼").fill(code);
    await A.card.getByRole("button", { name: "下一步" }).click();
    const digits = (await B.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    await A.card.getByLabel("新裝置上顯示的六位數字").fill(digits);
    await A.card.getByRole("button", { name: "傳送" }).click();
    await A.card.getByText("已傳送").waitFor();
    const bToast = toast(B, /已從另一台帶入 API key；已從另一台帶入 Intervals\.icu 的連線。到設定的「AI 教練」確認資料流向/, 20000);
    await B.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await B.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    await A.card.getByRole("button", { name: "完成" }).click();
    check.bToastBroughtKeys = await bToast;
    check.bGotAiKey = await waitValue(() => aiKey(B), KEY_A);
    check.bGotIntervals = (await intervalsKey(B)) === INTERVALS;
    // 資料流向每台自己確認
    await E2E.settings(B.page, "AI 教練");
    check.bConsentNotCopied = !(await B.page.locator("#side-panel").getByLabel("我了解並同意以上的資料流向").isChecked());
    await B.page.screenshot({ path: `${E2E.OUT}/keys-B-mobile-light-ai.png` });
    // B 沒有自己打開：第一次送自己的之前要在 B 同意（拿 A 的照舊自動）
    await E2E.settings(B.page, "我的鑰匙與帳號");
    const askB = B.page.locator('#side-panel .secret-prompt[data-secret="share"]');
    check.bAskedBeforeUpload = await askB.waitFor({ timeout: 5000 }).then(() => true, () => false);
    await B.page.screenshot({ path: `${E2E.OUT}/keys-B-mobile-light-ask.png` });
    await askB.getByRole("button", { name: "這台也帶" }).click();
    check.bAskGone = await askB.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);

    // --- B 改 key → A 跟著換 ---
    step = "B 改 key";
    await setAiKey(B, KEY_B);
    await B.page.waitForTimeout(1500);
    await syncNow(B);
    const aToast = toast(A, /API key 已經更新成另一台設定的。/);
    await syncNow(A);
    check.aToastReplaced = await aToast;
    check.aGotBKey = await waitValue(() => aiKey(A), KEY_B);

    // --- B 換了服務網址 → A 不默默換，問要用哪一份 ---
    step = "換了服務網址";
    await E2E.settings(B.page, "AI 教練");
    await B.page.locator("#side-panel").getByLabel("服務網址").fill(`http://localhost:${MOCK_PORT}/v1`);
    await B.page.getByRole("button", { name: "儲存設定" }).click();
    await B.page.getByText("設定已儲存在這個瀏覽器。").first().waitFor();
    await B.page.waitForTimeout(1500);
    await syncNow(B);
    const askToast = toast(A, /另一台的 key 和這台的不一樣/);
    await syncNow(A);
    check.aAskedAboutRecipient = await askToast;
    await E2E.settings(A.page, "AI 教練");
    const prompt = A.page.locator('#side-panel .secret-prompt[data-secret="llm"]');
    check.promptShowsRecipient = await prompt.waitFor({ timeout: 5000 }).then(async () => (await prompt.innerText()).includes(`http://localhost:${MOCK_PORT}/v1`), () => false);
    check.aKeptOwnUntilAsked = (await A.page.locator("#side-panel").getByLabel("服務網址").inputValue()) === `${MOCK}/v1`;
    await A.page.screenshot({ path: `${E2E.OUT}/keys-A-prompt.png` });
    await prompt.getByRole("button", { name: "改用另一台的" }).click();
    check.aSwitchedAfterAccept = await waitValue(() => A.page.locator("#side-panel").getByLabel("服務網址").inputValue(), `http://localhost:${MOCK_PORT}/v1`);
    // 換了網址：資料流向要重新確認
    check.aConsentAskedAgain = !(await A.page.locator("#side-panel").getByLabel("我了解並同意以上的資料流向").isChecked());
    await A.page.locator("#side-panel").getByLabel("我了解並同意以上的資料流向").check();
    await A.page.getByRole("button", { name: "儲存設定" }).click();
    await A.page.getByText("設定已儲存在這個瀏覽器。").first().waitFor();

    // --- 一覽頁 ---
    step = "一覽頁";
    await E2E.settings(A.page, "我的鑰匙與帳號");
    const overview = A.page.locator("#side-panel .keys-overview");
    const rowText = (id) => overview.locator(`li[data-key="${id}"]`).innerText();
    check.overviewItems =
      JSON.stringify(await overview.locator("li").evaluateAll((els) => els.map((e) => e.dataset.key))) === JSON.stringify(["sync", "pair", "llm", "intervals", "lock"]);
    const llmRow = await rowText("llm");
    check.overviewLlm = /AI 的 API key/.test(llmRow) && /這台＋加密的同步/.test(llmRow) && /換手機\s*開了同步就自動回來/.test(llmRow) && /弄丟了/.test(llmRow) && /有/.test(llmRow);
    check.overviewLock = /密碼鎖[\s\S]*關/.test(await rowText("lock"));
    check.overviewSync = /同步金鑰與復原碼[\s\S]*有/.test(await rowText("sync"));
    await A.page.screenshot({ path: `${E2E.OUT}/keys-overview-desktop-light.png` });
    await A.page.emulateMedia({ colorScheme: "dark" });
    await A.page.screenshot({ path: `${E2E.OUT}/keys-overview-desktop-dark.png` });
    await A.page.emulateMedia({ colorScheme: "light" });
    await overview.locator('li[data-key="intervals"] button.list-row').click();
    check.overviewRowOpensSection = await A.page.locator("#side-panel .subpage .title", { hasText: "訓練紀錄" }).waitFor({ timeout: 3000 }).then(() => true, () => false);
    await E2E.settings(B.page, "我的鑰匙與帳號");
    await B.page.screenshot({ path: `${E2E.OUT}/keys-overview-mobile-light.png`, fullPage: true });
    check.noHorizontalScroll = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // --- A 取消勾選 → B 不再收到 ---
    step = "取消勾選";
    await A.sync();
    await shareBox(A).uncheck();
    check.unshareToast = await toast(A, /已刪掉雲端的 key/);
    await syncNow(A);
    await syncNow(B);
    check.bShareFollows = await waitValue(async () => !(await shareBox(B).isChecked()), true);
    await B.page.screenshot({ path: `${E2E.OUT}/keys-B-mobile-light-unshared.png` });
    await setAiKey(B, KEY_B2);
    await B.page.waitForTimeout(1500);
    await syncNow(B);
    await syncNow(A);
    await A.page.waitForTimeout(1500);
    check.aNotReceivedAfterUnshare = (await aiKey(A)) === KEY_B;
    await E2E.settings(A.page, "我的鑰匙與帳號");
    check.overviewSaysRetype = /要重新填/.test(await rowText("llm"));

    // --- 再勾回來；C 開了密碼鎖，用復原碼還原 ---
    step = "C 密碼鎖";
    await A.sync();
    await shareBox(A).check();
    await toast(A, /會帶到其他裝置/);
    await A.page.waitForTimeout(1500);
    await syncNow(A);
    const C = await device("C", { ua: UA.edge, scheme: "dark" });
    await open(C);
    await E2E.settings(C.page, "密碼鎖");
    const lockCard = C.page.locator('#side-panel .subpage[data-section="lock"] section.card');
    await lockCard.getByLabel("密碼", { exact: true }).fill(PASSWORD);
    await lockCard.getByLabel("再輸入一次", { exact: true }).fill(PASSWORD);
    await lockCard.getByRole("button", { name: "啟用密碼鎖" }).click();
    await lockCard.getByRole("button", { name: "停用密碼鎖" }).waitFor({ timeout: 20000 });
    await C.sync();
    await C.card.getByRole("button", { name: "用復原碼還原" }).click();
    await C.card.getByLabel("復原碼").fill(recovery);
    const cToast = toast(C, /已從另一台帶入 API key/, 20000);
    await C.card.getByRole("button", { name: "還原" }).click();
    await C.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    check.cToast = await cToast;
    check.cGotKey = await waitValue(() => aiKey(C), KEY_B);
    const cStored = await C.page.evaluate(() => Object.keys(localStorage).map((k) => localStorage.getItem(k)).join("\n"));
    check.cOnlyCiphertextInBrowser = !cStored.includes(KEY_B) && !cStored.includes(INTERVALS);
    await C.page.screenshot({ path: `${E2E.OUT}/keys-C-desktop-dark.png` });
    await C.page.reload();
    await C.page.getByLabel("密碼").fill(PASSWORD);
    await C.page.getByRole("button", { name: "解鎖" }).click();
    await C.page.locator("nav.tabbar button").first().waitFor({ timeout: 20000 });
    check.cKeyAfterUnlock = (await aiKey(C)) === KEY_B;
    await E2E.settings(C.page, "我的鑰匙與帳號");
    check.cOverviewLockOn = /用密碼鎖加密/.test(await C.page.locator('#side-panel .keys-overview li[data-key="llm"]').innerText());
    await C.page.screenshot({ path: `${E2E.OUT}/keys-overview-desktop-dark-locked.png` });

    step = "同步服務的內容";
    const all = syncBodies.join("\n");
    check.noPlainKeysToSync = syncBodies.length > 0 && ![KEY_A, KEY_B, KEY_B2, INTERVALS].some((k) => all.includes(k));
  } catch (e) {
    problems.push(`FAILED at [${step}]: ${e.message.split("\n")[0]}`);
    for (const ctx of browser.contexts()) for (const p of ctx.pages()) {
      const errors = await p.locator(".notice.error").allInnerTexts().catch(() => []);
      if (errors.length) problems.push(`畫面上的錯誤：${errors.join(" / ")}`);
    }
  } finally {
    await browser.close();
    for (const c of children) stop(c);
  }
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  const ok = Object.values(check).length > 0 && Object.values(check).every(Boolean) && problems.length === 0;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
