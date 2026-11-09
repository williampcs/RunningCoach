// 驗證 Garmin 的資料來源標示（KI-048、規格 12.40、設計準則「資料來源的標示」）：
// 模擬上游的活動有三種來源：Garmin（今天的跑步 Forerunner 265、今天的騎車 Edge 540、舊的紀錄 Forerunner 255）、
// 其他品牌（3 天前的跑步 COROS、4 天前的騎車 Wahoo、8 天前的 Zwift），另外在紀錄頁手動記一筆。
// - 回報：Garmin 的那一趟列上有「Garmin Forerunner 265」，其他品牌的沒有；存了之後的結果卡片在標題下方有標示
// - 紀錄頁：列上與點開的卡片（跑步、騎車）有標示，COROS、Wahoo、手動記的沒有；累積、騎車的累積、騎車的每週
//   在標題下方有「資料來源：Garmin、…」
// - 選手頁：我的數字與訓練數值的「資料來源：Garmin…」
// - 看板：還沒回報的今天那一趟、手錶的恢復資料有標示
// - 教練的回覆：「參考了：…（含 Garmin 的資料）」
// - 標示是看得到的一行字，不在 ⓘ、title 或「細節」裡；手機淺色與電腦深色的截圖（garmin-*）
// 這個腳本自己建置一份開著 multisport 的（放在 $E2E_OUT 底下），用 4184 埠開 vite preview；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const WEB = path.join(__dirname, "../../apps/web");
const PORT = 4184;
const URL = `http://localhost:${PORT}/`;
let step = "start";

const localDate = (offsetDays = 0) => new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function build() {
  const outDir = path.join(E2E.OUT, "dist-garmin");
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

const GARMIN_RUN = "Garmin Forerunner 265";
const GARMIN_RIDE = "Garmin Edge 540";

/** 標示要看得到：有大小、不是收起的「細節」裡、不在 ⓘ 的說明裡 */
async function visibleLine(locator) {
  if (!(await locator.count())) return false;
  return locator.first().evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hidden = el.closest("details:not([open]), .info-tip-body, [role=tooltip], [hidden]");
    return r.width > 0 && r.height > 0 && !hidden && getComputedStyle(el).visibility !== "hidden";
  });
}

async function flow(browser, view, check, problems) {
  const tag = `${view.width}-${view.scheme}`;
  const mobile = view.width < 600;
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width: view.width, height: view.height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: view.width, height: view.height } }),
    colorScheme: view.scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  const c = (k, v) => (check[`${tag}.${k}`] = v);
  const shot = (name, target = page) => target.screenshot({ path: `${E2E.OUT}/garmin-${tag}-${name}.png` });

  step = "設定與同步";
  await page.goto(URL);
  await E2E.setupMock(page, { mock: E2E.MOCK });
  await E2E.go(page, "回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

  step = "回報：哪一趟";
  const choices = page.locator("fieldset.choices label.choice");
  await choices.first().waitFor({ timeout: 10000 });
  const todayRun = choices.filter({ hasText: "10 km" }).first();
  c("reportChoiceGarmin", (await todayRun.locator(".list-row-sub").innerText()).includes(GARMIN_RUN));
  const rideChoice = choices.filter({ hasText: "騎車" }).first();
  c("reportChoiceRideGarmin", (await rideChoice.locator(".list-row-sub").innerText()).includes(GARMIN_RIDE));
  c("reportChoiceNotInTitle", !(await page.locator("fieldset.choices [title*='Garmin']").count()));
  await todayRun.click();
  await page.getByRole("button", { name: "體感 4", exact: true }).click();
  await page.getByRole("button", { name: "存起來" }).click();
  const result = page.locator(".report-result .run-card");
  await result.waitFor({ timeout: 30000 });
  const resultSource = result.locator(".data-source");
  c("reportResultGarmin", (await resultSource.count()) === 1 && (await resultSource.innerText()) === GARMIN_RUN && (await visibleLine(resultSource)));
  // 標題（日期那一行）的下方
  const headBox = await result.locator(".run-card-head").boundingBox();
  const sourceBox = await resultSource.boundingBox();
  c("reportResultBelowTitle", headBox && sourceBox && sourceBox.y >= headBox.y + headBox.height - 1);
  await shot("1-report", page.locator(".report-result"));

  step = "紀錄頁：手動記一筆";
  await E2E.go(page, "紀錄");
  await page.getByRole("button", { name: "新增一筆" }).click();
  const add = page.locator(".manual-add");
  await add.getByLabel("日期").fill(localDate(-1));
  await add.getByLabel("距離（km）").fill("5");
  await add.getByLabel("分鐘").fill("30");
  await add.getByRole("button", { name: "體感 3", exact: true }).click();
  await add.getByRole("button", { name: "存起來" }).click();
  await page.locator("ul.runs li .badge", { hasText: "手動" }).first().waitFor({ timeout: 20000 });

  step = "紀錄頁：每一列";
  const runRows = page.locator("ul.runs > li[data-workout]");
  const rowTexts = await runRows.evaluateAll((els) => els.map((e) => e.querySelector(".run-date")?.textContent ?? ""));
  // 點開後列上的字會變：先記下每一列的 data-workout，之後用它找
  const byId = async (loc) => page.locator(`ul.runs > li[data-workout="${await loc.getAttribute("data-workout")}"]`);
  const manualRow = await byId(runRows.filter({ has: page.locator(".badge", { hasText: "手動" }) }).first());
  const corosRow = await byId(runRows.filter({ hasText: "8 km" }).first());
  c("rowGarmin", rowTexts.some((t) => t.includes(GARMIN_RUN)));
  c("rowCorosNotGarmin", !(await corosRow.locator(".run-date").innerText()).includes("Garmin"));
  c("rowManualNotGarmin", !(await manualRow.locator(".run-date").innerText()).includes("Garmin"));
  const rideRows = page.locator("ul.runs > li.ride");
  const rideTexts = await rideRows.evaluateAll((els) => els.map((e) => e.querySelector(".run-date")?.textContent ?? ""));
  c("rideRowGarmin", rideTexts.filter((t) => t.includes(GARMIN_RIDE)).length === 1);
  c("rideRowOthersNot", rideTexts.filter((t) => t.includes("Garmin")).length === 1);

  step = "紀錄頁：點開的卡片";
  const garminRow = await byId(runRows.filter({ hasText: GARMIN_RUN }).first());
  await garminRow.locator(".run-row").click();
  const garminCard = garminRow.locator(".run-card");
  await garminCard.waitFor();
  const cardSource = garminCard.locator(".data-source");
  c("cardGarmin", (await cardSource.count()) === 1 && (await cardSource.innerText()) === GARMIN_RUN && (await visibleLine(cardSource)));
  // 卡片的第一行（數字在下面）
  const statsBox = await garminCard.locator("dl.stats").boundingBox();
  c("cardSourceAboveStats", statsBox && (await cardSource.boundingBox()).y < statsBox.y);
  await corosRow.locator(".run-row").click();
  await corosRow.locator(".run-card").waitFor();
  c("cardCorosNone", (await corosRow.locator(".data-source").count()) === 0);
  step = "紀錄頁：手動記的卡片";
  // 剛存的那一筆已經是打開的
  if ((await manualRow.locator(".run-row").getAttribute("aria-expanded")) !== "true") await manualRow.locator(".run-row").click();
  await manualRow.locator(".run-card").waitFor();
  c("cardManualNone", (await manualRow.locator(".data-source").count()) === 0);
  const rideById = async (loc) => page.locator(`ul.runs > li[data-ride="${await loc.getAttribute("data-ride")}"]`);
  step = "紀錄頁：騎車的卡片";
  const garminRide = await rideById(rideRows.filter({ hasText: GARMIN_RIDE }).first());
  await garminRide.locator(".run-row").click();
  await garminRide.locator(".ride-card").waitFor();
  c("rideCardGarmin", (await garminRide.locator(".ride-card .data-source").innerText()) === GARMIN_RIDE);
  step = "紀錄頁：其他品牌的騎車";
  const wahooRide = await rideById(rideRows.filter({ hasNotText: "Garmin" }).first());
  await wahooRide.locator(".run-row").click();
  await wahooRide.locator(".ride-card").waitFor();
  c("rideCardOthersNone", (await wahooRide.locator(".data-source").count()) === 0);
  await shot("2-history-run", garminRow);
  await shot("2-history-ride", garminRide);
  // 收起的列：選一列 Garmin 的騎車與其他的列一起看（點開的收起來）
  await garminRow.locator(".run-row").click();
  await garminRide.locator(".run-row").click();
  await corosRow.locator(".run-row").click();
  await shot("2-history-rows", page.locator("ul.runs"));

  step = "紀錄頁：由多趟算的";
  const totals = page.locator("section.totals");
  const totalsSource = totals.locator(".data-source");
  c("totalsSource", (await totalsSource.innerText()) === "資料來源：Garmin、其他裝置、手動記" && (await visibleLine(totalsSource)));
  c("rideTotalsSource", (await page.locator("section.ride-totals .data-source").innerText()) === "資料來源：Garmin、其他裝置");
  const weekly = page.locator("section.weekly-volume .data-source");
  c("weeklySource", (await weekly.innerText()) === "資料來源：Garmin、其他裝置、手動記");
  await shot("3-totals", totals);
  await shot("4-ride-totals", page.locator("section.ride-totals"));

  step = "選手頁";
  await E2E.go(page, "選手");
  const myNumbers = page.locator("section.my-numbers");
  await myNumbers.waitFor({ timeout: 10000 });
  const mySource = myNumbers.locator(".data-source");
  await mySource.waitFor({ timeout: 10000 });
  c("myNumbersSource", (await mySource.innerText()).startsWith("資料來源：Garmin") && (await visibleLine(mySource)));
  await shot("5-my-numbers", myNumbers);
  await myNumbers.locator(".my-numbers-head").click();
  const values = page.locator("section.training-values");
  await values.waitFor({ timeout: 10000 });
  const valuesSource = values.locator(".data-source");
  c("trainingValuesSource", (await valuesSource.innerText()).startsWith("資料來源：Garmin") && (await visibleLine(valuesSource)));
  const titleBox = await values.locator(".card-head").boundingBox();
  c("trainingValuesBelowTitle", (await valuesSource.boundingBox()).y >= titleBox.y + titleBox.height - 1);
  await shot("6-training-values", values);

  step = "看板";
  await E2E.go(page, "對話");
  await page.locator(".feed-summary, .feed-list").first().waitFor({ timeout: 10000 });
  if (await page.locator(".feed-summary").count()) await page.locator(".feed-summary").click();
  await page.locator(".feed-item").first().waitFor({ timeout: 10000 });
  // 跑步已經回報了；今天的騎車還沒回報（練騎車的人才有），手錶的恢復資料偏差的提醒
  const sources = await page.locator(".feed-item .feed-source").allInnerTexts();
  c("feedRecoverySource", sources.includes("資料來源：Garmin"));
  c("feedSourceVisible", await visibleLine(page.locator(".feed-item .feed-source")));
  await shot("7-feed", page.locator("section.feed").first());

  step = "教練的回覆";
  const input = page.getByPlaceholder(/問教練|輸入/).first();
  await input.fill("最近練得怎樣");
  await input.press("Enter");
  const sourcesLine = page.locator(".bubble .sources").last();
  await sourcesLine.waitFor({ timeout: 30000 });
  const line = await sourcesLine.innerText();
  c("chatSources", /^參考了：.+（含 Garmin 的資料）$/.test(line));
  await shot("8-chat", page.locator(".bubble").last());

  // 不左右捲動
  c("noHorizontalScroll", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await context.close();
}

(async () => {
  const outDir = build();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  try {
    for (const view of VIEWS) {
      try {
        await flow(browser, view, check, problems);
      } catch (e) {
        problems.push(`[${view.width}-${view.scheme} ${step}] ${e.message.split("\n")[0]}`);
        check[`${view.width}-${view.scheme}.finished`] = false;
      }
    }
  } finally {
    await browser.close();
    server.kill();
  }
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`problem: ${p}`);
  const ok = Object.values(check).every(Boolean) && Object.keys(check).length > 0 && problems.length === 0;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
