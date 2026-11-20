// 驗證換金鑰可以跨天完成、移除馬上生效（規格 12.10「換金鑰可以跨天完成」，功能開關 devices）：
// - A 開始同步、B 用復原碼還原；過了冷卻期 A 移除 B，而今天換金鑰的額度不夠（模擬上游 MOCK_SYNC_REKEY_WRITES=1）
// - 移除馬上生效：A 看到「那台已經不能再同步」、B 重新整理就顯示已移除；換金鑰停下來：「今天完成 n／N 筆，明天會自動接著做」
// - 換好之前用舊的復原碼加入新的裝置（C）不行；A 重新整理後狀態還在
// - 隔天（模擬上游的時間推到下一個 UTC 日、額度放寬；A 的時鐘往後撥）A 自動接著做完，出現新的復原碼；B 仍然是已移除
// - 截圖（rekey-days-*）
// 這個腳本自己開一份模擬上游（8796 埠，冷卻期 20 秒）並建置一份開著 devices 的網頁版（4178 埠）
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4178;
const MOCK_PORT = 8796;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const URL = `http://localhost:${PORT}/`;
const COOLDOWN_MS = 20_000;

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
  mac: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
};

let step = "start";

/** 停掉自己開的程序（整個程序群組） */
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
    // 自己一個程序群組：結束時連 npx 底下的 tsx 一起停（不然下次跑時舊的模擬上游還佔著埠）
    detached: true,
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SYNC_COOLDOWN_MS: String(COOLDOWN_MS), MOCK_SYNC_REKEY_WRITES: "1" },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-rekey-days");
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

  const device = async (name, { mobile = false, ua, scheme = "light", url = URL, clock = false } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      userAgent: ua,
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    // A 的時鐘之後要往後撥一天（Playwright 的 clock：時間照常走，可以跳到之後）
    if (clock) await context.clock.install();
    const page = await context.newPage();
    page.on("console", (m) => {
      // 被移除、舊的復原碼：伺服器回 410／403，瀏覽器會自己記一筆
      // 今天的額度用完（503 rekey_limit）、時鐘往後撥之後第一個簽章（401，以伺服器的時間校正後重送）
      if (/\b(410|409|403|404|503|401)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    // 設定的第一層是清單（規格 12.28）：「設定」直接進到「多裝置同步」
    const tab = (label) => (label === "設定" ? E2E.settings(page, "多裝置同步") : E2E.go(page, label));
    const card = page.locator('#side-panel .subpage[data-section="sync"] section.card');
    const d = { name, page, tab, card, context, url };
    return d;
  };
  const setup = async (d) => {
    await d.page.goto(d.url);
    await d.page.locator("nav.tabbar button").first().waitFor();
    await E2E.settings(d.page, "訓練紀錄");
    await d.page.getByLabel("API key", { exact: true }).fill("mock-intervals-key");
    await d.page.getByRole("button", { name: "儲存設定" }).click();
    await d.page.getByText("設定已儲存在這個瀏覽器。").waitFor();
    await d.tab("設定");
  };
  const syncNow = async (d) => {
    await d.tab("設定");
    const before = await d.card.innerText();
    await d.card.getByRole("button", { name: "立即同步裝置" }).click();
    await d.card.getByRole("button", { name: "立即同步裝置" }).waitFor({ timeout: 15000 });
    return before;
  };
  const rows = (d) => d.card.locator("li.device");
  const rowNames = async (d) => (await rows(d).locator(".device-name").allInnerTexts()).map((t) => t.trim());
  const waitNames = async (d, expected) => {
    for (let i = 0; i < 40; i++) {
      const names = await rowNames(d);
      if (JSON.stringify([...names].sort()) === JSON.stringify([...expected].sort())) return true;
      await d.page.waitForTimeout(250);
    }
    console.log(`  ${d.name} 的清單：${JSON.stringify(await rowNames(d))}`);
    return false;
  };
  const profileIntensity = (d) => d.page.locator("label", { hasText: /^強度/ }).locator("select");

  try {
    step = "A 開始同步";
    const A = await device("A", { ua: UA.mac, clock: true });
    await setup(A);
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card.locator(".recovery-code").innerText()).trim();
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    const startedAt = Date.now();
    await E2E.profile(A.page, "練什麼、怎麼練");
    await A.page.waitForTimeout(300);
    await profileIntensity(A).selectOption("challenge");
    await E2E.profileSave(A.page);
    await A.page.locator(".toast", { hasText: /^\s*已儲存\s*$/ }).first().waitFor();
    await syncNow(A);

    step = "B 用復原碼還原";
    const B = await device("B", { mobile: true, ua: UA.iphone });
    await setup(B);
    await B.card.getByRole("button", { name: "用復原碼還原" }).click();
    await B.card.getByLabel("復原碼").fill(recovery);
    await B.card.getByRole("button", { name: "還原" }).click();
    await B.card.getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    await syncNow(A);
    check.aListsBoth = await waitNames(A, ["Mac · Edge", "iPhone · Safari"]);

    step = "A 移除 B（今天的額度不夠）";
    const waitLeft = COOLDOWN_MS - (Date.now() - startedAt) + 1500;
    if (waitLeft > 0) await A.page.waitForTimeout(waitLeft);
    await syncNow(A);
    await rows(A).filter({ hasText: "iPhone · Safari" }).getByRole("button", { name: "移除" }).click();
    await A.card.getByRole("button", { name: "移除並換金鑰" }).click();
    const status = A.card.locator(".rekey-status");
    check.aShowsRemovedNow = await status.getByText(/已經移除「iPhone · Safari」：那台已經不能再同步。/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    check.aShowsPaused = await status.getByText(/正在用新的金鑰重新加密資料：今天完成 \d+／\d+ 筆，明天會自動接著做。/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    check.aListWithoutB = await waitNames(A, ["Mac · Edge"]);
    check.noNewCodeYet = (await A.card.locator(".new-code").count()) === 0;
    await A.card.locator(".rekey-status").scrollIntoViewIfNeeded();
    await A.page.screenshot({ path: `${E2E.OUT}/rekey-days-A-paused-desktop-light.png` });

    step = "B 馬上被移除";
    await B.page.reload();
    check.bRemovedNow = await B.page.locator(".removed-banner").waitFor({ timeout: 20000 }).then(async () => /這台已從多裝置同步移除/.test(await B.page.locator(".removed-banner").innerText()), () => false);

    step = "C 用舊的復原碼（換好之前）";
    const C = await device("C", { ua: UA.edge, scheme: "dark" });
    await setup(C);
    await C.card.getByRole("button", { name: "用復原碼還原" }).click();
    await C.card.getByLabel("復原碼").fill(recovery);
    await C.card.getByRole("button", { name: "還原" }).click();
    check.cCannotJoinDuringRekey = await C.card.getByText(/正在換新的同步金鑰，換好之後才能加入新的裝置/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    await C.page.screenshot({ path: `${E2E.OUT}/rekey-days-C-blocked-desktop-dark.png` });

    step = "A 重新整理";
    await A.page.reload();
    await A.page.locator("nav.tabbar button").first().waitFor();
    await A.tab("設定");
    check.aPausedAfterReload = await A.card.locator(".rekey-status").getByText(/明天會自動接著做/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    check.aCanCancel = await A.card.getByRole("button", { name: "放棄換金鑰" }).isVisible();
    await A.page.emulateMedia({ colorScheme: "dark" });
    await A.page.screenshot({ path: `${E2E.OUT}/rekey-days-A-paused-desktop-dark.png` });
    await A.page.emulateMedia({ colorScheme: "light" });

    step = "隔天自動接著做";
    await fetch(`${MOCK}/mock-sync/next-day?rekeyWrites=1000000`, { method: "POST" });
    await A.page.clock.fastForward(26 * 3600_000);
    await A.card.locator(".new-code .recovery-code").waitFor({ timeout: 30000 });
    const newRecovery = (await A.card.locator(".new-code .recovery-code").innerText()).trim();
    check.newRecoveryDiffers = newRecovery !== recovery;
    await A.card.getByLabel("我已經把新的復原碼存好了").check();
    await A.card.getByRole("button", { name: "完成" }).click();
    check.statusGone = await A.card.locator(".rekey-status").waitFor({ state: "detached", timeout: 10000 }).then(() => true, () => false);
    await syncNow(A);
    check.aStillSyncing = !(await A.card.locator(".notice.error").count());
    await E2E.profile(A.page, "練什麼、怎麼練");
    check.aDataKept = (await profileIntensity(A).inputValue()) === "challenge";

    step = "B 仍然是已移除";
    await B.page.reload();
    check.bStillRemoved = await B.page.locator(".removed-banner").waitFor({ timeout: 20000 }).then(() => true, () => false);
    check.noHorizontalScroll = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
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
