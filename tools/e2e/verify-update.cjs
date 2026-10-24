// 驗證有新版本的提示與資料保護（規格 12.18）：
// 版本相同不提示；伺服器的 version.json 換成別的 commit 後，回到前景時出現提示、不自動重新載入（打到一半的字還在）、
// 關掉後同一個版本不再出現（重新整理後也是）、更新的版本又出現、點了才重新載入；讀不到（離線、404、回傳網頁）時不提示也不報錯；
// 設定頁「資料」顯示資料保護的三種狀態；標題列只顯示 Beta、設定頁最下面是完整的版號（規格 12.19）；
// 手機與電腦、淺色與深色的截圖
const path = require("path");

const { version } = require("../../package.json");

const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";

/** 讓頁面以為剛回到前景（App 監聽 visibilitychange） */
const foreground = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
const banner = (page) => page.locator(".update-banner");
/** 等一下再看有沒有提示：檢查是非同步的 */
const bannerShown = async (page, expected) => {
  try {
    await banner(page).waitFor({ state: expected ? "visible" : "detached", timeout: expected ? 5000 : 1500 });
  } catch {
    // 時間到還是原本的狀態
  }
  return (await banner(page).count()) > 0;
};

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};

  // 伺服器上真正的 version.json（這次建置的 commit）
  let actual;
  {
    const context = await browser.newContext();
    const page = await context.newPage();
    const res = await page.request.get(new URL("version.json", E2E.URL).href);
    actual = await res.json();
    check.versionFileServed = res.ok() && typeof actual.commit === "string" && actual.commit.length > 0;
    await page.goto(E2E.URL);
    await page.locator("nav.tabbar button").first().waitFor();
    await E2E.go(page, "設定");
    // 網頁本身的版本（設定的最下面）和 version.json 是同一次建置
    const settingsText = await page.locator("#side-panel").innerText();
    check.versionMatchesBuild = settingsText.includes(`（${actual.commit}，`);
    // 版號只有一個來源：repo 根目錄的 package.json
    check.settingsShowsFullVersion = settingsText.includes(`v${version} Beta（${actual.commit}，`);
    check.topbarShowsOnlyBeta = (await page.locator(".topbar .version").innerText()).trim() === "Beta";
    check.topbarTitleHasFullVersion = ((await page.locator(".topbar .version").getAttribute("title")) ?? "").startsWith(`v${version} Beta（`);
    await context.close();
  }

  for (const mobile of [true, false]) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${mobile ? "390" : "1280"}-${scheme}`;
      const context = await browser.newContext({
        ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
        colorScheme: scheme,
        timezoneId: "Asia/Taipei",
      });
      const page = await context.newPage();
      // 讀不到 version.json 時瀏覽器自己會印「Failed to load resource」，那不是 App 的錯誤
      page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(`[${tag} ${step}] ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
      // 伺服器上的版本：null 是照原本的檔案；字串是換成那個 commit；其餘是讀不到的各種情況
      let served = null;
      let fetches = 0;
      await page.route("**/version.json", (route) => {
        fetches++;
        if (served === null) return route.continue();
        if (served === "offline") return route.abort("internetdisconnected");
        if (served === "404") return route.fulfill({ status: 404, body: "not found" });
        if (served === "html") return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><html></html>" });
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ commit: served, date: "2026-10-25" }) });
      });
      const shot = (name) => page.screenshot({ path: path.join(E2E.OUT, `update-${name}-${tag}.png`) });
      try {
        step = "版本相同";
        await page.goto(E2E.URL);
        await page.locator("nav.tabbar button").first().waitFor();
        check[`${tag}.sameNoBanner`] = !(await bannerShown(page, false));
        check[`${tag}.checkedOnOpen`] = fetches >= 1;

        step = "設定";
        // 對話的輸入框要設定好 AI 才出現
        await E2E.go(page, "設定");
        await page.getByLabel("時區").fill("Asia/Taipei");
        await page.getByLabel("供應商").selectOption("openai-compatible");
        await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
        await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
        await page.getByLabel("主對話模型").fill("mock-model");
        await page.getByLabel("我了解並同意以上的資料流向").check();
        await page.getByRole("button", { name: "儲存設定" }).click();
        await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
        await page.locator("#side-panel").getByRole("button", { name: "關閉設定" }).click();
        await page.locator(".getting-started").getByRole("button", { name: "先略過" }).click().catch(() => undefined);

        step = "有新版本";
        served = "newer01";
        const before = fetches;
        await foreground(page);
        check[`${tag}.checkedOnForeground`] = (await bannerShown(page, true)) && fetches > before;
        check[`${tag}.bannerText`] = (await banner(page).innerText()).includes("有新版本，點這裡更新");
        await shot("banner");

        step = "不自動重新載入";
        await page.evaluate(() => (window.__notReloaded = true));
        const draft = "打到一半的字，還沒送出";
        await page.getByLabel("訊息").fill(draft);
        await foreground(page);
        await page.waitForTimeout(1500);
        check[`${tag}.noAutoReload`] =
          (await page.evaluate(() => window.__notReloaded === true)) && (await page.getByLabel("訊息").inputValue()) === draft && (await banner(page).count()) === 1;

        step = "關掉";
        await banner(page).getByRole("button", { name: "先不要更新" }).click();
        check[`${tag}.dismissHides`] = !(await bannerShown(page, false));
        await foreground(page);
        check[`${tag}.dismissedStaysHidden`] = !(await bannerShown(page, false));
        await page.reload();
        await page.locator("nav.tabbar button").first().waitFor();
        check[`${tag}.dismissedAfterReload`] = !(await bannerShown(page, false));

        step = "更新的版本";
        served = "newer02";
        await foreground(page);
        check[`${tag}.newerShowsAgain`] = await bannerShown(page, true);

        step = "點了才重新載入";
        await page.evaluate(() => (window.__notReloaded = true));
        served = null;
        await Promise.all([page.waitForEvent("load"), banner(page).getByRole("button", { name: "有新版本，點這裡更新" }).click()]);
        await page.locator("nav.tabbar button").first().waitFor();
        check[`${tag}.clickReloads`] = (await page.evaluate(() => window.__notReloaded)) === undefined;
        // 重新載入後就是伺服器上的版本，不再提示
        check[`${tag}.noBannerAfterUpdate`] = !(await bannerShown(page, false));

        step = "讀不到";
        for (const failure of ["offline", "404", "html"]) {
          served = failure;
          await page.reload();
          await page.locator("nav.tabbar button").first().waitFor();
          await foreground(page);
          check[`${tag}.quietWhen-${failure}`] = !(await bannerShown(page, false)) && (await page.locator(".notice.error").count()) === 0;
        }

        step = "讀不到時保留已經出現的提示";
        served = "newer03";
        await foreground(page);
        await bannerShown(page, true);
        served = "offline";
        await foreground(page);
        check[`${tag}.offlineKeepsBanner`] = await bannerShown(page, true);
        check[`${tag}.noOverflow`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.completed`] = false;
      }
      await context.close();
    }
  }

  // 資料保護的三種狀態：改寫 navigator.storage 的 persisted／persist
  const states = {
    persisted: "Object.defineProperty(navigator.storage, 'persisted', { value: async () => true }); Object.defineProperty(navigator.storage, 'persist', { value: async () => true });",
    "not-persisted":
      "Object.defineProperty(navigator.storage, 'persisted', { value: async () => false }); Object.defineProperty(navigator.storage, 'persist', { value: async () => { window.__persistAsked = true; return false; } });",
    unsupported: "Object.defineProperty(navigator.storage, 'persisted', { value: undefined }); Object.defineProperty(navigator.storage, 'persist', { value: undefined });",
  };
  const expectedText = { persisted: "已受保護", "not-persisted": "瀏覽器沒有答應", unsupported: "這個瀏覽器不支援" };
  for (const mobile of [true, false]) {
    const tag = mobile ? "390" : "1280";
    for (const [state, script] of Object.entries(states)) {
      step = `資料保護 ${state}`;
      const context = await browser.newContext(
        mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } },
      );
      await context.addInitScript(script);
      const page = await context.newPage();
      page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
      try {
        await page.goto(E2E.URL);
        await page.locator("nav.tabbar button").first().waitFor();
        await E2E.go(page, "設定");
        const note = page.locator(".storage-protection");
        await note.waitFor({ timeout: 5000 });
        check[`${tag}.protection-${state}`] = (await note.getAttribute("data-state")) === state && (await note.innerText()).includes(expectedText[state]);
        // App 打開時已經要求過（瀏覽器沒有答應的情況）
        if (state === "not-persisted") check[`${tag}.persistRequested`] = await page.evaluate(() => window.__persistAsked === true);
        await note.scrollIntoViewIfNeeded();
        await page.locator("#side-panel").screenshot({ path: path.join(E2E.OUT, `update-protection-${state}-${tag}.png`) });
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.protection-${state}`] = false;
      }
      await context.close();
    }
  }

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
