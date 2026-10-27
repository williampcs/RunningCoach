// 驗證多裝置同步的裝置清單與移除某台（規格 12.27，功能開關 devices）：
// - A 開始同步、B 用配對碼加入（iPhone）、C 用復原碼還原（Windows · Edge）；清單列出每台與「這台」，加入與最後同步的時間
// - 新裝置加入時其他裝置的提醒（頁面上方）、「是我的」、「查看與移除」打開設定；改名在別台也看得到
// - 冷卻期內的裝置不能移除別台、不能換金鑰（測試把 24 小時縮成 20 秒）
// - A 移除 C：新的復原碼（存好才能完成）、B 不用重新配對繼續同步、C 下次打開資料清空並顯示已移除、
//   C 用舊的復原碼不能再加入、新的復原碼可以還原；只換金鑰
// - 開關關著的一般建置（E2E_URL）沒有裝置清單
// - 手機與電腦、淺色與深色的截圖（devices-*）
// 這個腳本自己開一份模擬上游（8798 埠，冷卻期 20 秒）並建置一份開著 devices 的網頁版（4177 埠）；
// 開關關著的檢查用一般的建置與模擬上游（npm run dev:mock、4173）。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4177;
const MOCK_PORT = 8798;
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
    env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_SYNC_COOLDOWN_MS: String(COOLDOWN_MS) },
  });
  await waitFor(`${MOCK}/sync/v1/pair/AAAAAAAA`);
  return child;
}

function build() {
  const outDir = path.join(E2E.OUT, "dist-devices");
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

  const device = async (name, { mobile = false, ua, scheme = "light", url = URL } = {}) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      userAgent: ua,
      colorScheme: scheme,
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      // 被移除、舊的復原碼：伺服器回 410／403，瀏覽器會自己記一筆
      if (/\b(410|403|404)\b/.test(m.text()) && /Failed to load resource/.test(m.text())) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const tab = (label) => E2E.go(page, label);
    const card = page.locator("section.card", { has: page.getByRole("heading", { name: "多裝置同步" }) });
    const d = { name, page, tab, card, context, url };
    return d;
  };
  const setup = async (d) => {
    await d.page.goto(d.url);
    await d.page.locator("nav.tabbar button").first().waitFor();
    await d.tab("設定");
    await d.page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
    await d.page.getByLabel("我了解並同意以上的資料流向").check();
    await d.page.getByRole("button", { name: "儲存設定" }).click();
    await d.page.getByText("設定已儲存在這個瀏覽器。").waitFor();
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
    // --- A：第一台 ---
    step = "A 開始同步";
    const A = await device("A", { ua: UA.mac });
    await setup(A);
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card.locator(".recovery-code").innerText()).trim();
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    const startedAt = Date.now();
    check.aListsItself = await waitNames(A, ["Mac · Edge"]);
    check.aThisDevice = (await rows(A).first().locator(".badge", { hasText: "這台" }).count()) === 1;
    check.aJoinedAndSeen = /加入 \d+\/\d+.*最後同步 \d+\/\d+/.test(await rows(A).first().innerText());
    // 第一台也受冷卻期限制：只換金鑰的按鈕停用、說明還要等多久
    check.aCooldownNote = await A.card.locator(".cooldown-note").isVisible();
    check.aRekeyDisabledInCooldown = await A.card.getByRole("button", { name: /只換金鑰/ }).isDisabled();

    step = "A 的資料";
    await A.tab("選手資料");
    await A.page.locator("section.training-values").waitFor({ timeout: 10000 });
    await A.page.waitForTimeout(300);
    await profileIntensity(A).selectOption("challenge");
    await A.page.getByRole("button", { name: "儲存選手資料" }).click();
    await A.page.locator(".notice.ok", { hasText: "已儲存" }).waitFor();
    await syncNow(A);

    // --- B：配對加入（iPhone） ---
    step = "B 配對加入";
    const B = await device("B", { mobile: true, ua: UA.iphone });
    await setup(B);
    await B.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    const code = (await B.card.locator(".pair-code").innerText({ timeout: 10000 })).trim();
    await A.tab("設定");
    await A.card.getByRole("button", { name: "新增裝置" }).click();
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByLabel("新裝置上顯示的配對碼").fill(code);
    await A.card.getByRole("button", { name: "下一步" }).click();
    const digits = (await B.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    await A.card.getByLabel("新裝置上顯示的六位數字").fill(digits);
    await A.card.getByRole("button", { name: "傳送" }).click();
    await A.card.getByText("已傳送").waitFor();
    await B.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await B.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    await A.card.getByRole("button", { name: "完成" }).click();
    check.bListsBoth = await waitNames(B, ["Mac · Edge", "iPhone · Safari"]);
    check.bThisDeviceIsItself = (await rows(B).filter({ hasText: "iPhone · Safari" }).locator(".badge", { hasText: "這台" }).count()) === 1;
    check.bCooldownNote = await B.card.locator(".cooldown-note").isVisible();
    await B.tab("選手資料");
    await B.page.locator("section.training-values").waitFor({ timeout: 10000 });
    check.bGotData = await profileIntensity(B)
      .evaluate((el) => new Promise((resolve) => {
        const start = Date.now();
        const tick = () => (el.value === "challenge" ? resolve(true) : Date.now() - start > 8000 ? resolve(false) : setTimeout(tick, 200));
        tick();
      }));

    // --- A 看到新裝置的提醒 ---
    step = "新裝置的提醒";
    await syncNow(A);
    const banner = A.page.locator(".new-device-banner");
    check.aSeesNewDeviceBanner = await banner.waitFor({ timeout: 10000 }).then(async () => /新裝置加入同步：iPhone · Safari（\d+\/\d+/.test(await banner.innerText()), () => false);
    check.aRowMarkedNew = (await rows(A).filter({ hasText: "iPhone · Safari" }).locator(".badge", { hasText: "新加入" }).count()) === 1;
    // 提醒在頁面上方（設定面板開著時底下是 inert），關掉面板再按
    await A.tab("對話");
    await A.page.screenshot({ path: `${E2E.OUT}/devices-A-new-device.png` });
    await banner.getByRole("button", { name: "是我的" }).click();
    check.bannerGoneAfterMine = await banner.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
    // B 看不到「新裝置」的提醒（它加入時 A 已經在了）
    check.bNoBanner = (await B.page.locator(".new-device-banner").count()) === 0;

    // --- C：用復原碼還原（Windows · Edge） ---
    step = "C 用復原碼還原";
    const C = await device("C", { ua: UA.edge });
    await setup(C);
    await C.card.getByRole("button", { name: "用復原碼還原" }).click();
    await C.card.getByLabel("復原碼").fill(recovery);
    await C.card.getByRole("button", { name: "還原" }).click();
    await C.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    check.cListsThree = await waitNames(C, ["Mac · Edge", "iPhone · Safari", "Windows · Edge"]);
    // 冷卻期：C 剛加入，不能移除別台、不能換金鑰
    check.cRemoveDisabled = await rows(C).filter({ hasText: "Mac · Edge" }).getByRole("button", { name: "移除" }).isDisabled();
    check.cRekeyDisabled = await C.card.getByRole("button", { name: /只換金鑰/ }).isDisabled();
    check.cCooldownExplained = /還不到 24 小時/.test(await C.card.locator(".cooldown-note").innerText());

    step = "A 看到 C 加入、查看與移除";
    await A.tab("對話");
    await A.page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const banner2 = A.page.locator(".new-device-banner");
    check.aSeesSecondBanner = await banner2.waitFor({ timeout: 10000 }).then(async () => /Windows · Edge/.test(await banner2.innerText()), () => false);
    await banner2.getByRole("button", { name: "查看與移除" }).click();
    await A.page.locator("#side-panel").waitFor();
    check.viewOpensSettingsWithList = await A.card.locator(".device-list").isVisible();

    // --- 改名 ---
    step = "改名";
    await rows(A).filter({ hasText: "iPhone · Safari" }).getByRole("button", { name: "改名" }).click();
    await A.card.getByLabel("裝置名稱").fill("我的 iPhone");
    await A.card.getByRole("button", { name: "儲存" }).click();
    check.renamedOnA = await waitNames(A, ["Mac · Edge", "我的 iPhone", "Windows · Edge"]);
    await syncNow(B);
    check.renamedOnB = await waitNames(B, ["Mac · Edge", "我的 iPhone", "Windows · Edge"]);

    // --- A 移除 C ---
    step = "A 移除 C";
    const waitLeft = COOLDOWN_MS - (Date.now() - startedAt) + 1500;
    if (waitLeft > 0) await A.page.waitForTimeout(waitLeft);
    await syncNow(A);
    const removeC = rows(A).filter({ hasText: "Windows · Edge" }).getByRole("button", { name: "移除" });
    check.aRemoveEnabledAfterCooldown = await removeC.isEnabled();
    await removeC.click();
    check.removeExplains = /移除「Windows · Edge」.*舊的復原碼失效.*收不回來/.test(await A.card.locator(".confirm-identity").innerText());
    await A.card.screenshot({ path: `${E2E.OUT}/devices-A-remove-confirm.png` });
    await A.card.getByRole("button", { name: "移除並換金鑰" }).click();
    await A.card.locator(".new-code .recovery-code").waitFor({ timeout: 20000 });
    const newRecovery = (await A.card.locator(".new-code .recovery-code").innerText()).trim();
    check.newRecoveryDiffers = newRecovery !== recovery && /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]$/.test(newRecovery);
    check.mustConfirmNewCodeSaved = await A.card.getByRole("button", { name: "完成" }).isDisabled();
    await A.page.screenshot({ path: `${E2E.OUT}/devices-A-new-code.png` });
    await A.card.getByLabel("我已經把新的復原碼存好了").check();
    await A.card.getByRole("button", { name: "完成" }).click();
    check.aListAfterRemove = await waitNames(A, ["Mac · Edge", "我的 iPhone"]);
    const removedAt = Date.now();

    step = "B 不用重新配對";
    await syncNow(B);
    check.bStillSyncing = !(await B.card.locator(".notice.error").count());
    check.bListAfterRemove = await waitNames(B, ["Mac · Edge", "我的 iPhone"]);
    await B.tab("選手資料");
    await B.page.locator("section.training-values").waitFor({ timeout: 10000 });
    await B.page.waitForTimeout(300);
    await profileIntensity(B).selectOption("easy");
    await B.page.getByRole("button", { name: "儲存選手資料" }).click();
    await B.page.locator(".notice.ok", { hasText: "已儲存" }).waitFor();
    await syncNow(B);
    await syncNow(A);
    await A.tab("選手資料");
    await A.page.locator("section.training-values").waitFor({ timeout: 10000 });
    check.bChangeReachesA = await profileIntensity(A).evaluate((el) => new Promise((resolve) => {
      const start = Date.now();
      const tick = () => (el.value === "easy" ? resolve(true) : Date.now() - start > 8000 ? resolve(false) : setTimeout(tick, 200));
      tick();
    }));

    step = "C 被移除";
    await C.page.reload();
    await C.page.locator(".removed-banner").waitFor({ timeout: 20000 });
    check.cShowsRemoved = /這台已從多裝置同步移除/.test(await C.page.locator(".removed-banner").innerText());
    await C.page.screenshot({ path: `${E2E.OUT}/devices-C-removed.png` });
    await C.tab("設定");
    check.cSyncKeyCleared = await C.card.getByRole("button", { name: "這是第一台：開始同步" }).isVisible();
    check.cSettingsCleared = (await C.page.getByLabel("API key", { exact: true }).last().inputValue()) === "";
    check.cIdentityDeleted = await C.page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open("zone2mate-device", 1);
          r.onsuccess = () => {
            const tx = r.result.transaction("identity", "readonly");
            const g = tx.objectStore("identity").get("self");
            g.onsuccess = () => resolve(g.result === undefined);
          };
          r.onerror = () => resolve(true);
        }),
    );

    step = "C 用舊的復原碼";
    await setup(C);
    await C.card.getByRole("button", { name: "用復原碼還原" }).click();
    await C.card.getByLabel("復原碼").fill(recovery);
    await C.card.getByRole("button", { name: "還原" }).click();
    check.oldRecoveryRejected = await C.card.getByText(/這組復原碼已經換掉了/).waitFor({ timeout: 10000 }).then(() => true, () => false);

    step = "D 用新的復原碼";
    const D = await device("D", { mobile: true, ua: UA.iphone, scheme: "dark" });
    await setup(D);
    await D.card.getByRole("button", { name: "用復原碼還原" }).click();
    await D.card.getByLabel("復原碼").fill(newRecovery);
    await D.card.getByRole("button", { name: "還原" }).click();
    await D.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    check.dRestoredWithNewCode = await waitNames(D, ["Mac · Edge", "我的 iPhone", "iPhone · Safari"]);
    check.dInCooldown = await D.card.locator(".cooldown-note").isVisible();
    await D.card.locator(".device-list").scrollIntoViewIfNeeded();
    await D.page.screenshot({ path: `${E2E.OUT}/devices-D-mobile-dark.png` });

    step = "只換金鑰";
    // A 畫面上的清單還沒有 D：換金鑰時發現清單變了就停止，清單更新後再試
    await A.tab("設定");
    await A.card.getByRole("button", { name: /只換金鑰/ }).click();
    await A.card.getByRole("button", { name: "換金鑰", exact: true }).click();
    check.staleListStops = await A.card.getByText(/裝置清單剛剛變了/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    check.listRefreshedAfterStop = await waitNames(A, ["Mac · Edge", "我的 iPhone", "iPhone · Safari"]);
    // 剛換過金鑰的空間一分鐘內不能再換
    const sinceRemove = Date.now() - removedAt;
    if (sinceRemove < 62_000) await A.page.waitForTimeout(62_000 - sinceRemove);
    await A.card.getByRole("button", { name: /只換金鑰/ }).click();
    check.rekeyExplains = /舊的復原碼失效.*不用重新配對/.test(await A.card.locator(".confirm-identity").innerText());
    await A.card.getByRole("button", { name: "換金鑰", exact: true }).click();
    await A.card.locator(".new-code .recovery-code").waitFor({ timeout: 20000 });
    const third = (await A.card.locator(".new-code .recovery-code").innerText()).trim();
    check.rekeyOnlyNewCode = third !== newRecovery && third !== recovery;
    await A.card.getByLabel("我已經把新的復原碼存好了").check();
    await A.card.getByRole("button", { name: "完成" }).click();
    await syncNow(B);
    await syncNow(D);
    check.allStayAfterRekeyOnly = (await waitNames(B, ["Mac · Edge", "我的 iPhone", "iPhone · Safari"])) && !(await B.card.locator(".notice.error").count());

    // 截圖：電腦（淺色、深色）、手機（淺色）
    step = "截圖";
    await A.card.locator(".device-list").scrollIntoViewIfNeeded();
    await A.page.screenshot({ path: `${E2E.OUT}/devices-A-desktop-light.png` });
    await A.page.emulateMedia({ colorScheme: "dark" });
    await A.page.screenshot({ path: `${E2E.OUT}/devices-A-desktop-dark.png` });
    await B.tab("設定");
    await B.card.locator(".device-list").scrollIntoViewIfNeeded();
    await B.page.screenshot({ path: `${E2E.OUT}/devices-B-mobile-light.png` });
    check.noHorizontalScroll = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    // --- 開關關著的一般建置：沒有裝置清單 ---
    step = "開關關著";
    const off = await device("off", { url: E2E.URL });
    await setup(off);
    await off.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    await off.card.getByLabel("我已經把復原碼存好了").check();
    await off.card.getByRole("button", { name: "開始同步" }).click();
    await off.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    check.offNoDeviceList = (await off.card.locator(".device-list").count()) === 0;
    check.offNoDevicesFeature = !(await off.page.getByText("裝置清單與移除").count());
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
