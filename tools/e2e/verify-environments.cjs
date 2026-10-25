// 驗證 staging 與正式環境的標示、舊網址的搬家提示（規格 12.19）：
// - 一般的建置（E2E_URL，沒有正式網址）：沒有搬家提示、沒有 Staging 標示，標題列是 Beta
// - 正式版的建置（VITE_WEB_URL=https://app.zone2mate.com）：從其他網址打開時每一頁上方有搬家提示，
//   設定的最上面是搬家的步驟，「清除這個網址的資料」後重新載入顯示已清除；在正式網址打開時沒有提示
// - staging 的建置（VITE_STAGING=1）：標題列與設定頁最下面是 Staging、每一頁上方有 Staging 的提醒、沒有搬家提示、
//   _headers 有 noindex
// - 隱私說明頁（/privacy）：staging 的版本上方有 Staging 標示，正式版沒有
// 這個腳本自己建置正式版與 staging 兩份（放在 $E2E_OUT 底下），用 4174、4175 埠開 vite preview；
// 只需要 npm run dev:mock（同步服務等指向模擬上游），一般的 preview（4173）用來檢查第 1 項。
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const { version } = require("../../package.json");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const CANONICAL = "https://app.zone2mate.com";
const BUILDS = {
  production: { port: 4174, env: { VITE_WEB_URL: CANONICAL } },
  // 也給正式網址：staging 不管有沒有都不顯示搬家提示
  staging: { port: 4175, env: { VITE_STAGING: "1", VITE_WEB_URL: "https://staging.zone2mate.com" } },
};

let step = "start";

function build(name) {
  const outDir = path.join(E2E.OUT, `dist-${name}`);
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      ...BUILDS[name].env,
    },
  });
  return outDir;
}

async function serve(outDir, port) {
  const child = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${port} 開起來`);
}

const viewports = {
  390: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  1280: { viewport: { width: 1280, height: 860 } },
};

(async () => {
  const problems = [];
  const check = {};
  const servers = [];
  const dirs = {};
  try {
    step = "build";
    for (const name of Object.keys(BUILDS)) {
      dirs[name] = build(name);
      servers.push(await serve(dirs[name], BUILDS[name].port));
    }
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message);
    for (const s of servers) s.kill();
    process.exit(1);
  }
  const headersOf = (name) => fs.readFileSync(path.join(dirs[name], "_headers"), "utf8");
  check.stagingNoindex = headersOf("staging").includes("X-Robots-Tag: noindex");
  check.productionIndexable = !headersOf("production").includes("X-Robots-Tag");

  const browser = await chromium.launch();

  // 隱私說明頁（規格 12.20）：staging 的版本有標示，正式版沒有；不用 JavaScript
  step = "privacy";
  for (const name of Object.keys(BUILDS)) {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(`http://localhost:${BUILDS[name].port}/privacy`);
    const banner = page.locator(".staging-banner");
    const heading = await page.getByRole("heading", { name: "隱私說明", level: 1 }).isVisible();
    check[`privacy.${name}`] =
      heading && (name === "staging" ? (await banner.isVisible()) && (await banner.innerText()).includes("Staging") : (await banner.count()) === 0);
    if (name === "staging") await page.screenshot({ path: `${E2E.OUT}/privacy-staging.png` });
    await context.close();
  }
  const open = async (tag, options = {}) => {
    const context = await browser.newContext({ ...viewports[tag.split("-")[0]], timezoneId: "Asia/Taipei", ...options });
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && !m.text().startsWith("Failed to load resource") && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] ${e.message}`));
    return { context, page };
  };
  const ready = (page) => page.locator("nav.tabbar button").first().waitFor();

  // 1. 一般的建置：沒有正式網址
  try {
    step = "default";
    const { context, page } = await open("1280-default");
    await page.goto(E2E.URL);
    await ready(page);
    check.defaultNoMovedBanner = (await page.locator(".notice.moved").count()) === 0;
    check.defaultNoStagingBanner = (await page.locator(".staging-banner").count()) === 0;
    check.defaultTopbarBeta = (await page.locator(".topbar .version").innerText()).trim() === "Beta";
    await context.close();
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message.split("\n")[0]);
    check.default = false;
  }

  // 2. 正式版的建置：舊網址（這裡是 localhost）有搬家提示
  for (const size of ["390", "1280"]) {
    const tag = `${size}-production`;
    const local = `http://localhost:${BUILDS.production.port}/`;
    try {
      step = "moved banner";
      const { context, page } = await open(tag);
      page.on("dialog", (d) => void d.accept());
      await page.goto(local);
      await ready(page);
      const bannerEl = page.locator(".notice.moved");
      await bannerEl.waitFor();
      const bannerText = await bannerEl.innerText();
      check[`${tag}.bannerLinksToNewAddress`] = (await bannerEl.locator("a").first().getAttribute("href")) === CANONICAL;
      check[`${tag}.bannerExplains`] = ["不會自動搬過去", "復原碼", "API key", "重新加入主畫面"].every((t) => bannerText.includes(t));
      check[`${tag}.topbarBeta`] = (await page.locator(".topbar .version").innerText()).trim() === "Beta";
      await page.screenshot({ path: path.join(E2E.OUT, `environments-moved-${size}.png`) });
      // 每一頁都有
      await E2E.go(page, "紀錄");
      check[`${tag}.bannerOnOtherTabs`] = await bannerEl.isVisible();

      step = "moved card";
      await bannerEl.getByRole("button", { name: "搬好了，清除這裡的資料" }).click();
      const panel = page.locator("#side-panel");
      await panel.waitFor();
      const card = panel.locator(".card.moved");
      check[`${tag}.cardFirstInSettings`] = (await panel.locator(".card").first().getAttribute("class")).includes("moved");
      const cardText = await card.innerText();
      check[`${tag}.cardSteps`] = ["用復原碼還原", "匯出資料庫", "重新填 API key", "重新加入主畫面"].every((t) => cardText.includes(t));
      await card.screenshot({ path: path.join(E2E.OUT, `environments-moved-card-${size}.png`) });

      step = "clear";
      await page.evaluate(() => localStorage.setItem("running-coach.feed.v1", JSON.stringify({ dismissed: ["x"] })));
      await card.getByRole("button", { name: "清除這個網址的資料" }).click();
      await page.waitForEvent("load");
      await ready(page);
      await page.locator(".notice.moved").waitFor();
      check[`${tag}.clearedBanner`] = (await page.locator(".notice.moved").innerText()).includes("這個網址的資料已經清除");
      check[`${tag}.clearedStorage`] = await page.evaluate(() => localStorage.getItem("running-coach.feed.v1") === null);
      await context.close();
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      check[`${tag}.moved`] = false;
    }
  }

  // 2b. 同一份正式版的建置在正式網址打開時（用路由把 app.zone2mate.com 接到本機的 preview）：沒有提示
  try {
    step = "canonical";
    const tag = "1280-canonical";
    const { context, page } = await open(tag);
    await context.route(`${CANONICAL}/**`, async (route) => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: `http://localhost:${BUILDS.production.port}${url.pathname}${url.search}` });
      await route.fulfill({ response });
    });
    await page.goto(`${CANONICAL}/`);
    await ready(page);
    await page.waitForTimeout(500);
    check.canonicalNoMovedBanner = (await page.locator(".notice.moved").count()) === 0;
    await E2E.go(page, "設定");
    check.canonicalNoMovedCard = (await page.locator("#side-panel .card.moved").count()) === 0;
    await context.close();
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message.split("\n")[0]);
    check.canonical = false;
  }

  // 3. staging
  for (const size of ["390", "1280"]) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${size}-staging-${scheme}`;
      try {
        step = "staging";
        const { context, page } = await open(tag, { colorScheme: scheme });
        await page.goto(`http://localhost:${BUILDS.staging.port}/`);
        await ready(page);
        const badge = page.locator(".topbar .version");
        check[`${tag}.topbarStaging`] = (await badge.innerText()).trim() === "Staging" && (await badge.getAttribute("class")).includes("staging");
        const stagingBanner = page.locator(".staging-banner");
        check[`${tag}.banner`] = (await stagingBanner.isVisible()) && (await stagingBanner.innerText()).includes("和正式版分開");
        check[`${tag}.noMovedBanner`] = (await page.locator(".notice.moved").count()) === 0;
        await page.screenshot({ path: path.join(E2E.OUT, `environments-staging-${size}-${scheme}.png`) });
        await E2E.go(page, "設定");
        const settingsText = await page.locator("#side-panel").innerText();
        check[`${tag}.settingsVersion`] = settingsText.includes(`v${version} Staging（`);
        check[`${tag}.noMovedCard`] = (await page.locator("#side-panel .card.moved").count()) === 0;
        check[`${tag}.noHorizontalScroll`] = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
        await context.close();
      } catch (e) {
        console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
        check[`${tag}.staging`] = false;
      }
    }
  }

  await browser.close();
  for (const s of servers) s.kill();
  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
