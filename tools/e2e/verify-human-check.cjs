// 驗證人機驗證（Cloudflare Turnstile，規格 12.10）：開始同步（建立同步空間）與開配對碼之前顯示，通過後才進行；
// 失敗時有說明與「重試」；取消回到原本的畫面；同步服務沒有 token、不是 JSON 的請求拒絕；
// CSP 只在有 site key 的建置允許 challenges.cloudflare.com；手機深色、電腦淺色的截圖（human-*）。
//
// 這個腳本自己開一份模擬上游（8797 埠，MOCK_TURNSTILE=1：同步服務照 Turnstile 官方的測試 secret 驗證、不連網路）
// 並建置一份帶 Turnstile 測試 site key 的網頁版（4186 埠）。瀏覽器裡 Turnstile 的腳本換成假的（不連 Cloudflare）：
// 它照官方測試 key 的行為給 XXXX.DUMMY.TOKEN.XXXX，或照 window.__humanMode = "fail" 回失敗。
// 一般建置的檢查用 npm run dev:mock 與 4173（E2E_URL）。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4186;
const MOCK_PORT = 8797;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const URL = `http://localhost:${PORT}/`;
const TEST_SITE_KEY = "1x00000000000000000000AA";

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
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_TURNSTILE: "1" },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-human");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${MOCK}/intervals`,
      VITE_SYNC_URL: `${MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${MOCK}/weather`,
      VITE_TURNSTILE_SITE_KEY: TEST_SITE_KEY,
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore", detached: true });
  await waitFor(URL);
  return child;
}

/** 假的 Turnstile：照官方測試 site key 的行為（一定通過，給 dummy token）；__humanMode = "fail" 時回失敗 */
const FAKE_TURNSTILE = `
window.turnstile = {
  render(el, opts) {
    const box = document.createElement("div");
    box.className = "fake-turnstile";
    box.textContent = "Cloudflare 驗證中…";
    box.style.border = "1px solid #94a3b8";
    box.style.borderRadius = "4px";
    box.style.padding = "20px 12px";
    box.style.fontSize = "14px";
    el.appendChild(box);
    window.__humanRenders = (window.__humanRenders || []).concat([{ sitekey: opts.sitekey, action: opts.action }]);
    const timer = setTimeout(() => {
      if (window.__humanMode === "fail") {
        box.textContent = "驗證失敗";
        opts["error-callback"] && opts["error-callback"]("110200");
      } else {
        box.textContent = "成功！";
        opts.callback && opts.callback("XXXX.DUMMY.TOKEN.XXXX");
      }
    }, window.__humanDelay || 400);
    box.dataset.timer = String(timer);
    return String(window.__humanRenders.length);
  },
  remove() {},
};
`;

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
  let turnstileLoads = 0;

  const device = async (name, { mobile = false, scheme = "light" } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    // Turnstile 的腳本換成假的（CSP 照樣檢查這個網址）；其他連到 Cloudflare 的請求都不應該出現
    await context.route("https://challenges.cloudflare.com/**", (route) => {
      const url = route.request().url();
      if (url.startsWith("https://challenges.cloudflare.com/turnstile/v0/api.js")) {
        turnstileLoads++;
        return route.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_TURNSTILE });
      }
      problems.push(`[${name}] 沒預期的請求：${url}`);
      return route.abort();
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      // 沒有 token 的請求：伺服器回 403，瀏覽器會自己記一筆
      if (/\b(403|415)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const tab = (label) => (label === "設定" ? E2E.settings(page, "多裝置同步") : E2E.go(page, label));
    const card = page.locator('#side-panel .subpage[data-section="sync"] section.card');
    return { name, page, tab, card, context };
  };
  const setup = async (d) => {
    await d.page.goto(URL);
    await d.page.locator("nav.tabbar button").first().waitFor();
    await E2E.settings(d.page, "訓練紀錄");
    await d.page.getByLabel("API key", { exact: true }).fill("mock-intervals-key");
    await d.page.getByRole("button", { name: "儲存設定" }).click();
    await d.page.getByText("設定已儲存在這個瀏覽器。").waitFor();
    await d.tab("設定");
  };

  try {
    step = "CSP";
    const html = await (await fetch(URL)).text();
    const csp = (/http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? "").replace(/&#39;|&#x27;/g, "'");
    check.cspScriptAllowsTurnstile = /script-src [^;]*https:\/\/challenges\.cloudflare\.com/.test(csp);
    check.cspFrameAllowsTurnstile = /frame-src https:\/\/challenges\.cloudflare\.com/.test(csp);
    const plain = await (await fetch(E2E.URL)).text().catch(() => "");
    check.plainBuildNoTurnstileInCsp = plain.includes("Content-Security-Policy") && !plain.includes("challenges.cloudflare.com");

    step = "同步服務：沒有 token、不是 JSON";
    const pairBody = JSON.stringify({ pub: "PUB", commitment: "C" });
    const noToken = await fetch(`${MOCK}/sync/v1/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: pairBody });
    check.serverRejectsPairWithoutToken = noToken.status === 403 && (await noToken.json()).state === "human_check";
    const createNoToken = await fetch(`${MOCK}/sync/v1/spaces/${"a".repeat(32)}?create=1`, { method: "PUT", headers: { authorization: `Bearer ${"t".repeat(43)}` } });
    check.serverRejectsCreateWithoutToken = createNoToken.status === 403;
    const textPlain = await fetch(`${MOCK}/sync/v1/pair`, { method: "POST", headers: { "content-type": "text/plain", "x-turnstile": "XXXX.DUMMY.TOKEN.XXXX" }, body: pairBody });
    check.serverRejectsTextPlain = textPlain.status === 415;

    // --- A（電腦淺色）：開始同步前先通過人機驗證 ---
    step = "A 開始同步";
    const A = await device("A");
    await setup(A);
    check.noScriptBeforeNeeded = turnstileLoads === 0;
    await A.page.evaluate(() => (window.__humanDelay = 1500));
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    await A.card.locator(".human-check").waitFor({ timeout: 5000 });
    check.aShowsCheck = await A.card.getByText("先確認你不是機器人，通常幾秒內會自動完成。").isVisible();
    await A.card.locator(".fake-turnstile").waitFor({ timeout: 5000 });
    await A.page.screenshot({ path: `${E2E.OUT}/human-A-start-check.png` });
    // 取消：回到原本的畫面，沒有建立
    await A.card.getByRole("button", { name: "取消" }).click();
    check.aCancelBack = await A.card.getByRole("button", { name: "這是第一台：開始同步" }).isVisible();
    await A.page.waitForTimeout(1800);
    check.aCancelNoCode = (await A.card.locator(".recovery-code").count()) === 0;
    await A.page.evaluate(() => (window.__humanDelay = 400));
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    await A.card.locator(".recovery-code").waitFor({ timeout: 10000 });
    const renders = await A.page.evaluate(() => window.__humanRenders);
    check.aSiteKeyAndAction = renders.every((r) => r.sitekey === TEST_SITE_KEY) && renders.at(-1).action === "create-space";
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    check.aSyncing = true;

    // --- B（手機深色）：配對前的人機驗證，第一次失敗、重試後通過 ---
    step = "B 加入（驗證失敗、重試）";
    const B = await device("B", { mobile: true, scheme: "dark" });
    await B.context.addInitScript(() => (window.__humanMode = "fail"));
    await setup(B);
    await B.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    await B.card.getByText(/人機驗證沒有完成/).waitFor({ timeout: 5000 });
    check.bFailureExplained = (await B.card.locator(".pair-code").count()) === 0;
    await B.page.screenshot({ path: `${E2E.OUT}/human-B-pair-failed.png` });
    await B.page.evaluate(() => (window.__humanMode = "pass"));
    await B.card.getByRole("button", { name: "重試" }).click();
    await B.card.locator(".pair-code").waitFor({ timeout: 10000 });
    check.bRetryWorks = true;
    check.bPairAction = (await B.page.evaluate(() => window.__humanRenders.at(-1).action)) === "pair";
    check.noHorizontalScroll = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    await B.page.screenshot({ path: `${E2E.OUT}/human-B-pair-code.png` });

    step = "A 把同步傳給 B";
    const code = (await B.card.locator(".pair-code").innerText()).trim();
    await A.card.getByRole("button", { name: "新增裝置" }).click();
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByLabel("新裝置上顯示的配對碼").fill(code);
    await A.card.getByRole("button", { name: "下一步" }).click();
    const numbers = (await B.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    await A.card.getByLabel("新裝置上顯示的六位數字").fill(numbers);
    await A.card.getByRole("button", { name: "傳送" }).click();
    await A.card.getByText("已傳送").waitFor();
    await B.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await B.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    check.bJoined = true;
    // 舊裝置（A）那邊的配對步驟不用驗證：只有開配對碼的新裝置要
    check.aNoCheckWhenAdding = (await A.page.evaluate(() => window.__humanRenders.length)) === renders.length;

    // --- C（電腦深色）：取消配對前的驗證 ---
    step = "C 取消";
    const C = await device("C", { scheme: "dark" });
    await C.context.addInitScript(() => (window.__humanDelay = 60000));
    await setup(C);
    await C.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    await C.card.locator(".fake-turnstile").waitFor({ timeout: 5000 });
    await C.page.screenshot({ path: `${E2E.OUT}/human-C-pair-check-dark.png` });
    await C.card.getByRole("button", { name: "取消" }).click();
    check.cCancelBack = await C.card.getByRole("button", { name: "加入已經在同步的裝置" }).isVisible();
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
