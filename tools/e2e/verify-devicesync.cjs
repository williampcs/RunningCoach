// 驗證多裝置同步（規格 12.10）：A 開始同步並記下復原碼；B 用配對碼加入、C 用連結（掃 QR code）加入、D 用復原碼還原；
// 課表、對話、選手資料、跑步的體感與分析帶到另一台；之後的修改也會過去；停止與刪除雲端資料；
// 顯示復原碼與新增裝置前再確認身分、離開畫面就收起（12.26）
const E2E = require("./env.cjs");
const { chromium } = E2E;
const URL = E2E.URL;
const SYNC = `${E2E.MOCK}/sync`;
const nodeCrypto = require("crypto");
// 和 packages/core/src/device-sync/pairing.ts 的 pairFingerprint 相同
const fingerprintOf = async (slot) => {
  const s = await (await fetch(`${SYNC}/v1/pair/${slot}`)).json();
  return nodeCrypto.createHash("sha256").update(`pair-fingerprint.${s.newPub}.${s.commitment}`).digest().subarray(0, 16).toString("base64url");
};
let step = "start";

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const device = async (name, mobile) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => {
      // 刪除雲端的資料後，另一台同步時伺服器回 404：預期中的，瀏覽器會自己記一筆
      if (step.startsWith("停止與刪除") && m.text().includes("404")) return;
      if (m.type() === "error" || m.text().includes("Content Security Policy")) problems.push(`[${name} ${step}] ${m.text()}`);
    });
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const tab = (label) => E2E.go(page, label);
    const card = page.locator("section.card", { has: page.getByRole("heading", { name: "多裝置同步" }) });
    return { page, tab, card, context };
  };
  const setup = async (d, withLlm = true) => {
    await d.page.goto(URL);
    await d.page.locator("nav.tabbar button").first().waitFor();
    await d.tab("設定");
    if (withLlm) {
      await d.page.getByLabel("供應商").selectOption("openai-compatible");
      await d.page.getByLabel("API key", { exact: true }).first().fill("mock-key");
      await d.page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
      await d.page.getByLabel("主對話模型").fill("mock-model");
    }
    await d.page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
    await d.page.getByLabel("我了解並同意以上的資料流向").check();
    await d.page.getByRole("button", { name: "儲存設定" }).click();
    await d.page.getByText("設定已儲存在這個瀏覽器。").waitFor();
  };
  // 模擬切到別的分頁、App 到背景（headless 的分頁不會自己變成 hidden）
  const background = (page) =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      delete document.visibilityState;
      document.dispatchEvent(new Event("visibilitychange"));
    });
  const field = (page, label, tag) => page.locator("label", { hasText: new RegExp(`^${label}`) }).locator(tag);

  try {
    // --- A：建立資料 ---
    step = "A 建立資料";
    const A = await device("A", false);
    await setup(A);
    await A.tab("跑後回報");
    await A.page.getByRole("button", { name: /同步/ }).last().click();
    await A.page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });
    await A.page.locator("fieldset.choices .choice").first().click();
    await A.page.locator('input[type="range"]').fill("7");
    await A.page.getByPlaceholder("例如：腿有點重").fill("A 寫的：後段有點喘");
    await A.page.getByRole("button", { name: /^存到/ }).click();
    await A.page.locator(".report-result .run-card").waitFor({ timeout: 30000 });
    await A.tab("選手資料");
    await A.page.locator("section.training-values").waitFor({ timeout: 10000 });
    await A.page.waitForTimeout(300);
    await field(A.page, "強度", "select").selectOption("challenge");
    await A.page.getByRole("button", { name: "儲存選手資料" }).click();
    await A.page.locator(".notice.ok", { hasText: "已儲存" }).waitFor();
    await A.tab("對話");
    await A.page.getByPlaceholder("輸入訊息…").fill("幫我排下週的課表");
    await A.page.getByRole("button", { name: "送出" }).click();
    await A.page.locator('.msg.user:has-text("幫我排下週的課表") ~ .msg.assistant .bubble.assistant').first().waitFor({ timeout: 30000 });

    step = "A 開始同步";
    await A.tab("設定");
    await A.card.getByRole("button", { name: "這是第一台：開始同步" }).click();
    const recovery = (await A.card.locator(".recovery-code").innerText()).trim();
    check.recoveryShown = /^([0-9A-HJKMNP-TV-Z]{4}-){13}[0-9A-HJKMNP-TV-Z]$/.test(recovery);
    check.mustConfirmSaved = await A.card.getByRole("button", { name: "開始同步" }).isDisabled();
    await A.card.getByLabel("我已經把復原碼存好了").check();
    await A.card.getByRole("button", { name: "開始同步" }).click();
    await A.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    check.aSent = /送出 \d{2,}/.test(await A.card.innerText());
    await A.page.screenshot({ path: `${E2E.OUT}/devsync-A-on.png` });

    // --- B：用配對碼加入（手機） ---
    step = "B 用配對碼加入";
    const B = await device("B", true);
    await setup(B, false);
    await B.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    await B.card.locator(".pair-code").waitFor({ timeout: 10000 });
    check.qrShown = (await B.card.locator("img.pair-qr").count()) === 1;
    const code = (await B.card.locator(".pair-code").innerText()).trim();
    await B.page.screenshot({ path: `${E2E.OUT}/devsync-B-join.png` });
    await A.card.getByRole("button", { name: "新增裝置" }).click();
    // 沒有密碼鎖：先警告、建議開密碼鎖，按「我了解，繼續」才出現配對碼的欄位
    check.addWarnsWithoutLock = await A.card.getByText(/沒有設定密碼鎖，拿到這台的人都能把同步加到他的裝置/).isVisible();
    check.addNotStartedBeforeConfirm = (await A.card.getByLabel("新裝置上顯示的配對碼").count()) === 0;
    await A.card.screenshot({ path: `${E2E.OUT}/devsync-A-add-confirm.png` });
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByLabel("新裝置上顯示的配對碼").fill(code.toLowerCase());
    await A.card.getByRole("button", { name: "下一步" }).click();
    const bNumbers = (await B.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    check.numbersShape = /^\d{3} \d{3}$/.test(bNumbers);
    check.aDoesNotShowNumbers = (await A.card.locator(".pair-confirm").count()) === 0;
    check.bWaitsForSend = await B.card.getByRole("button", { name: /等另一台輸入數字/ }).isDisabled();
    // 打錯數字：不送出
    const digitsField = A.card.getByLabel("新裝置上顯示的六位數字");
    await digitsField.fill(bNumbers === "000 000" ? "111111" : "000000");
    await A.card.getByRole("button", { name: "傳送" }).click();
    check.wrongDigitsRejected = await A.card.getByText(/數字不一樣/).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check.bStillWaiting = await B.card.getByRole("button", { name: /等另一台輸入數字/ }).isDisabled();
    await digitsField.fill(bNumbers);
    await A.card.getByRole("button", { name: "傳送" }).click();
    await A.card.getByText("已傳送").waitFor();
    await B.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await B.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    await B.page.screenshot({ path: `${E2E.OUT}/devsync-B-on.png` });
    await A.card.getByRole("button", { name: "完成" }).click();

    step = "B 的資料";
    await B.tab("計畫與賽事");
    check.bPlan = await B.page.locator(".plan-session", { hasText: "4×1 km 閾值" }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
    await B.tab("選手資料");
    await B.page.locator("section.training-values").waitFor({ timeout: 10000 });
    check.bProfile = await (async () => {
      for (let i = 0; i < 25; i++) {
        if ((await field(B.page, "強度", "select").inputValue()) === "challenge") return true;
        await B.page.waitForTimeout(200);
      }
      return false;
    })();
    await B.tab("對話");
    check.bChat = await B.page.locator(".bubble.user", { hasText: "幫我排下週的課表" }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    // B 從 Intervals.icu 同步：那趟跑步帶上 A 寫的體感與分析
    await B.tab("跑後回報");
    await B.page.getByRole("button", { name: /同步/ }).last().click();
    await B.page.locator(".notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });
    await B.tab("紀錄");
    const first = B.page.locator("ul.runs > li").first();
    await first.locator(".run-row").click();
    await first.locator(".run-card").waitFor();
    const runText = await first.innerText();
    check.bRunNotes = runText.includes("體感 7/10") && runText.includes("A 寫的：後段有點喘");

    step = "之後的修改";
    await B.tab("選手資料");
    await B.page.locator("section.training-values").waitFor();
    await field(B.page, "強度", "select").selectOption("easy");
    await B.page.getByRole("button", { name: "儲存選手資料" }).click();
    await B.page.locator(".notice.ok", { hasText: "已儲存" }).waitFor();
    await B.tab("設定");
    await B.page.waitForTimeout(1000);
    await B.card.getByRole("button", { name: "立即同步裝置" }).click({ timeout: 10000 });
    await B.page.waitForTimeout(1500);
    await A.tab("設定");
    await A.card.getByRole("button", { name: "立即同步裝置" }).click();
    await A.page.waitForTimeout(1500);
    await A.tab("選手資料");
    await A.page.locator("section.training-values").waitFor();
    check.editReachesA = await (async () => {
      for (let i = 0; i < 25; i++) {
        if ((await field(A.page, "強度", "select").inputValue()) === "easy") return true;
        await A.page.waitForTimeout(200);
      }
      return false;
    })();

    // --- C：用連結加入（模擬 A 用手機相機掃 C 的 QR code） ---
    step = "C 用連結加入";
    const C = await device("C", false);
    await setup(C, false);
    await C.card.getByRole("button", { name: "加入已經在同步的裝置" }).click();
    await C.card.locator(".pair-code").waitFor({ timeout: 10000 });
    const slot = (await C.card.locator(".pair-code").innerText()).replace("-", "").trim();
    const fingerprint = await fingerprintOf(slot);
    // 指紋不符（資料被換掉）：停止
    await A.page.goto(`${URL}#pair=${slot}.${"A".repeat(22)}`);
    // 從連結打開也要先確認身分
    await A.card.getByRole("button", { name: "我了解，繼續" }).click({ timeout: 15000 });
    await A.card.getByRole("button", { name: "是我的裝置，繼續" }).click({ timeout: 15000 });
    check.badFingerprintStops = await A.card.getByText(/和 QR code 不符/).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check.slotUntouchedAfterBadFp = (await (await fetch(`${SYNC}/v1/pair/${slot}`)).json()).oldPub === null;
    await A.card.getByRole("button", { name: "取消" }).click();
    // 正確的連結：先警告，不自動開始
    await A.page.goto(`${URL}#pair=${slot}.${fingerprint}`);
    await A.card.getByRole("button", { name: "我了解，繼續" }).waitFor({ timeout: 15000 });
    check.linkConfirmsFirst = (await A.card.getByRole("button", { name: "是我的裝置，繼續" }).count()) === 0;
    await A.card.getByRole("button", { name: "我了解，繼續" }).click();
    await A.card.getByRole("button", { name: "是我的裝置，繼續" }).waitFor({ timeout: 15000 });
    check.linkOpensAdd = (await A.page.evaluate(() => location.hash)) === "";
    check.linkWarns = await A.card.getByText(/別人傳給你的連結/).isVisible();
    check.linkNotAutoStarted = (await (await fetch(`${SYNC}/v1/pair/${slot}`)).json()).oldPub === null;
    await A.card.getByRole("button", { name: "是我的裝置，繼續" }).click();
    const cNumbers = (await C.card.locator(".pair-confirm").innerText({ timeout: 15000 })).trim();
    await A.card.getByLabel("新裝置上顯示的六位數字").fill(cNumbers.replace(" ", ""));
    await A.card.getByRole("button", { name: "傳送" }).click();
    await C.card.getByRole("button", { name: "另一台已傳送，加入" }).click({ timeout: 10000 });
    await C.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    await A.card.getByRole("button", { name: "完成" }).click();
    await C.tab("計畫與賽事");
    check.cPlan = await C.page.locator(".plan-session", { hasText: "4×1 km 閾值" }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);

    // --- A：顯示復原碼（沒有密碼鎖）：先警告；離開畫面就收起，下次要再確認 ---
    step = "A 顯示復原碼";
    await A.tab("設定");
    await A.card.getByRole("button", { name: "顯示復原碼" }).click();
    check.codeWarnsWithoutLock = await A.card.getByText(/沒有設定密碼鎖，拿到這台的人都能看到復原碼/).isVisible();
    check.codeHiddenBeforeConfirm = (await A.card.locator(".recovery-code").count()) === 0;
    await A.card.screenshot({ path: `${E2E.OUT}/devsync-A-code-confirm.png` });
    await A.card.getByRole("button", { name: "我了解，顯示" }).click();
    check.codeShownAfterConfirm = (await A.card.locator(".recovery-code").innerText({ timeout: 5000 })).trim() === recovery;
    const shownText = await A.card.innerText();
    check.codeExplains = shownText.includes("只在新裝置還原時需要") && shownText.includes("懷疑復原碼外流");
    await A.card.screenshot({ path: `${E2E.OUT}/devsync-A-code-shown.png` });
    await background(A.page);
    check.codeHidesInBackground = await A.card.locator(".recovery-code").waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
    await A.card.getByRole("button", { name: "顯示復原碼" }).click();
    check.codeAsksAgain = (await A.card.getByRole("button", { name: "我了解，顯示" }).count()) === 1 && (await A.card.locator(".recovery-code").count()) === 0;
    await A.card.getByRole("button", { name: "我了解，顯示" }).click();
    await A.card.locator(".recovery-code").waitFor();
    // 關閉設定面板再打開：收起
    await A.tab("對話");
    await A.tab("設定");
    check.codeHidesOnClose = (await A.card.locator(".recovery-code").count()) === 0 && (await A.card.getByRole("button", { name: "顯示復原碼" }).count()) === 1;

    // --- D：用復原碼還原；打錯的碼被拒絕 ---
    step = "D 用復原碼還原";
    const D = await device("D", true);
    await setup(D, false);
    await D.card.getByRole("button", { name: "用復原碼還原" }).click();
    // 最後一個字元是檢查碼的 4 個位元加 1 個補位：改它的資料位元（不是補位），金鑰不變、檢查碼一定不符
    const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    await D.card.getByLabel("復原碼").fill(recovery.slice(0, -1) + alphabet[alphabet.indexOf(recovery.slice(-1)) ^ 2]);
    await D.card.getByRole("button", { name: "還原" }).click();
    check.badCodeRejected = await D.card.locator(".notice.error", { hasText: "復原碼不對" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await D.card.getByLabel("復原碼").fill(recovery.toLowerCase().replace(/-/g, " "));
    await D.card.getByRole("button", { name: "還原" }).click();
    await D.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    await D.tab("對話");
    check.dChat = await D.page.locator(".bubble.user", { hasText: "幫我排下週的課表" }).waitFor({ timeout: 10000 }).then(() => true, () => false);

    // --- E：先用復原碼還原，再填 API key 存設定（使用者回報：存設定把同步關掉了） ---
    step = "E 先還原再存設定";
    const E = await device("E", true);
    await E.page.goto(URL);
    await E.page.locator("nav.tabbar button").first().waitFor();
    await E.tab("設定");
    await E.card.getByRole("button", { name: "用復原碼還原" }).click();
    await E.card.getByLabel("復原碼").fill(recovery);
    await E.card.getByRole("button", { name: "還原" }).click();
    await E.card.getByText(/上次同步：\d/).waitFor({ timeout: 15000 });
    await E.page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
    await E.page.getByLabel("我了解並同意以上的資料流向").check();
    await E.page.getByRole("button", { name: "儲存設定" }).click();
    await E.page.getByText("設定已儲存在這個瀏覽器。").waitFor();
    check.eStillSyncing = await E.card.getByText("已開啟").waitFor({ timeout: 5000 }).then(() => true, () => false);
    check.eKeyKept = await E.page.evaluate(() => (JSON.parse(localStorage.getItem("running-coach.settings.v1") || "{}").sync?.key ?? "") !== "");
    // E 改的資料傳到 A
    await E.tab("選手資料");
    await E.page.getByLabel("長期目標").fill("E 改的目標");
    // 別台同步過來、頁面重新讀取時，改到一半的欄位不能被蓋掉
    await E.page.waitForTimeout(6000);
    check.eEditKept = (await E.page.getByLabel("長期目標").inputValue()) === "E 改的目標";
    await E.page.getByRole("button", { name: "儲存選手資料" }).click();
    await E.tab("設定");
    await E.card.getByRole("button", { name: "立即同步裝置" }).click();
    await E.card.getByText(/送出 [1-9]/).waitFor({ timeout: 15000 }).catch(() => undefined);
    await A.tab("設定");
    await A.card.getByRole("button", { name: "立即同步裝置" }).click();
    await A.tab("選手資料");
    check.eChangeReachesA = await A.page.waitForFunction(() => [...document.querySelectorAll("input, textarea")].some((i) => i.value === "E 改的目標"), null, { timeout: 15000 }).then(() => true, () => false);

    // --- D 開了密碼鎖：顯示復原碼與新增裝置都要再輸入密碼，錯的不顯示 ---
    step = "D 密碼鎖";
    await D.tab("設定");
    const lockCard = D.page.locator("section.card", { has: D.page.getByRole("heading", { name: "保護 API key" }) });
    await lockCard.getByLabel("密碼", { exact: true }).fill("correct horse");
    await lockCard.getByLabel("再輸入一次", { exact: true }).fill("correct horse");
    await lockCard.getByRole("button", { name: "啟用密碼鎖" }).click();
    await lockCard.getByRole("button", { name: "停用密碼鎖" }).waitFor({ timeout: 20000 });
    await D.card.getByRole("button", { name: "顯示復原碼" }).click();
    const pw = D.card.getByLabel(/再輸入一次密碼鎖的密碼/);
    check.lockAsksPassword = await pw.isVisible();
    check.lockNoWarnButton = (await D.card.getByRole("button", { name: "我了解，顯示" }).count()) === 0;
    await pw.fill("wrong horse");
    await D.card.getByRole("button", { name: "確認" }).click();
    check.wrongPasswordRejected = await D.card.getByText("密碼不正確，不顯示復原碼。").waitFor({ timeout: 20000 }).then(() => true, () => false);
    check.wrongPasswordNoCode = (await D.card.locator(".recovery-code").count()) === 0;
    await D.card.screenshot({ path: `${E2E.OUT}/devsync-D-code-password.png` });
    await pw.fill("correct horse");
    await pw.press("Enter");
    check.rightPasswordShowsCode = (await D.card.locator(".recovery-code").innerText({ timeout: 20000 })).trim() === recovery;
    check.stillUnlocked = (await D.page.locator("nav.tabbar button").count()) > 0;
    await D.card.screenshot({ path: `${E2E.OUT}/devsync-D-code-shown.png` });
    await background(D.page);
    check.lockCodeHidesInBackground = await D.card.locator(".recovery-code").waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false);
    await D.card.getByRole("button", { name: "新增裝置" }).click();
    const addPw = D.card.getByLabel(/再輸入一次密碼鎖的密碼，才開始配對/);
    await D.page.emulateMedia({ colorScheme: "dark" });
    await D.card.screenshot({ path: `${E2E.OUT}/devsync-D-add-password-dark.png` });
    await D.page.emulateMedia({ colorScheme: "light" });
    check.addAsksPassword = (await addPw.isVisible()) && (await D.card.getByLabel("新裝置上顯示的配對碼").count()) === 0;
    await addPw.fill("wrong horse");
    await D.card.getByRole("button", { name: "確認" }).click();
    check.addWrongPasswordRejected = await D.card.getByText("密碼不正確，不能新增裝置。").waitFor({ timeout: 20000 }).then(() => true, () => false);
    await addPw.fill("correct horse");
    await D.card.getByRole("button", { name: "確認" }).click();
    check.addRightPasswordOpens = await D.card.getByLabel("新裝置上顯示的配對碼").waitFor({ timeout: 20000 }).then(() => true, () => false);
    await D.card.getByRole("button", { name: "取消" }).click();
    check.noOverflowConfirm = await D.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

    step = "停止與刪除";
    await D.tab("設定");
    await D.card.getByRole("button", { name: "停止這台的同步" }).click();
    check.stopHere = await D.card.getByRole("button", { name: "這是第一台：開始同步" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await A.tab("設定");
    await A.card.getByRole("button", { name: "刪除雲端的資料" }).click();
    check.deleteRemote = await A.card.locator(".notice.ok", { hasText: "雲端的同步資料已刪除" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    await B.card.getByRole("button", { name: "立即同步裝置" }).click();
    check.otherDeviceSeesGone = await B.card.locator(".notice.warn", { hasText: "雲端的同步資料已經在另一台刪除" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
    check.goneNoErrorNotice = (await B.card.locator(".notice.error").count()) === 0;

    // B 用這台重新開始：新的復原碼，B 的資料送上去
    step = "停止與刪除：B 重新開始";
    await B.card.getByRole("button", { name: "用這台重新開始同步" }).click();
    const newRecovery = (await B.card.locator(".recovery-code").innerText({ timeout: 10000 })).trim();
    check.newRecoveryCode = newRecovery !== recovery;
    await B.card.getByLabel("我已經把復原碼存好了").check();
    await B.card.getByRole("button", { name: "開始同步" }).click();
    check.bRestarted = await B.card.getByText(/送出 [1-9]/).waitFor({ timeout: 15000 }).then(() => true, () => false);
    // C 還是舊的金鑰：也看到已刪除，按停止
    await C.tab("設定");
    await C.card.getByRole("button", { name: "立即同步裝置" }).click();
    await C.card.getByRole("button", { name: "停止這台的同步" }).click({ timeout: 10000 });
    check.cStopped = await C.card.getByRole("button", { name: "這是第一台：開始同步" }).waitFor({ timeout: 5000 }).then(() => true, () => false);

    // 重置：清除這台、重新從雲端取回 → 資料回來；清除這台並停止同步 → 不再回來
    step = "停止與刪除：重置";
    await B.page.getByRole("button", { name: "清除這台，重新從雲端取回" }).click();
    await B.page.waitForLoadState("load");
    await B.page.locator("nav.tabbar button").first().waitFor();
    await B.tab("對話");
    check.refetchBringsBack = await B.page.locator(".bubble.user", { hasText: "幫我排下週的課表" }).waitFor({ timeout: 20000 }).then(() => true, () => false);
    await B.tab("設定");
    check.refetchKeepsSync = await B.card.getByText("已開啟").waitFor({ timeout: 5000 }).then(() => true, () => false);
    check.plainResetHidden = (await B.page.getByRole("button", { name: "清除資料，保留設定與 API key" }).count()) === 0;
    await B.page.getByRole("button", { name: "清除這台並停止同步" }).click();
    await B.page.waitForLoadState("load");
    await B.page.locator("nav.tabbar button").first().waitFor();
    await B.tab("設定");
    check.stopResetStopsSync = await B.card.getByRole("button", { name: "這是第一台：開始同步" }).waitFor({ timeout: 10000 }).then(() => true, () => false);
    await B.page.waitForTimeout(3000);
    await B.tab("對話");
    check.stopResetStaysEmpty = (await B.page.locator(".bubble.user", { hasText: "幫我排下週的課表" }).count()) === 0;

    check.noOverflow = await B.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
    check.completed = false;
  }
  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
