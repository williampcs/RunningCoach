// 測試模式的清空資料與重置成第一次打開（9.4 的工作單）：測試模式有自己一份設定與標記，正常模式的資料與設定不受影響
// A. 手機淺色：正常模式設好 AI、說一句話 → 啟用測試模式（設定複製過去）→ 在測試模式改模型，正常模式的設定不變
//    → 產生假資料（選手資料有範例）→「清空資料」：資料沒了、設定還在 →「整個重置」：歡迎頁與精靈、上方的測試模式提示可以離開
//    → 走完精靈（沒有在記錄 → Claude → 手動記 → 略過）→ 新手引導、AI 是精靈設的那一個 →「帶入正常設定」：回到正常模式的 AI
//    → 再整個重置 → 在精靈上「離開測試模式」→ 正常模式：沒有精靈、說過的話與設定都在
// B. 電腦深色：正常模式開密碼鎖 → 啟用測試模式：要輸入同一個密碼、複製過去的 key 是密文 → 整個重置後沒有密碼鎖、精靈 →
//    「測試設定」打開測試模式的卡片 → 停用 → 正常模式要密碼、key 還在
// 每一頁截圖（test-reset-*）；設計準則：每張卡最多一顆主要按鈕、按鈕至少 44 高、不左右捲動。
// 這個腳本自己建置一份（4183 埠：testmode、onboarding，Anthropic 指向模擬上游）；只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const ROOT = path.join(__dirname, "../..");
const WEB = path.join(ROOT, "apps/web");
const PORT = 4183;
const APP_URL = `http://localhost:${PORT}/`;
const OUT = E2E.OUT;

function build() {
  const outDir = path.join(OUT, "dist-test-reset");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_ANTHROPIC_BASE_URL: E2E.MOCK,
      VITE_FEATURES: "testmode,onboarding",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(APP_URL)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${PORT} 開起來`);
}

const NORMAL = "running-coach.settings.v1";
const TEST = "running-coach.test.settings.v1";
const stored = (page, key) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), key);
const raw = (page, key) => page.evaluate((k) => localStorage.getItem(k), key);

async function newPage(browser, problems, { width, height, scheme }) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 1, isMobile: width < 600, hasTouch: width < 600 });
  // 正常模式的第一次打開跳過精靈（測試模式那一份的精靈不受影響）
  await E2E.skipWizard(context);
  const page = await context.newPage();
  page.on("console", (m) => m.text().startsWith("design:") && console.log(m.text()));
  page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  // 確認的對話框一律按確定，記下內容
  page.dialogs = [];
  page.on("dialog", (d) => {
    page.dialogs.push(d.message());
    void d.accept();
  });
  await page.goto(APP_URL);
  return page;
}

/** 這一頁照設計準則：每張卡最多一顆主要按鈕、看得到的按鈕至少 44 高、不左右捲動 */
async function design(page) {
  return page.evaluate(() => {
    const visible = (el) => el.getBoundingClientRect().height > 0;
    const cards = [...document.querySelectorAll(".card, .wizard-page")];
    const tooMany = cards.some((c) => [...c.querySelectorAll("button.primary")].filter(visible).length > 1);
    const short = [...document.querySelectorAll("#side-panel button, .wizard button, .notices button")]
      .filter(visible)
      // ⓘ 是句子旁邊的小按鈕（全站一樣是 32）
      .filter((b) => !b.closest("details > summary") && !b.classList.contains("info-button") && b.getBoundingClientRect().height < 43.5).length;
    const scroll = document.documentElement.scrollWidth > window.innerWidth + 1;
    if (tooMany || short || scroll) console.log(`design: tooMany=${tooMany} short=${[...document.querySelectorAll("#side-panel button, .wizard button, .notices button")].filter(visible).filter((b) => !b.closest("details > summary") && !b.classList.contains("info-button") && b.getBoundingClientRect().height < 43.5).map((b) => b.className + ":" + (b.getAttribute("aria-label") || b.textContent) + ":" + b.getBoundingClientRect().height).join(",")} scroll=${scroll}`);
    return !tooMany && short === 0 && !scroll;
  });
}

const testCard = (page) => page.locator('#side-panel .subpage[data-section="testmode"]');

async function enableTestMode(page) {
  await E2E.settings(page, "測試模式");
  await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "啟用測試模式" }).click()]);
}

async function clickAndReload(page, button) {
  await Promise.all([page.waitForEvent("load"), button.click()]);
}

/** 設定「AI 教練」的主對話模型（收在「進階」裡） */
async function chatModel(page) {
  await E2E.settings(page, "AI 教練");
  const panel = page.locator("#side-panel");
  const advanced = panel.locator('.subpage[data-section="ai"] details.advanced').first();
  if (!(await advanced.evaluate((d) => d.open))) await advanced.locator("summary").click();
  return panel.getByLabel("主對話模型");
}

async function send(page, text) {
  await page.getByLabel("訊息").fill(text);
  await page.getByRole("button", { name: "送出" }).click();
  await page.locator(".bubble.assistant").last().waitFor({ timeout: 30000 });
}

/** 走完精靈：沒有在記錄 → Claude（mock-key）→ 同意 → 手動記 → 記第一筆略過 → 略過選手資料 */
async function walkWizard(page) {
  await page.getByRole("button", { name: "開始設定" }).click();
  await page.locator("label.choice", { hasText: "沒有在記錄" }).click();
  await page.getByRole("button", { name: "繼續" }).click();
  await page.locator("label.choice", { hasText: "Anthropic" }).click();
  await page.getByRole("button", { name: "繼續" }).click();
  await page.getByLabel("API key", { exact: true }).fill("mock-key");
  await page.getByText("可以用，已存在這個瀏覽器").waitFor({ timeout: 10000 });
  await page.getByRole("button", { name: "繼續" }).click();
  await page.getByRole("button", { name: "同意並繼續" }).click();
  await page.locator(".wizard-page[data-step=source]").waitFor();
  await page.locator("label.choice", { hasText: "手動記" }).click();
  await page.getByRole("button", { name: "繼續" }).click();
  await page.locator(".wizard-page[data-step=first]").waitFor();
  // 記第一筆可以先不記
  const skip = page.locator(".wizard-page").getByRole("button", { name: /略過|先不記|之後再記/ });
  if (await skip.count()) await skip.first().click();
  else await page.getByRole("button", { name: "繼續" }).click();
  await page.locator(".wizard-page[data-step=profile]").waitFor();
  await page.getByRole("button", { name: "略過，開始用" }).click();
  await page.locator(".tabbar").waitFor();
}

(async () => {
  const outDir = build();
  const server = await serve(outDir);
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const designOk = [];
  let step = "";
  try {
    // ---------- A. 手機淺色 ----------
    step = "A 正常模式";
    let page = await newPage(browser, problems, { width: 390, height: 844, scheme: "light" });
    await page.locator(".tabbar").waitFor();
    await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });
    await E2E.go(page, "對話");
    await send(page, "正常模式的第一句話");
    const normalBefore = await raw(page, NORMAL);

    step = "A 啟用測試模式";
    await enableTestMode(page);
    await page.locator(".test-banner").waitFor();
    const copied = await stored(page, TEST);
    check.copiedOnFirstEntry = copied?.provider === "openai-compatible" && copied?.apiKey === "mock-key" && copied?.models?.chat === "mock-model";
    check.testNoWizardAfterCopy = (await page.locator(".wizard").count()) === 0;
    check.testChatEmpty = (await page.locator(".msg.user", { hasText: "正常模式的第一句話" }).count()) === 0;

    step = "A 測試模式改設定";
    await (await chatModel(page)).fill("mock-model-test");
    await page.locator("#side-panel").getByRole("button", { name: "儲存設定" }).click();
    await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
    check.testSettingSaved = (await stored(page, TEST))?.models?.chat === "mock-model-test";
    check.normalUntouchedByTestEdit = (await raw(page, NORMAL)) === normalBefore;

    step = "A 產生假資料";
    await E2E.settings(page, "測試模式");
    const card = testCard(page);
    await card.getByRole("button", { name: /產生/ }).click();
    await card.getByText(/已產生 \d+ 筆/).waitFor({ timeout: 20000 });
    await E2E.go(page, "對話");
    await send(page, "測試模式的一句話");
    check.testChatSaved = (await page.locator(".msg.user", { hasText: "測試模式的一句話" }).count()) === 1;
    designOk.push(["card", await (async () => {
      await E2E.settings(page, "測試模式");
      await card.getByRole("button", { name: "整個重置" }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${OUT}/test-reset-1-card-390-light.png` });
      return design(page);
    })()]);
    check.cardButtons =
      (await card.getByRole("button", { name: "清空資料" }).isVisible()) &&
      (await card.getByRole("button", { name: "整個重置" }).isVisible()) &&
      (await card.getByRole("button", { name: "帶入正常設定" }).isVisible()) &&
      (await card.getByRole("button", { name: "清空資料" }).getAttribute("class")).includes("danger");

    step = "A 清空資料";
    page.dialogs.length = 0;
    await clickAndReload(page, card.getByRole("button", { name: "清空資料" }));
    await page.locator(".tabbar").waitFor();
    check.clearConfirmed = page.dialogs.some((m) => m.includes("設定保留"));
    check.clearKeepsSettings = (await stored(page, TEST))?.models?.chat === "mock-model-test";
    check.clearStaysInTestMode = await page.locator(".test-banner").isVisible();
    await E2E.go(page, "對話");
    await page.getByLabel("訊息").waitFor();
    check.clearRemovedData = (await page.locator(".msg.user", { hasText: "測試模式的一句話" }).count()) === 0;
    await E2E.settings(page, "測試模式");
    check.clearRemovedFakeSpec = await testCard(page).getByText("還沒產生假資料").isVisible();
    check.clearNormalUntouched = (await raw(page, NORMAL)) === normalBefore;

    step = "A 整個重置";
    page.dialogs.length = 0;
    await clickAndReload(page, testCard(page).getByRole("button", { name: "整個重置" }));
    await page.locator(".wizard-page[data-step=welcome]").waitFor({ timeout: 20000 });
    check.resetConfirmed = page.dialogs.some((m) => m.includes("第一次打開") && m.includes("正常模式的資料與設定不受影響"));
    check.resetShowsWizard = true;
    const wizardBanner = page.locator(".wizard .test-banner");
    check.wizardHasTestBanner = (await wizardBanner.isVisible()) && (await wizardBanner.getByRole("button", { name: "離開測試模式" }).isVisible());
    check.resetClearedTestSettings = (await raw(page, TEST)) === null;
    check.resetNormalUntouched = (await raw(page, NORMAL)) === normalBefore;
    designOk.push(["wizard-test", await design(page)]);
    await page.screenshot({ path: `${OUT}/test-reset-2-wizard-390-light.png`, fullPage: true });

    step = "A 走完精靈";
    await walkWizard(page);
    check.afterWizardTestBanner = await page.locator(".test-banner").isVisible();
    check.afterWizardGettingStarted = (await page.locator(".getting-started").count()) > 0;
    const afterWizard = await stored(page, TEST);
    check.wizardWroteTestSettings = afterWizard?.provider === "anthropic" && afterWizard?.terms?.version >= 1;
    check.wizardNormalUntouched = (await raw(page, NORMAL)) === normalBefore;
    await page.screenshot({ path: `${OUT}/test-reset-3-after-wizard-390-light.png`, fullPage: true });
    await page.reload();
    await page.locator(".tabbar").waitFor();
    check.wizardDoneInTest = (await page.locator(".wizard").count()) === 0;

    step = "A 帶入正常設定";
    await E2E.settings(page, "測試模式");
    page.dialogs.length = 0;
    await clickAndReload(page, testCard(page).getByRole("button", { name: "帶入正常設定" }));
    await page.locator(".tabbar").waitFor();
    const imported = await stored(page, TEST);
    check.importNormal = imported?.provider === "openai-compatible" && imported?.models?.chat === "mock-model" && page.dialogs.some((m) => m.includes("取代測試模式的設定"));
    check.importStaysInTest = await page.locator(".test-banner").isVisible();

    step = "A 精靈上離開測試模式";
    await E2E.settings(page, "測試模式");
    await clickAndReload(page, testCard(page).getByRole("button", { name: "整個重置" }));
    await page.locator(".wizard-page[data-step=welcome]").waitFor({ timeout: 20000 });
    await clickAndReload(page, page.locator(".wizard .test-banner").getByRole("button", { name: "離開測試模式" }));
    await page.locator(".tabbar").waitFor();
    check.leftToNormal = (await page.locator(".test-banner").count()) === 0 && (await page.locator(".wizard").count()) === 0;
    check.normalChatKept = (await page.locator(".msg.user", { hasText: "正常模式的第一句話" }).count()) === 1;
    check.normalSettingsKept = (await raw(page, NORMAL)) === normalBefore;
    check.normalSettingsShown = (await (await chatModel(page)).inputValue()) === "mock-model";
    await page.screenshot({ path: `${OUT}/test-reset-4-back-normal-390-light.png`, fullPage: true });
    await page.context().close();

    // ---------- B. 電腦深色：密碼鎖 ----------
    step = "B 正常模式與密碼鎖";
    page = await newPage(browser, problems, { width: 1280, height: 860, scheme: "dark" });
    await page.locator(".tabbar").waitFor();
    await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false });
    await E2E.settings(page, "密碼鎖");
    const lockCard = page.locator('#side-panel .subpage[data-section="lock"] section.card');
    await lockCard.getByLabel("密碼", { exact: true }).fill("correct horse");
    await lockCard.getByLabel("再輸入一次", { exact: true }).fill("correct horse");
    await lockCard.getByRole("button", { name: "啟用密碼鎖" }).click();
    await lockCard.getByRole("button", { name: "停用密碼鎖" }).waitFor({ timeout: 30000 });
    const normalLock = await raw(page, "running-coach.lock.v1");

    step = "B 啟用測試模式（要密碼）";
    await enableTestMode(page);
    await page.getByRole("button", { name: "解鎖" }).waitFor();
    check.lockCopiedAsCiphertext = (await raw(page, "running-coach.test.lock.v1")) === normalLock && !normalLock.includes("mock-key") && (await stored(page, TEST))?.apiKey === "";
    await page.screenshot({ path: `${OUT}/test-reset-5-unlock-1280-dark.png`, fullPage: true });
    await page.getByLabel("密碼").fill("correct horse");
    await page.getByRole("button", { name: "解鎖" }).click();
    await page.locator(".tabbar").waitFor({ timeout: 30000 });
    check.testUnlockedHasKey = (await page.locator(".test-banner").isVisible()) && !(await page.getByText("尚未填寫 API key").count());
    await E2E.settings(page, "AI 教練");
    check.testKeyAvailable = (await page.locator("#side-panel").getByLabel("API key", { exact: true }).inputValue()) === "mock-key";

    step = "B 整個重置";
    await E2E.settings(page, "測試模式");
    await page.screenshot({ path: `${OUT}/test-reset-6-card-1280-dark.png`, fullPage: true });
    designOk.push(["card-1280", await design(page)]);
    await clickAndReload(page, testCard(page).getByRole("button", { name: "整個重置" }));
    await page.locator(".wizard-page[data-step=welcome]").waitFor({ timeout: 20000 });
    check.resetNoLockInTest = (await raw(page, "running-coach.test.lock.v1")) === null && (await page.getByRole("button", { name: "解鎖" }).count()) === 0;
    check.resetKeepsNormalLock = (await raw(page, "running-coach.lock.v1")) === normalLock;
    designOk.push(["wizard-1280", await design(page)]);
    await page.screenshot({ path: `${OUT}/test-reset-7-wizard-1280-dark.png`, fullPage: true });

    step = "B 精靈上打開測試設定、停用";
    await page.locator(".wizard .test-banner").getByRole("button", { name: "測試設定" }).click();
    await testCard(page).waitFor();
    check.settingsOverWizard = await testCard(page).getByRole("button", { name: "停用測試模式" }).isVisible();
    await clickAndReload(page, testCard(page).getByRole("button", { name: "停用測試模式" }));
    await page.getByRole("button", { name: "解鎖" }).waitFor();
    await page.getByLabel("密碼").fill("correct horse");
    await page.getByRole("button", { name: "解鎖" }).click();
    await page.locator(".tabbar").waitFor({ timeout: 30000 });
    await E2E.settings(page, "AI 教練");
    check.normalKeyAfterLeaving = (await page.locator("#side-panel").getByLabel("API key", { exact: true }).inputValue()) === "mock-key";
    check.normalNoTestBanner = (await page.locator(".test-banner").count()) === 0;
    await page.context().close();
  } catch (e) {
    problems.push(`例外（${step}）：${e instanceof Error ? e.stack : String(e)}`);
  } finally {
    await browser.close();
    server.kill();
  }

  for (const [name, ok] of designOk) check[`design-${name}`] = ok;
  let ok = problems.length === 0;
  for (const [k, v] of Object.entries(check)) {
    console.log(`${v ? "ok  " : "FAIL"} ${k}`);
    if (!v) ok = false;
  }
  for (const p of problems) console.log(p);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
