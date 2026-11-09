// 驗證「匯入檔案」（規格 12.40「讀 FIT 檔」）：
// - 檔案用 tools/e2e/make-activity-files.ts 產生（假的資料）：一個 FIT（2 天前 9 km，Garmin Forerunner 965）、
//   一個 Garmin Connect 單趟的 zip（今天 06:30，和模擬的 Intervals.icu 今天那趟是同一趟）、
//   一個帳號資料匯出的 zip（壓縮檔裡的壓縮檔：5 天前的跑步 COROS、6 天前的騎車 Garmin Edge 840、走路、每日健康資料、壞檔、400 天前的跑步）
// - 先照常同步 Intervals.icu → 紀錄頁「匯入檔案」先只選單趟的 zip → 按匯入之前就說「這些都已經有了」、沒有匯入的按鈕
//   → 選三個檔 → 找到 4 趟、「3 趟是新的，1 趟已經有了」、略過的說明（期間、不支援的運動、不是活動、讀不了）
//   → 匯入 → 「新增 3 趟，已經有了 1 趟（已合併）」→ 紀錄頁：Garmin 型號的標示、「檔案」的標籤、COROS 不標 Garmin、
//   今天那趟只有一筆、騎車在列表上 → 再選同一個檔：按匯入之前就說「這些都已經有了」→ 教練拿到的最近訓練有匯入的那趟
// - 回報頁的「匯入手錶的檔案」打開同一個畫面；不左右捲動；手機淺色與電腦深色的截圖（import-*）
// 這個腳本自己建置一份開著 multisport 的（放在 $E2E_OUT 底下），用 4185 埠開 vite preview；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4185;
const URL = `http://localhost:${PORT}/`;
let step = "start";

const localDate = (offsetDays = 0) => new Date(Date.now() + 8 * 3600_000 + offsetDays * 86_400_000).toISOString().slice(0, 10);

function build() {
  const outDir = path.join(E2E.OUT, "dist-import");
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

function makeFiles() {
  const dir = path.join(E2E.OUT, "import-files");
  execFileSync("npx", ["tsx", path.join(ROOT, "tools/e2e/make-activity-files.ts"), dir], { cwd: ROOT, stdio: "ignore", env: { ...process.env, TZ: "Asia/Taipei" } });
  return ["run.fit", "garmin-single.zip", "garmin-export.zip"].map((f) => path.join(dir, f));
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

async function flow(browser, view, files, check, problems) {
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
  // 檔案不上傳：匯入的期間不應該有任何請求帶著檔案的內容
  const uploads = [];
  page.on("request", (r) => {
    const body = r.postDataBuffer();
    if (body && body.length > 4000 && !r.url().includes("/v1/")) uploads.push(r.url());
  });
  const c = (k, v) => (check[`${tag}.${k}`] = v);
  const shot = (name, target = page) => target.screenshot({ path: `${E2E.OUT}/import-${tag}-${name}.png` });

  step = "設定與同步";
  await page.goto(URL);
  await E2E.setupMock(page, { mock: E2E.MOCK });
  await E2E.go(page, "回報");
  await page.getByRole("button", { name: /同步/ }).last().click();
  await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

  step = "回報頁的入口";
  const reportEntry = page.getByRole("button", { name: "匯入手錶的檔案" });
  c("reportEntry", await reportEntry.isVisible());
  await reportEntry.click();
  c("reportOpens", await page.locator(".import-files .drop-zone").isVisible());
  await page.locator(".import-files").getByRole("button", { name: "取消" }).click();

  step = "紀錄頁：選檔";
  await E2E.go(page, "紀錄");
  await page.locator("ul.runs li").first().waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "匯入檔案" }).click();
  const box = page.locator(".import-files");
  await box.locator(".drop-zone").waitFor();
  c("periodDefault12", (await box.getByLabel("匯入的期間").inputValue()) === "12");
  await shot("1-pick", box);

  step = "單趟的 zip 已經有了（和 Intervals.icu 的今天那趟同一趟）：按匯入之前就說";
  await box.locator("input[type=file]").setInputFiles([files[1]]);
  await box.locator(".import-preview").waitFor({ timeout: 30000 });
  c("singleAlreadyHave", (await box.locator(".import-preview").innerText()).startsWith("這些都已經有了"));
  c("singleNoImportButton", !(await box.getByRole("button", { name: /^匯入 \d+ 趟$/ }).count()) && !(await box.locator("button.primary").count()));
  await shot("2a-already", box);
  await box.getByRole("button", { name: "換別的檔" }).click();
  await box.locator(".drop-zone").waitFor();

  step = "三個檔";
  await box.locator("input[type=file]").setInputFiles(files);

  step = "掃描的結果";
  await box.getByRole("button", { name: /^匯入 \d+ 趟$/ }).waitFor({ timeout: 30000 });
  const reviewText = await box.innerText();
  c("found4", /找到 4 趟/.test(reviewText));
  c("previewSplit", reviewText.includes("3 趟是新的，1 趟已經有了"));
  c("skippedOlder", reviewText.includes("1 趟比選的期間舊"));
  c("skippedWalk", reviewText.includes("1 趟不支援的運動"));
  c("skippedWellness", reviewText.includes("1 個不是活動的檔"));
  c("skippedBroken", reviewText.includes("1 個讀不了的檔"));
  await box.locator("summary", { hasText: "讀不了的檔" }).click();
  c("brokenListed", (await box.locator(".disclosure-body").innerText()).includes("user_1_broken.fit"));
  c("onePrimaryReview", (await box.locator("button.primary").count()) === 1);
  await shot("2-review", box);

  step = "匯入";
  await box.getByRole("button", { name: "匯入 3 趟" }).click();
  const done = box.locator(".notice.ok");
  await done.waitFor({ timeout: 30000 });
  const doneText = await done.innerText();
  c("doneCounts", /新增 3 趟/.test(doneText) && /已經有了 1 趟/.test(doneText) && /同一趟/.test(doneText));
  await shot("3-done", box);
  await box.getByRole("button", { name: "看紀錄" }).click();
  c("closed", !(await page.locator(".import-files").count()));

  step = "紀錄頁的列表";
  const rows = page.locator("ul.runs > li");
  await rows.first().waitFor();
  const fileRun = rows.filter({ hasText: "9 km" }).first();
  c("fileRunListed", (await fileRun.count()) === 1);
  const fileRunText = await fileRun.innerText();
  c("fileRunGarmin", fileRunText.includes("Garmin Forerunner 965"));
  c("fileRunBadge", (await fileRun.locator(".badge", { hasText: "檔案" }).count()) === 1);
  const coros = rows.filter({ hasText: "5.8 km" }).first();
  c("corosListed", (await coros.count()) === 1);
  c("corosNoGarmin", !(await coros.innerText()).includes("Garmin"));
  c("corosBadge", (await coros.locator(".badge", { hasText: "檔案" }).count()) === 1);
  const today = rows.filter({ hasText: "10 km" }).first();
  // 和 Intervals.icu 同一趟的沒有再存一次：今天只有一筆 10 km
  c("todayOnce", (await rows.filter({ hasText: "10 km" }).count()) === 1);
  c("todayNotFileBadge", !(await today.locator(".badge", { hasText: "檔案" }).count()));
  const ride = rows.filter({ hasText: "Garmin Edge 840" });
  c("rideListed", (await ride.count()) >= 1);
  // 點開匯入的那趟：卡片上有 Garmin 的標示、可以補體感、可以刪
  await fileRun.locator("button").first().click();
  const card = fileRun.locator(".run-card");
  await card.waitFor();
  c("cardGarmin", (await card.locator(".data-source").innerText()) === "Garmin Forerunner 965");
  c("cardBackfill", await fileRun.getByRole("button", { name: "補填體感" }).isVisible());
  c("cardDelete", await fileRun.getByRole("button", { name: "刪除這一筆" }).isVisible());
  await shot("4-history", page.locator("section.card", { hasText: "最近" }).first());

  step = "再匯一次";
  await page.getByRole("button", { name: "匯入檔案" }).click();
  await box.locator("input[type=file]").setInputFiles([files[0]]);
  await box.locator(".import-preview").waitFor({ timeout: 30000 });
  c("reimportExisting", (await box.locator(".import-preview").innerText()).startsWith("這些都已經有了") && !(await box.locator("button.primary").count()));
  await box.getByRole("button", { name: "換別的檔" }).click();
  await box.getByRole("button", { name: "取消" }).click();
  c("stillOneFileRun", (await rows.filter({ hasText: "9 km" }).count()) === 1);
  c("noUploads", uploads.length === 0);

  step = "教練看得到";
  await E2E.go(page, "對話");
  const input = page.getByPlaceholder(/問教練|輸入/).first();
  await input.fill("最近練得怎樣");
  await input.press("Enter");
  await page.locator(".bubble .sources").last().waitFor({ timeout: 30000 });
  const requests = (await (await fetch(`${E2E.MOCK}/_mock/requests`)).json()).filter((r) => r.kind === "llm");
  const sent = JSON.stringify(requests.slice(-3));
  c("coachSeesFileRun", sent.includes(`【${localDate(-2)}】9km`));
  c("coachSeesCoros", sent.includes(`【${localDate(-5)}】5.76km`));

  c("noHorizontalScroll", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await context.close();
}

(async () => {
  const outDir = build();
  const files = makeFiles();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  try {
    for (const view of VIEWS) {
      try {
        await flow(browser, view, files, check, problems);
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
