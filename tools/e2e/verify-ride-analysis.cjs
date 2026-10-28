// 驗證騎車的分析（規格 12.31，功能開關 multisport）：
// - 「回報」存了騎車的體感就產生騎後分析，結果裡看得到
// - 紀錄頁：騎車的每週（依強度疊的時間）與跑步＋騎車（兩種中性色＋圖示，時間／負荷）、點長條看那週、每週的數字
// - 騎車卡：分析（結論＋看完整分析）；有踏頻與功率的那趟才有平均踏頻、標準化功率；還沒分析的按「請教練分析」
// - 開關關著的一般建置（E2E_URL，4173）沒有騎車的每週
// 這個腳本自己建置一份開著 multisport 的（放在 $E2E_OUT 底下），用 4179 埠開 vite preview；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const WEB = path.join(__dirname, "../../apps/web");
const PORT = 4179;
const URL = `http://localhost:${PORT}/`;
let step = "start";

function build() {
  const outDir = path.join(E2E.OUT, "dist-ride-analysis");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_FEATURES: "multisport",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(URL)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${PORT} 開起來`);
}

const VIEWS = [
  { width: 390, height: 844, scheme: "light" },
  { width: 1280, height: 860, scheme: "dark" },
];

async function newPage(browser, { width, height, scheme }, problems, tag) {
  const mobile = width < 600;
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }),
    colorScheme: scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
  return page;
}

async function syncAll(page) {
  await E2E.setupMock(page, { mock: E2E.MOCK });
  await E2E.go(page, "回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });
}

async function flow(browser, view, check, problems) {
  const tag = `${view.width}-${view.scheme}`;
  const page = await newPage(browser, view, problems, tag);
  const until = async (fn, tries = 50) => {
    for (let i = 0; i < tries; i++) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const c = (k, v) => (check[`${tag}.${k}`] = v);

  step = "設定與同步";
  await page.goto(URL);
  await syncAll(page);

  step = "運動回報：騎後分析";
  const option = page.locator("label.choice", { hasText: "騎車" }).first();
  await option.waitFor({ timeout: 10000 });
  await option.click();
  await page.getByRole("button", { name: "體感 4", exact: true }).click();
  await page.getByLabel("一句話的感受").fill("輕鬆，腿還好");
  await page.getByRole("button", { name: "存起來" }).click();
  const result = page.locator(".report-result", { hasText: "已存到這趟騎車" });
  await result.waitFor({ timeout: 30000 });
  c("reportSummary", await until(async () => (await result.innerText()).includes("（模擬騎後分析）穩定的耐力騎")));
  c("reportDetailsCollapsed", (await result.getByText("看完整分析").count()) === 1 && !(await result.innerText()).includes("明天可以安排輕鬆跑"));
  await result.screenshot({ path: `${E2E.OUT}/ride-analysis-${tag}-report.png` });

  step = "紀錄頁：騎車的每週";
  await E2E.go(page, "紀錄");
  const card = page.locator("section.weekly-volume");
  await card.waitFor({ timeout: 10000 });
  const charts = card.locator(".week-bars");
  c("twoCharts", (await charts.count()) === 2 && (await charts.nth(0).locator(".week-bar").count()) === 10 && (await charts.nth(1).locator(".week-bar").count()) === 10);
  // 第一張：強度的顏色；第二張：兩種中性色，不和強度的顏色相同
  const colors = async (chart, cls) => chart.locator(`.week-bar-stack .${cls}`).evaluateAll((els) => [...new Set(els.map((e) => getComputedStyle(e).backgroundColor))]);
  const intensity = [...(await colors(charts.nth(0), "low")), ...(await colors(charts.nth(0), "moderate")), ...(await colors(charts.nth(0), "high"))];
  const runColor = await colors(charts.nth(1), "vol-run");
  const rideColor = await colors(charts.nth(1), "vol-ride");
  c("intensityColors", intensity.length >= 2);
  c("neutralSportColors", runColor.length === 1 && rideColor.length === 1 && runColor[0] !== rideColor[0] && !intensity.includes(runColor[0]) && !intensity.includes(rideColor[0]));
  const text = await card.innerText();
  c("legends", /低[\s\S]*中[\s\S]*高/.test(text) && text.includes("跑步") && (await card.locator(".legend .icon").count()) >= 2);
  const details = card.locator(".week-detail");
  c("thisWeekDetail", /^這週：騎 \d+ 次/.test((await details.nth(0).innerText()).trim()));
  // 點上週的長條：兩張圖一起選那週
  await charts.nth(0).locator(".week-bar").nth(8).click();
  c("selectWeek", /^\d+\/\d+ 那週：/.test((await details.nth(0).innerText()).trim()) && /^\d+\/\d+ 那週：跑步 /.test((await details.nth(1).innerText()).trim()));
  c("selectedBoth", (await card.locator(".week-bar.selected").count()) === 2);
  await card.getByRole("button", { name: "負荷", exact: true }).click();
  c("loadMetric", (await details.nth(1).innerText()).includes("跑步負荷"));
  await card.getByRole("button", { name: "時間", exact: true }).click();
  await card.locator("summary", { hasText: "每週的數字" }).click();
  c("table", (await card.locator(".week-table tbody tr").count()) === 10);
  await card.locator("summary", { hasText: "每週的數字" }).click();
  await card.screenshot({ path: `${E2E.OUT}/ride-analysis-${tag}-weekly.png` });

  step = "騎車卡";
  const rides = page.locator("ul.runs li.ride");
  await rides.first().waitFor({ timeout: 10000 });
  // 今天的（剛回報的）：有分析、沒有踏頻
  // 點開後列上的「N 分鐘」換成課名：先記下是第幾列
  const indexOf = async (text) => (await rides.evaluateAll((els, t) => els.map((e) => e.innerText.includes(t)), text)).indexOf(true);
  const todayRide = rides.nth(await indexOf("60 分鐘"));
  await todayRide.locator(".run-row").click();
  const todayCard = todayRide.locator(".ride-card");
  await todayCard.waitFor({ timeout: 5000 });
  const todayText = await todayCard.innerText();
  c("cardSummary", todayText.includes("（模擬騎後分析）穩定的耐力騎") && (await todayCard.getByText("看完整分析").count()) === 1);
  c("noPowerNoCells", !todayText.includes("踏頻") && !todayText.includes("標準化功率") && !todayText.includes("功率"));
  // 8 天前的訓練台：有踏頻與功率
  const trainer = rides.nth(await indexOf("85 分鐘"));
  await trainer.locator(".run-row").click();
  const trainerCard = trainer.locator(".ride-card");
  await trainerCard.waitFor({ timeout: 5000 });
  const trainerText = await trainerCard.innerText();
  c("powerCells", trainerText.includes("172") && trainerText.includes("標準化功率 181 W") && trainerText.includes("平均踏頻 88 rpm"));
  // 還沒分析的：請教練分析
  const analyze = trainerCard.getByRole("button", { name: "請教練分析" });
  c("analyzeButton", (await analyze.count()) === 1);
  await analyze.click();
  c("analyzed", await until(async () => (await trainerCard.innerText()).includes("（模擬騎後分析）穩定的耐力騎")));
  c("analysisMentionsPower", await until(async () => {
    await trainerCard.getByText("看完整分析").click();
    return (await trainerCard.innerText()).includes("平均功率 172 W");
  }, 5));
  c("analyzeButtonGone", (await trainerCard.getByRole("button", { name: "請教練分析" }).count()) === 0);
  await trainer.screenshot({ path: `${E2E.OUT}/ride-analysis-${tag}-ride-card.png` });
  c("noOverflow", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.context().close();
}

(async () => {
  const check = {};
  const problems = [];
  const outDir = build();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  try {
    for (const view of VIEWS) {
      try {
        await flow(browser, view, check, problems);
      } catch (e) {
        problems.push(`FAILED [${view.width}-${view.scheme}] at [${step}]: ${e.message.split("\n").slice(0, 3).join(" | ")}`);
        check[`${view.width}-${view.scheme}.completed`] = false;
      }
    }
    // 開關關著（一般的建置）：沒有騎車的每週
    step = "開關關著";
    const page = await newPage(browser, VIEWS[0], problems, "off");
    await page.goto(E2E.URL);
    await syncAll(page);
    await E2E.go(page, "紀錄");
    await page.locator("ul.runs li").first().waitFor({ timeout: 10000 });
    check["off.noWeekly"] = (await page.locator("section.weekly-volume").count()) === 0 && (await page.locator("ul.runs li.ride").count()) === 0;
    await page.context().close();
  } finally {
    await browser.close();
    server.kill();
  }
  check.noConsoleErrors = problems.length === 0;
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(Object.values(check).every(Boolean) && !problems.length ? 0 : 1);
})();
