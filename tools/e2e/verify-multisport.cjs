// 驗證多運動的基礎與跑者的交叉訓練（規格 12.24 的第 2 階段），功能開關 multisport（12.25）：
// - 設定頁最下面列出開著的功能
// - 選手資料：練哪些運動（可複選）與各自的目標，存了之後教練看得到（系統提示）
// - 課表：交叉訓練（騎車）的目標用騎車自己的心率區間與功率區間（模擬上游的騎車設定），不是跑步的
// - 肌力的課可以回報「做完了」、取消；教練看得到（get_training_plan）
// - 課表外的騎車：教練動態問要不要調整接下來的課，點了請教練重排（A → A'）
// - 手機與電腦、淺色與深色的截圖
// 單車（12.24 的第 3 階段）：
// - 排一週跑步＋騎車的課表：檢查器的跨運動警告（兩項合計的強度課、不連排）回給教練；系統提示是耐力運動教練、有單車的教練方法
// - 課表頁：單車的課有 🚴 與自己的顏色、騎車的心率區間（甜蜜點）、短間歇看體感、上面的總量有騎車；今天的耐力騎配對到今天的騎車（達成）
// - 課表外的騎車排在時間軸上（第 2 階段的課表）
// - 「運動回報」選騎車填體感，課表的判斷看得到體感；紀錄頁列出騎車與騎車的累積
// - 騎車的賽事（教練看得到「（單車）」）；使用說明有「跑步以外的運動」
// - 只練騎車：新手引導只選騎車、同步完成、排只騎車的課表（系統提示不帶跑步的方法）
// - 開關關著的一般建置（E2E_URL，4173）：設定頁沒有列功能、選手資料沒有新的欄位、工具沒有 sport、教練方法是 v3、
//   分頁是「跑後回報」、使用說明沒有多運動、新手引導沒有「選擇你練的運動」
// 這個腳本自己建置一份開著 multisport 的（放在 $E2E_OUT 底下），用 4176 埠開 vite preview；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4176;
const URL = `http://localhost:${PORT}/`;
const taipei = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(d);
const TODAY = taipei(new Date());

let step = "start";

function build() {
  const outDir = path.join(E2E.OUT, "dist-multisport");
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

const requests = async () => (await fetch(`${E2E.MOCK}/_mock/requests`)).json();

const VIEWS = [
  { width: 390, height: 844, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
  { width: 1280, height: 860, scheme: "light" },
  { width: 1280, height: 860, scheme: "dark" },
];

async function flow(browser, { width, height, scheme }, check, problems) {
  const mobile = width < 600;
  const tag = `${width}-${scheme}`;
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }),
    colorScheme: scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  const tab = (name) => E2E.go(page, name);
  const until = async (fn) => {
    for (let i = 0; i < 25; i++) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const first = tag === "390-light";
  const send = async (text) => {
    await tab("對話");
    await page.getByPlaceholder("輸入訊息…").fill(text);
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator(`.msg.user:has-text("${text.slice(0, 12)}") ~ .msg.assistant .bubble.assistant`).first().waitFor({ timeout: 30000 });
    return page.locator(".bubble.assistant").last().innerText();
  };

  try {
    step = "設定";
    await page.goto(URL);
    await tab("設定");
    await page.getByLabel("供應商").selectOption("openai-compatible");
    await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
    await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
    await page.getByLabel("主對話模型").fill("mock-model");
    await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
    await page.getByLabel("我了解並同意以上的資料流向").check();
    await page.getByRole("button", { name: "儲存設定" }).click();
    if (first) check.featuresListed = (await page.locator(".features-on").innerText()).includes("多運動（multisport）");
    await tab("運動回報");
    await page.getByRole("button", { name: /同步/ }).last().click();
    await page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

    step = "練哪些運動";
    await tab("選手資料");
    await page.locator("section.training-values").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const picker = page.locator("fieldset.sports-picker");
    // 每項運動一張卡，勾了才出現（規格 12.26 第 4 點）；沒勾任何運動時只有跑步的卡（當成只跑步）
    const rideFieldset = page.locator('fieldset.sport-card[data-sport="ride"]');
    if (first) check.rideCardHiddenBefore = (await rideFieldset.count()) === 0 && (await page.locator('fieldset.sport-card[data-sport="run"]').count()) === 1;
    for (const name of ["跑步", "騎車", "肌力訓練"]) await picker.getByLabel(name, { exact: true }).check();
    if (first) check.rideCardShown = (await rideFieldset.count()) === 1 && (await page.locator("fieldset.pref-common").getByLabel("主要運動").count()) === 1;
    await page.getByLabel("騎車的目標").selectOption("distance");
    if (first) check.goalFields = (await page.getByLabel("肌力訓練的目標").count()) === 1 && (await page.getByLabel("游泳的目標").count()) === 0;
    await page.getByLabel("跑步的強度").selectOption("moderate");
    await page.getByRole("button", { name: "儲存選手資料" }).click();
    await page.locator(".notice.ok", { hasText: "已儲存" }).waitFor({ timeout: 5000 });
    await picker.screenshot({ path: `${E2E.OUT}/multisport-${tag}-profile.png` });
    if (first) {
      // 重新讀取後還在
      await tab("計畫與賽事");
      await tab("選手資料");
      await page.locator("section.training-values").waitFor({ timeout: 10000 });
      check.sportsSaved =
        (await until(async () => (await picker.getByLabel("騎車", { exact: true }).isChecked()) && !(await picker.getByLabel("游泳", { exact: true }).isChecked()))) &&
        (await page.getByLabel("騎車的目標").inputValue()) === "distance";
    }

    step = "請教練排這週的課表";
    const reply = await send("幫我排這週的課表");
    if (first) {
      check.coachSaved = reply.includes("課表已儲存");
      const llm = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body));
      const last = llm.filter((b) => b.includes("幫我排這週的課表")).at(-1) ?? "";
      check.toolHasSport = last.includes("交叉訓練（kind=cross）是哪種運動");
      check.promptHasSports = last.includes("練的運動：跑步、騎車、肌力訓練") && last.includes("騎車：目標 長距離（百公里、長途）") && last.includes("【教練方法 v6】");
    }

    step = "課表頁：騎車的目標";
    await tab("計畫與賽事");
    const card = page.locator("section.plan-card");
    await card.locator(".plan-session").first().waitFor({ timeout: 10000 });
    // 週日時週六的課已經在「這週稍早」
    const earlier = card.locator("details.plan-earlier");
    if (await earlier.count()) await earlier.locator("summary").click();
    const rideCard = card.locator(".plan-session", { hasText: "輕鬆騎車" }).first();
    await rideCard.waitFor({ timeout: 5000 });
    if ((await rideCard.locator(".plan-session-head").getAttribute("aria-expanded")) !== "true") await rideCard.locator(".plan-session-head").click();
    const rideText = await rideCard.innerText();
    if (first) {
      // 騎車自己的區間（模擬上游：Z2 136–142）；跑步的 Z2 是 145–151，不能出現
      check.rideHr = rideText.includes("心率 Z2（136–142）") && !rideText.includes("145–151");
      check.ridePower = rideText.includes("功率 Z3（151–180 W）");
    }
    await rideCard.screenshot({ path: `${E2E.OUT}/multisport-${tag}-ride.png` });
    // 今天傍晚課表外的騎車排在時間軸的今天
    if (first) check.timelineOther = (await card.locator(".tl-day.today .plan-other", { hasText: "課表外的騎車" }).count()) === 1;

    step = "肌力回報做完了";
    const strength = card.locator(".plan-session", { hasText: "今天的肌力" }).first();
    await strength.waitFor({ timeout: 5000 });
    if ((await strength.locator(".plan-session-head").getAttribute("aria-expanded")) !== "true") await strength.locator(".plan-session-head").click();
    await strength.getByRole("button", { name: "做完了" }).click();
    const doneBadge = await until(async () => (await strength.locator(".badge").innerText()) === "做完了");
    const undoShown = await until(async () => (await strength.getByRole("button", { name: "取消「做完了」" }).count()) === 1);
    await strength.screenshot({ path: `${E2E.OUT}/multisport-${tag}-strength.png` });
    if (first) {
      check.strengthDone = doneBadge && undoShown;
      // 還沒到的課沒有「做完了」：週六的騎車不是肌力，本來就沒有
      check.noDoneOnRide = (await rideCard.getByRole("button", { name: "做完了" }).count()) === 0;
      // 教練看得到
      const planReply = await send("我的課表做到哪了");
      check.coachSeesDone = planReply.includes("選手回報做完了");
      await tab("計畫與賽事");
      const again = page.locator("section.plan-card .plan-session", { hasText: "今天的肌力" }).first();
      await again.waitFor({ timeout: 10000 });
      // 今天的課預設展開；收起時才點開
      if ((await again.locator(".plan-session-head").getAttribute("aria-expanded")) !== "true") await again.locator(".plan-session-head").click();
      await again.getByRole("button", { name: "取消「做完了」" }).click();
      check.strengthUndone = await until(async () => (await again.getByRole("button", { name: "做完了" }).count()) === 1);
    }

    step = "教練動態：課表外的騎車";
    await tab("對話");
    const feed = page.locator("section.feed");
    await feed.waitFor({ timeout: 10000 });
    if (await feed.locator(".feed-summary").count()) await feed.locator(".feed-summary").click();
    const item = feed.locator(".feed-item", { hasText: "課表外的騎車" }).first();
    const found = await until(async () => (await item.count()) === 1);
    if (first) check.feedCross = found && (await item.innerText()).includes("60 分鐘、平均心率 128、負荷 38");
    if (found) {
      await item.scrollIntoViewIfNeeded();
      await item.screenshot({ path: `${E2E.OUT}/multisport-${tag}-feed.png` });
    }
    if (first && found) {
      step = "請教練調整接下來的課";
      await item.getByRole("button", { name: "請教練調整接下來的課" }).click();
      // 動態的按鈕直接把這段話送給教練
      await page.locator('.msg.user:has-text("請依這趟調整") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
      check.askSent = (await page.locator(".msg.user").last().innerText()).includes("做了課表外的騎車：60 分鐘");
      check.replanned = (await page.locator(".bubble.assistant").last().innerText()).includes("課表已儲存");
      await tab("計畫與賽事");
      await page.getByRole("button", { name: "為什麼這樣排" }).click();
      check.replanReason = (await page.locator("#plan-why").innerText()).includes("依課表外的騎車調整");
    }
    await context.close();
  } catch (e) {
    problems.push(`[${tag} ${step}] ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `${E2E.OUT}/multisport-${tag}-FAILED.png` }).catch(() => {});
    await context.close();
  }
}

/** 共用：設定 AI 與 Intervals.icu */
async function setup(page, url) {
  await E2E.go(page, "設定");
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();
  void url;
}

/** 單車（第 3 階段）：跑步＋騎車的課表、課表頁、運動回報、紀錄、賽事、使用說明 */
async function cyclingFlow(browser, { width, height, scheme }, check, problems) {
  const mobile = width < 600;
  const tag = `${width}-${scheme}`;
  const first = tag === "390-light";
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }),
    colorScheme: scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[cycling ${tag} ${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[cycling ${tag} ${step}] pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  const tab = (name) => E2E.go(page, name);
  const until = async (fn) => {
    for (let i = 0; i < 25; i++) {
      if (await fn().catch(() => false)) return true;
      await page.waitForTimeout(200);
    }
    return false;
  };
  const send = async (text) => {
    await tab("對話");
    await page.getByPlaceholder("輸入訊息…").fill(text);
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator(`.msg.user:has-text("${text.slice(0, 12)}") ~ .msg.assistant .bubble.assistant`).first().waitFor({ timeout: 30000 });
    return page.locator(".bubble.assistant").last().innerText();
  };
  const openSession = async (s) => {
    if ((await s.locator(".plan-session-head").getAttribute("aria-expanded")) !== "true") await s.locator(".plan-session-head").click();
  };
  try {
    step = "單車：設定";
    await page.goto(URL);
    await setup(page);
    await tab("運動回報");
    await page.getByRole("button", { name: /同步/ }).last().click();
    await page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

    step = "單車：練跑步與騎車";
    await tab("選手資料");
    await page.locator("section.training-values").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const picker = page.locator("fieldset.sports-picker");
    for (const name of ["跑步", "騎車"]) await picker.getByLabel(name, { exact: true }).check();
    await page.getByLabel("跑步的強度").selectOption("moderate");
    await page.getByLabel("騎車的強度").selectOption("moderate");
    await page.getByLabel("主要運動").selectOption("run");
    await page.getByLabel("每週騎幾小時").fill("3");
    await page.getByRole("button", { name: "儲存選手資料" }).click();
    await page.locator(".notice.ok", { hasText: "已儲存" }).waitFor({ timeout: 5000 });
    await page.locator("fieldset.pref-common").screenshot({ path: `${E2E.OUT}/cycling-${tag}-pref-common.png` });
    await page.locator('fieldset.sport-card[data-sport="ride"]').screenshot({ path: `${E2E.OUT}/cycling-${tag}-pref-ride.png` });

    if (first) {
      step = "單車：教練看到的額度";
      // 回覆會把整份訓練數值念一遍（模擬上游逐段送出，很長），等久一點
      await tab("對話");
      await page.getByPlaceholder("輸入訊息…").fill("這週的強度怎麼分配");
      await page.getByRole("button", { name: "送出" }).click();
      await page.locator('.msg.user:has-text("這週的強度怎麼分配") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 120000 });
      const values = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body)).filter((b) => b.includes("這週的強度怎麼分配")).join("\n");
      check.coachSeesAllocation = values.includes("【這週的額度】") && values.includes("主要運動是跑步") && /騎車 [0-9]/.test(values) && values.includes("強度課");
    }

    step = "單車：排跑步和騎車的課表";
    const reply = await send("幫我排跑步和騎車的課表");
    if (first) {
      check.cyclingPlanSaved = reply.includes("課表已儲存");
      const bodies = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body)).filter((b) => b.includes("幫我排跑步和騎車的課表"));
      const all = bodies.join("\n");
      check.crossSportWarnings = all.includes("尚未儲存") && all.includes("強度課這週的額度是") && all.includes("跑步與騎車的強度課一起算");
      check.cyclingPrompt = all.includes("【單車的教練方法 v2】") && all.includes("你是一位專業的耐力運動教練") && all.includes("ride_sweetspot");
    }

    step = "單車：課表頁";
    await tab("計畫與賽事");
    const card = page.locator("section.plan-card");
    // 今天以前的課收在「這週稍早」（看不見），等時間軸上的
    await card.locator(".timeline .plan-session").first().waitFor({ timeout: 10000 });
    const earlier = card.locator("details.plan-earlier");
    if (await earlier.count()) await earlier.locator("summary").click();
    const top = await card.locator(".plan-week").innerText();
    const sweet = card.locator('.plan-session[data-sport="ride"]', { hasText: "甜蜜點 2 × 15 分鐘" }).first();
    await sweet.waitFor({ timeout: 5000 });
    await openSession(sweet);
    const sweetText = await sweet.innerText();
    const vo2 = card.locator('.plan-session[data-sport="ride"]', { hasText: "5 × 4 分鐘" }).first();
    await openSession(vo2);
    const vo2Text = await vo2.innerText();
    const endurance = card.locator('.plan-session[data-sport="ride"]', { hasText: "耐力騎" }).first();
    await openSession(endurance);
    if (first) {
      check.planTopRide = /騎車 3 次/.test(top) && top.includes("km");
      check.rideIcon = (await sweet.locator(".plan-sport-icon").innerText()).includes("🚴");
      check.sweetSpotHr = sweetText.includes("心率 甜蜜點（146–154）");
      check.shortIntervalRpe = vo2Text.includes("體感 8–9/10（短間歇");
      check.enduranceMatched = (await until(async () => (await endurance.locator(".badge").innerText()) === "達成")) && (await endurance.innerText()).includes("實際：60 分鐘");
      const color = await sweet.evaluate((el) => getComputedStyle(el).borderLeftColor);
      check.rideColor = color !== (await card.locator(".plan-session:not([data-sport])").first().evaluate((el) => getComputedStyle(el).borderLeftColor));
    }
    await card.screenshot({ path: `${E2E.OUT}/cycling-${tag}-plan.png` });
    await sweet.screenshot({ path: `${E2E.OUT}/cycling-${tag}-sweetspot.png` });

    step = "單車：運動回報";
    await tab("運動回報");
    const option = page.locator("label.choice", { hasText: "騎車" }).first();
    await option.waitFor({ timeout: 10000 });
    await option.click();
    await page.locator('input[type="range"]').first().fill("4");
    await page.getByLabel("主觀感受").fill("輕鬆，腿還好");
    await page.getByRole("button", { name: /存到.*騎車/ }).click();
    const saved = await until(async () => (await page.locator(".notice.ok", { hasText: "已存到這趟騎車" }).count()) === 1);
    await page.locator("section.card").first().screenshot({ path: `${E2E.OUT}/cycling-${tag}-report.png` });
    if (first) {
      check.rideReported = saved;
      await tab("計畫與賽事");
      const again = page.locator('section.plan-card .plan-session[data-sport="ride"]', { hasText: "耐力騎" }).first();
      await again.waitFor({ timeout: 10000 });
      await openSession(again);
      check.rideRpeInPlan = await until(async () => (await again.innerText()).includes("體感 4"));
    }

    step = "單車：紀錄頁";
    await tab("紀錄");
    await page.locator("section.ride-totals").waitFor({ timeout: 10000 });
    const rides = page.locator("ul.runs li.ride");
    await rides.first().waitFor({ timeout: 10000 });
    await rides.first().locator(".run-row").click();
    const rideCard = rides.first().locator(".ride-card");
    await rideCard.waitFor({ timeout: 5000 });
    if (first) {
      check.historyRides = (await rides.count()) >= 3 && (await page.locator("ul.runs > li:not(.ride)").count()) >= 2;
      const text = await rideCard.innerText();
      check.rideCard = text.includes("平均心率") && text.includes("體感 4/10") && text.includes("128");
      check.rideTotals = (await page.locator("section.ride-totals").innerText()).includes("騎了");
    }
    await page.locator("section.ride-totals").screenshot({ path: `${E2E.OUT}/cycling-${tag}-ride-totals.png` });
    await rides.first().screenshot({ path: `${E2E.OUT}/cycling-${tag}-history-ride.png` });

    if (first) {
      step = "單車：賽事";
      await tab("計畫與賽事");
      await page.getByRole("button", { name: "新增賽事" }).click();
      const form = page.locator("form").filter({ has: page.getByText("賽事名稱") }).first();
      await form.getByLabel("運動").selectOption("ride");
      await form.getByLabel("賽事名稱").fill("模擬百K");
      const date = taipei(new Date(Date.now() + 20 * 86_400_000));
      await form.getByLabel("日期").fill(date);
      await form.getByLabel("距離（km）").fill("100");
      await form.getByRole("button", { name: "新增" }).click();
      const raceRow = page.locator("#races li", { hasText: "模擬百K" }).first();
      check.rideRace = await until(async () => (await raceRow.innerText()).includes("🚴 單車"));
      await send("我的課表做到哪了");
      const body = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body)).filter((b) => b.includes("我的課表做到哪了")).at(-1) ?? "";
      check.coachSeesRideRace = body.includes("模擬百K 100km（單車）");

      step = "單車：使用說明";
      await tab("使用說明");
      check.helpMultisport = (await page.locator("#help-multisport").count()) === 1 && (await page.locator("#help-report h2").innerText()) === "運動回報";
    }
    await context.close();
  } catch (e) {
    problems.push(`[cycling ${tag} ${step}] ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `${E2E.OUT}/cycling-${tag}-FAILED.png` }).catch(() => {});
    await context.close();
  }
}

/** 只練騎車：新手引導只選騎車、同步、排只騎車的課表 */
async function rideOnlyFlow(browser, check, problems) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, timezoneId: "Asia/Taipei" });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`[ride-only ${step}] ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[ride-only ${step}] pageerror: ${e.message}`));
  try {
    step = "只騎車：設定";
    await page.goto(URL);
    await setup(page);
    step = "只騎車：新手引導";
    await E2E.go(page, "對話");
    const guide = page.locator("section.getting-started");
    await guide.waitFor({ timeout: 10000 });
    const sports = guide.locator("fieldset.onboarding-sports");
    await sports.getByLabel("跑步", { exact: true }).uncheck();
    await sports.getByLabel("騎車", { exact: true }).check();
    await guide.getByRole("button", { name: "儲存練的運動" }).click();
    await guide.locator(".step.done", { hasText: "選擇你練的運動" }).waitFor({ timeout: 5000 });
    await guide.screenshot({ path: `${E2E.OUT}/cycling-ride-only-onboarding.png` });
    await guide.getByRole("button", { name: "同步最近 14 天" }).click();
    await page.locator(".notice", { hasText: /同步完成/ }).first().waitFor({ timeout: 30000 });
    check.rideOnlyOnboarding = (await page.locator("section.getting-started h2", { hasText: "準備好了" }).count()) === 1;
    step = "只騎車：排課表";
    await page.getByPlaceholder("輸入訊息…").fill("幫我排只騎車的課表");
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator('.msg.user:has-text("幫我排只騎車的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
    // 系統提示（OpenAI 相容的請求是第一則 system）；工具的說明本來就提到 Daniels，不算
    const sent = (await requests()).filter((r) => r.kind === "llm" && JSON.stringify(r.body).includes("幫我排只騎車的課表"))[0]?.body;
    const system = String(sent?.messages?.find((m) => m.role === "system")?.content ?? "");
    check.rideOnlyPrompt = system.includes("這位選手練的運動：騎車") && !system.includes("Daniels") && system.includes("【單車的教練方法 v2】");
    check.rideOnlySaved = (await page.locator(".bubble.assistant").last().innerText()).includes("課表已儲存");
    await E2E.go(page, "計畫與賽事");
    const top = page.locator("section.plan-card .plan-week");
    await top.waitFor({ timeout: 10000 });
    check.rideOnlyPlan = /騎車 3 次/.test(await top.innerText()) && !(await top.innerText()).includes("跑步");
    await E2E.go(page, "選手資料");
    await page.locator("fieldset.sports-picker").waitFor({ timeout: 10000 });
    // 選手資料讀進來之前當成只跑步：等跑步的卡消失
    for (let i = 0; i < 25 && (await page.locator('fieldset.sport-card[data-sport="run"]').count()) > 0; i++) await page.waitForTimeout(200);
    check.rideOnlyCards =
      (await page.locator('fieldset.sport-card[data-sport="run"]').count()) === 0 &&
      (await page.locator('fieldset.sport-card[data-sport="ride"]').count()) === 1 &&
      (await page.getByLabel("長跑日").count()) === 0 &&
      (await page.getByLabel("主要運動").count()) === 0;
    await page.locator('fieldset.sport-card[data-sport="ride"]').screenshot({ path: `${E2E.OUT}/cycling-ride-only-profile.png` });
    await E2E.go(page, "對話");
    check.rideOnlyNoRunGap = (await page.locator(".feed-item", { hasText: "天沒跑了" }).count()) === 0;
  } catch (e) {
    problems.push(`[ride-only ${step}] ${e.message.split("\n")[0]}`);
    await page.screenshot({ path: `${E2E.OUT}/cycling-ride-only-FAILED.png` }).catch(() => {});
  }
  await context.close();
}

/** 開關關著的一般建置（E2E_URL）：設定頁沒有列功能、選手資料沒有新的欄位、送給教練的工具沒有 sport */
async function offFlow(browser, check, problems) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Taipei" });
  const page = await context.newPage();
  page.on("pageerror", (e) => problems.push(`[off ${step}] pageerror: ${e.message}`));
  try {
    step = "關著：設定";
    await page.goto(E2E.URL);
    await E2E.go(page, "設定");
    await page.getByLabel("供應商").selectOption("openai-compatible");
    await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
    await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
    await page.getByLabel("主對話模型").fill("mock-model");
    await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
    await page.getByLabel("我了解並同意以上的資料流向").check();
    await page.getByRole("button", { name: "儲存設定" }).click();
    // 一般的建置開著 testmode（測試模式，E2E 用），沒有多運動
    check.offNoFeatures = !(await page.locator(".features-on").innerText().catch(() => "")).includes("多運動");
    step = "關著：選手資料";
    await E2E.go(page, "選手資料");
    await page.locator("section.training-values").waitFor({ timeout: 10000 });
    check.offNoPicker = (await page.locator("fieldset.sports-picker").count()) === 0 && (await page.getByText("其他會做的運動").count()) === 1;
    step = "關著：對話";
    await E2E.go(page, "對話");
    await page.getByPlaceholder("輸入訊息…").fill("關著時看看課表");
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator('.msg.user:has-text("關著時看看課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });
    const body = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body)).filter((b) => b.includes("關著時看看課表"))[0] ?? "";
    check.offToolsUnchanged = body.includes("save_training_plan") && !body.includes("交叉訓練（kind=cross）是哪種運動") && body.includes("【教練方法 v3】");
    check.offNoCycling = !body.includes("ride_sweetspot") && !body.includes("save_activity_feedback") && body.includes("你是一位專業跑步教練");
    check.offReportTab = (await page.getByRole("button", { name: "跑後回報", exact: true }).count()) >= 1 && (await page.getByRole("button", { name: "運動回報", exact: true }).count()) === 0;
    check.offNoSportsStep = (await page.getByText("選擇你練的運動").count()) === 0;
    await E2E.go(page, "使用說明");
    check.offHelp = (await page.locator("#help-multisport").count()) === 0;
  } catch (e) {
    problems.push(`[off ${step}] ${e.message.split("\n")[0]}`);
  }
  await context.close();
}

(async () => {
  const problems = [];
  const check = {};
  let server = null;
  try {
    step = "build";
    server = await serve(build());
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message);
    if (server) server.kill();
    process.exit(1);
  }
  const browser = await chromium.launch();
  try {
    await offFlow(browser, check, problems);
    for (const view of VIEWS) await flow(browser, view, check, problems);
    for (const view of VIEWS) await cyclingFlow(browser, view, check, problems);
    await rideOnlyFlow(browser, check, problems);
  } finally {
    await browser.close();
    server.kill();
  }
  console.log(`today ${TODAY}`);
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  const ok = Object.values(check).length > 0 && Object.values(check).every(Boolean) && problems.length === 0;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
