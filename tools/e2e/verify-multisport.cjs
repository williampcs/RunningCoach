// 驗證多運動的基礎與跑者的交叉訓練（規格 12.24 的第 2 階段），功能開關 multisport（12.25）：
// - 設定頁最下面列出開著的功能
// - 選手資料：練哪些運動（可複選）與各自的目標，存了之後教練看得到（系統提示）
// - 課表：交叉訓練（騎車）的目標用騎車自己的心率區間與功率區間（模擬上游的騎車設定），不是跑步的
// - 肌力的課可以回報「做完了」、取消；教練看得到（get_training_plan）
// - 課表外的騎車：教練動態問要不要調整接下來的課，點了請教練重排（A → A'）
// - 手機與電腦、淺色與深色的截圖
// - 開關關著的一般建置（E2E_URL，4173）：設定頁沒有列功能、選手資料沒有新的欄位、工具沒有 sport、教練方法是 v3
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
    await tab("跑後回報");
    await page.getByRole("button", { name: /同步/ }).last().click();
    await page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

    step = "練哪些運動";
    await tab("選手資料");
    await page.locator("section.training-values").waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    const picker = page.locator("fieldset.sports-picker");
    for (const name of ["跑步", "騎車", "肌力訓練"]) await picker.getByLabel(name, { exact: true }).check();
    await page.getByLabel("騎車的目標").fill("週末一次 2 小時的長騎");
    if (first) check.goalFields = (await page.getByLabel("肌力訓練的目標").count()) === 1 && (await page.getByLabel("游泳的目標").count()) === 0;
    await page.locator("label", { hasText: /^強度/ }).locator("select").selectOption("moderate");
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
        (await page.getByLabel("騎車的目標").inputValue()) === "週末一次 2 小時的長騎";
    }

    step = "請教練排這週的課表";
    const reply = await send("幫我排這週的課表");
    if (first) {
      check.coachSaved = reply.includes("課表已儲存");
      const llm = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body));
      const last = llm.filter((b) => b.includes("幫我排這週的課表")).at(-1) ?? "";
      check.toolHasSport = last.includes("交叉訓練（kind=cross）是哪種運動");
      check.promptHasSports = last.includes("練的運動：跑步、騎車、肌力訓練") && last.includes("騎車的目標：週末一次 2 小時的長騎") && last.includes("【教練方法 v4】");
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
    check.offNoFeatures = (await page.locator(".features-on").count()) === 0;
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
