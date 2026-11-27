// 驗證換金鑰進行中的新同步金鑰的存放（規格 12.10「換金鑰跨天完成」，功能開關 devices）：
// - A 開始同步、B 用復原碼還原；A 開密碼鎖；過了冷卻期 A 移除 B，今天換金鑰的額度不夠（MOCK_SYNC_REKEY_WRITES=1），停下來
// - 換金鑰進行中：新的同步金鑰（由新的復原碼算出）不在 localStorage 的明文裡，也不在這台的資料庫檔（OPFS）裡；
//   資料庫裡有換金鑰的進度（rekey_pending）
// - 換金鑰進行中按「匯出資料庫」：匯出的檔案沒有新的金鑰、沒有 rekey_pending，sync_meta 只留不含金鑰的鍵
// - 隔天（模擬上游推到下一個 UTC 日、A 的時鐘往後撥）重新整理：鎖著時不接著做；解鎖後自動接著做完，清單只剩 A，B 仍是已移除
// - 截圖（rekey-key-*）
// 這個腳本自己開一份模擬上游（8793 埠，冷卻期 20 秒）並建置一份開著 devices 的網頁版（4189 埠）
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4189;
const MOCK_PORT = 8793;
const MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const URL = `http://localhost:${PORT}/`;
const COOLDOWN_MS = 20_000;
const PASSWORD = "correct horse";
const DAY = 86_400_000;

const UA = {
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
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
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SYNC_COOLDOWN_MS: String(COOLDOWN_MS), MOCK_SYNC_REKEY_WRITES: "1" },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-rekey-key");
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

/** 復原碼 → 同步金鑰（base64url），用核心的程式算 */
function rootOf(code) {
  const script = `import { parseRecoveryCode, toBase64url } from "./packages/core/src/device-sync/crypto.ts"; void parseRecoveryCode(${JSON.stringify(code)}).then((r) => process.stdout.write(r ? toBase64url(r) : ""));`;
  return execFileSync("npx", ["tsx", "--eval", script], { cwd: ROOT, encoding: "utf8" }).trim();
}

/** 這個 context 的 OPFS 裡全部檔案的內容（資料庫在裡面）. 先關掉 App 的分頁（放開資料庫），從同一個網址的靜態檔讀 */
async function opfsBytes(context) {
  const page = await context.newPage();
  await page.goto(`${URL}favicon-32.png`);
  const base64 = await page.evaluate(async () => {
    const chunks = [];
    const walk = async (dir) => {
      for await (const [, handle] of dir.entries()) {
        if (handle.kind === "directory") await walk(handle);
        else chunks.push(new Uint8Array(await (await handle.getFile()).arrayBuffer()));
      }
    };
    await walk(await navigator.storage.getDirectory());
    let text = "";
    for (const c of chunks) for (let i = 0; i < c.length; i += 0x8000) text += String.fromCharCode(...c.subarray(i, i + 0x8000));
    return btoa(text);
  });
  await page.close();
  return Buffer.from(base64, "base64");
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

  const device = async (name, { mobile = false, ua, clock = false } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      userAgent: ua,
      timezoneId: "Asia/Taipei",
      acceptDownloads: true,
    });
    if (clock) await context.clock.install();
    const page = await context.newPage();
    const watch = (p) => {
      p.on("console", (m) => {
        if (/\b(410|409|403|404|503|401)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
        if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
      });
      p.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
      p.on("dialog", (d) => void d.accept());
    };
    watch(page);
    const d = { name, page, context, watch };
    d.tab = (label) => (label === "設定" ? E2E.settings(d.page, "多裝置同步") : E2E.go(d.page, label));
    d.card = () => d.page.locator('#side-panel .subpage[data-section="sync"] section.card');
    return d;
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
  const syncNow = async (d) => {
    await d.tab("設定");
    await d.card().getByRole("button", { name: "立即同步裝置" }).click();
    await d.card().getByRole("button", { name: "立即同步裝置" }).waitFor({ timeout: 15000 });
  };
  const rowNames = async (d) => (await d.card().locator("li.device .device-name").allInnerTexts()).map((t) => t.trim());
  const waitNames = async (d, expected) => {
    for (let i = 0; i < 60; i++) {
      const names = await rowNames(d);
      if (JSON.stringify([...names].sort()) === JSON.stringify([...expected].sort())) return true;
      await d.page.waitForTimeout(250);
    }
    console.log(`  ${d.name} 的清單：${JSON.stringify(await rowNames(d))}`);
    return false;
  };

  try {
    step = "A 開始同步";
    const A = await device("A", { ua: UA.mac, clock: true });
    await setup(A);
    await A.card().getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card().locator(".recovery-code").innerText()).trim();
    await A.card().getByLabel("我已經把復原碼存好了").check();
    await A.card().getByRole("button", { name: "開始同步" }).click();
    await A.card().getByText(/上次同步 \d/).waitFor({ timeout: 15000 });
    const startedAt = Date.now();

    step = "B 用復原碼還原";
    const B = await device("B", { mobile: true, ua: UA.iphone });
    await setup(B);
    await B.card().getByRole("button", { name: "用復原碼還原" }).click();
    await B.card().getByLabel("復原碼").fill(recovery);
    await B.card().getByRole("button", { name: "還原" }).click();
    await B.card().getByText(/上次同步 \d/).waitFor({ timeout: 15000 });

    step = "A 開密碼鎖";
    await E2E.settings(A.page, "密碼鎖");
    const lockCard = A.page.locator('#side-panel .subpage[data-section="lock"] section.card');
    await lockCard.getByLabel("密碼", { exact: true }).fill(PASSWORD);
    await lockCard.getByLabel("再輸入一次", { exact: true }).fill(PASSWORD);
    await lockCard.getByRole("button", { name: "啟用密碼鎖" }).click();
    await lockCard.getByRole("button", { name: "停用密碼鎖" }).waitFor({ timeout: 30000 });
    await syncNow(A);
    check.aListsBoth = await waitNames(A, ["Mac · Edge", "iPhone · Safari"]);

    step = "A 移除 B（今天的額度不夠）";
    const waitLeft = COOLDOWN_MS - (Date.now() - startedAt) + 1500;
    if (waitLeft > 0) await A.page.waitForTimeout(waitLeft);
    await syncNow(A);
    await A.card().locator("li.device").filter({ hasText: "iPhone · Safari" }).getByRole("button", { name: "移除" }).click();
    await A.card().getByLabel(/再輸入一次密碼鎖的密碼，才移除/).fill(PASSWORD);
    // 開著密碼鎖：輸入密碼按「確認」就是確認移除
    await A.card().getByRole("button", { name: "確認" }).click();
    await A.card().locator(".remove-code .recovery-code").waitFor({ timeout: 20000 });
    const newRecovery = (await A.card().locator(".remove-code .recovery-code").innerText()).trim();
    await A.card().getByLabel("我已經把新的復原碼存好了").check();
    await A.card().getByRole("button", { name: "存好了，移除" }).click();
    const status = A.card().locator(".rekey-status");
    check.aPaused = await status.getByText(/明天打開時會自動接著做/).waitFor({ timeout: 20000 }).then(() => true, () => false);
    await A.page.screenshot({ path: `${E2E.OUT}/rekey-key-A-paused-desktop-light.png` });
    const newRoot = rootOf(newRecovery);
    const oldRoot = rootOf(recovery);
    check.rootComputed = newRoot.length === 43 && oldRoot.length === 43 && newRoot !== oldRoot;

    step = "localStorage 沒有新金鑰的明文";
    const storage = await A.page.evaluate(() => Object.keys(localStorage).map((k) => `${k}=${localStorage.getItem(k)}`).join("\n"));
    check.storageHasNoNewKey = !storage.includes(newRoot);
    check.storageHasNoSyncKey = !storage.includes(oldRoot);

    step = "換金鑰進行中匯出資料庫";
    await E2E.settings(A.page, "資料");
    const [download] = await Promise.all([A.page.waitForEvent("download"), A.page.getByRole("button", { name: "匯出資料庫" }).click()]);
    const exportedPath = path.join(E2E.OUT, "rekey-key-export.db");
    await download.saveAs(exportedPath);
    const exported = fs.readFileSync(exportedPath);
    check.exportHasNoNewKey = exported.length > 0 && !exported.includes(Buffer.from(newRoot));
    check.exportHasNoPending = !exported.includes(Buffer.from("rekey_pending"));
    check.exportHasSyncSpace = exported.includes(Buffer.from("known_devices"));
    try {
      const Database = require(require.resolve("better-sqlite3", { paths: [ROOT] }));
      const db = new Database(exportedPath, { readonly: true });
      const keys = db.prepare("SELECT k FROM sync_meta ORDER BY k").all().map((r) => r.k);
      console.log(`  匯出的 sync_meta：${keys.join(", ")}`);
      check.exportMetaSafeKeys = keys.length > 0 && keys.every((k) => ["space", "last_seq", "last_sync", "gone", "known_devices"].includes(k));
      db.close();
    } catch (e) {
      problems.push(`讀不了匯出的檔案：${e.message}`);
    }

    step = "這台的資料庫檔";
    await A.page.close();
    const live = await opfsBytes(A.context);
    check.liveDbHasPending = live.includes(Buffer.from("rekey_pending"));
    check.liveDbHasNoNewKey = !live.includes(Buffer.from(newRoot));
    check.liveDbHasNoRootField = !live.includes(Buffer.from('"root":"'));

    step = "隔天重新整理：鎖著時不接著做，解鎖後接著做完";
    await fetch(`${MOCK}/mock-sync/next-day?rekeyWrites=1000000`, { method: "POST" });
    await A.context.clock.fastForward(DAY + 60_000);
    A.page = await A.context.newPage();
    A.watch(A.page);
    const syncRequests = [];
    A.page.on("request", (r) => r.url().startsWith(`${MOCK}/sync/`) && syncRequests.push(r.url()));
    await A.page.goto(URL);
    await A.page.getByRole("button", { name: "解鎖" }).waitFor({ timeout: 20000 });
    await A.page.waitForTimeout(3000);
    // 鎖著：連同步服務都不連（同步金鑰與新金鑰都還讀不到）
    check.lockedNoSync = syncRequests.length === 0;
    await A.page.screenshot({ path: `${E2E.OUT}/rekey-key-A-locked-desktop-light.png` });
    await A.page.getByLabel("密碼").fill(PASSWORD);
    await A.page.getByRole("button", { name: "解鎖" }).click();
    await A.page.locator(".tabbar").waitFor({ timeout: 30000 });
    await A.tab("設定");
    check.aFinishedAfterUnlock = await A.card().getByText(/換金鑰完成。新的復原碼就是移除時存好的那一組/).waitFor({ timeout: 40000 }).then(() => true, () => false);
    await A.page.screenshot({ path: `${E2E.OUT}/rekey-key-A-finished-desktop-light.png` });
    await syncNow(A);
    check.aListOnlyA = await waitNames(A, ["Mac · Edge"]);
    check.aNoError = !(await A.card().locator(".notice.error").count());

    step = "B 仍然是已移除";
    await B.page.reload();
    check.bRemoved = await B.page.locator(".removed-banner").waitFor({ timeout: 20000 }).then(() => true, () => false);
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
