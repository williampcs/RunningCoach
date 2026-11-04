// 驗證 staging 試用的修正（2026-11-04，規格 12.38）：
// 手機淺色（Claude 直連，指向模擬上游）：
// - 沒有課表時：計畫頁沒有「手動填寫」，主要按鈕「請教練排這週的課表」帶到對話、送出「幫我排這週的課表」，課表出現
// - 工具呼叫前的文字（模型先寫一句英文、參數寫 2.5 秒）：很快就變成等待中那一行的小字，不像正式回覆一直顯示；最後的回覆沒有那句
// - 不舒服的三種結果：在選部位那一步「先不用」（照改過的上＋記下部位和分數的提示）、3 分以下（照改過的上）、超過 3 分（先不要做，課卡也標）
// - 測試模式塞進過去 6 週的課表：「之前的週」6 週、各種結果（達成、部分達成、跳過、改用替代、沒做、自己改過）、教練的系統提示有最近 4 週的摘要；
//   清掉後沒有；停用測試模式後真的資料庫的計畫頁沒有「之前的週」
// 電腦深色（OpenAI 相容）：工具呼叫前的文字；舊的文字課表（從其他 AI 帶入）唯讀、「請教練改成可以追蹤的課表」
// 截圖：staging-fixes-*；不左右捲動
// 這個腳本自己建置一份（4182 埠：testmode、Anthropic 指向模擬上游，Claude 的串流才是真的逐段到）；只需要 npm run dev:mock。
const { execFileSync, spawn } = require("node:child_process");
const path = require("node:path");
const E2E = require("./env.cjs");
const { chromium } = E2E;

const WEB = path.join(__dirname, "../../apps/web");
const PORT = 4182;
const APP_URL = `http://localhost:${PORT}/`;

function build() {
  const outDir = path.join(E2E.OUT, "dist-staging-fixes");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_ANTHROPIC_BASE_URL: E2E.MOCK,
      VITE_FEATURES: "testmode",
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

let step = "start";
const PRE_TOOL = "Let me remove the session first.";

(async () => {
  const server = await serve(build());
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const open = async (name, mobile) => {
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      colorScheme: mobile ? "light" : "dark",
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${name} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${name} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    return { page, context };
  };
  const waitReply = (page, sent) =>
    page.waitForFunction(
      (text) => {
        const msgs = [...document.querySelectorAll(".msg")];
        const user = [...document.querySelectorAll(".msg.user .bubble.user")].at(-1);
        return !document.querySelector(".bubble.assistant.muted, .bubble.assistant.streaming") && msgs.at(-1)?.classList.contains("assistant") && user?.textContent.includes(text);
      },
      sent,
      { timeout: 30000 },
    );
  const send = async (page, text) => {
    await E2E.go(page, "對話");
    await page.getByLabel("訊息").fill(text);
    await page.getByLabel("訊息").press("Enter");
    await waitReply(page, text);
  };
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  /** 送出後每 100 ms 看一次：那句英文顯示成回覆（串流的泡泡）多久、有沒有變成等待中的小字 */
  async function preToolText(page, c) {
    await E2E.go(page, "對話");
    await page.getByLabel("訊息").fill("先看一下課表再說");
    await page.getByLabel("訊息").press("Enter");
    const sample = (n) =>
      page.evaluate(
        async ({ text, n }) => {
          const out = [];
          for (let i = 0; i < n; i++) {
            const streaming = document.querySelector(".bubble.assistant.streaming");
            const aside = document.querySelector(".bubble.assistant.muted .chat-aside");
            out.push({ asReply: !!streaming && streaming.textContent.includes(text), aside: !!aside && aside.textContent.includes(text) });
            await new Promise((r) => setTimeout(r, 100));
          }
          return out;
        },
        { text: PRE_TOOL, n },
      );
    const samples = await sample(18);
    // 參數還在寫的時候（等待中的那一行小字）
    await page.screenshot({ path: `${E2E.OUT}/staging-fixes-pretool-${c.size}.png` });
    samples.push(...(await sample(25)));
    const firstAside = samples.findIndex((s) => s.aside);
    c("preToolAside", firstAside >= 0 && samples.filter((s) => s.aside).length >= 10);
    // 顯示成回覆的時間只有那句還在打字的時候（不到 0.8 秒），之後不再出現
    c("preToolNotReply", samples.filter((s) => s.asReply).length <= 8 && samples.slice(firstAside).every((s) => !s.asReply));
    await waitReply(page, "先看一下課表再說");
    const last = await page.locator(".msg.assistant .bubble.assistant").last().innerText();
    c("preToolNotInReply", !last.includes(PRE_TOOL));
  }

  // ---------------------------------------------------------------------------
  // 手機淺色：Claude
  // ---------------------------------------------------------------------------
  {
    const { page, context } = await open("mobile", true);
    const c = (name, value) => (check[`mobile.${name}`] = value);
    c.size = "390-light";
    try {
      step = "設定（Claude）";
      await page.goto(APP_URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.settings(page, "AI 教練");
      const panel = page.locator("#side-panel");
      await panel.getByLabel("供應商").selectOption("anthropic");
      await panel.getByLabel("API key", { exact: true }).fill("mock-key");
      await panel.getByLabel("我了解並同意以上的資料流向").check();
      await panel.getByLabel("我已閱讀使用須知").check();
      await panel.getByRole("button", { name: "儲存設定" }).click();
      await page.getByText("設定已儲存在這個瀏覽器。").waitFor();

      step = "沒有課表：請教練排";
      await E2E.go(page, "計畫");
      const plan = page.locator("section.plan-card");
      await plan.getByRole("button", { name: "請教練排這週的課表" }).waitFor();
      c("noManual", (await page.getByRole("button", { name: /手動填寫|編輯/ }).count()) === 0 && (await plan.locator("textarea").count()) === 0);
      c("askPrimary", (await plan.getByRole("button", { name: "請教練排這週的課表" }).getAttribute("class")).includes("primary"));
      c("noOverflowEmpty", await noOverflow(page));
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-empty-390-light.png` });
      await plan.getByRole("button", { name: "請教練排這週的課表" }).click();
      await page.getByLabel("訊息").waitFor();
      // 和其他「請教練…」的按鈕一樣直接送出
      await waitReply(page, "幫我排這週的課表");
      c("sentAsk", (await page.locator(".msg.user .bubble.user").last().innerText()).includes("幫我排這週的課表"));
      await E2E.go(page, "計畫");
      c("planShown", await page.locator(".plan-card .timeline").waitFor({ timeout: 10000 }).then(() => true, () => false));

      step = "工具呼叫前的文字（Claude）";
      await preToolText(page, c);

      step = "不舒服：在部位那一步先不用";
      await E2E.go(page, "計畫");
      const longRun = page.locator(".plan-session", { has: page.locator(".plan-session-name", { hasText: /^長跑$/ }) }).last();
      const expand = async () => {
        const head = longRun.locator(".plan-session-head");
        if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
      };
      await expand();
      await longRun.getByRole("button", { name: "改課" }).click();
      await longRun.getByRole("button", { name: "短一點（約 3/4）" }).click();
      await longRun.locator(".badge", { hasText: "自己改過" }).waitFor();
      await expand();
      const reasons = longRun.getByRole("group", { name: "為什麼改" });
      await reasons.getByRole("button", { name: "不舒服" }).click();
      const unwell = longRun.locator(".unwell-panel");
      await unwell.getByRole("button", { name: "先不用" }).click();
      await unwell.locator(".unwell-outcome").waitFor();
      c("skipOutcome", (await unwell.locator(".unwell-outcome").innerText()) === "這堂課：照改過的上");
      c("skipHint", (await unwell.innerText()).includes("記下部位和分數，教練才能幫你避開會痛的課"));
      c("skipTell", (await unwell.getByRole("button", { name: "跟教練說" }).count()) === 1);
      c("skipReasonKept", (await reasons.locator('button[aria-pressed="true"]').innerText()) === "不舒服");
      await longRun.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-unwell-skip-390-light.png` });

      step = "不舒服：3 分以下";
      await unwell.getByRole("button", { name: "記下部位" }).click();
      await unwell.getByRole("button", { name: "記下部位" }).click();
      await unwell.getByLabel("部位").fill("小腿");
      await unwell.getByRole("button", { name: "新增" }).click();
      await unwell.getByRole("button", { name: "小腿的疼痛 2" }).click();
      await unwell.getByText(/已記下小腿 2\/10/).waitFor();
      c("lowOutcome", (await unwell.locator(".unwell-outcome").innerText()) === "這堂課：照改過的上");
      // 新增部位、還沒給分數的那一下是「先不要做」（不知道現在幾分），給了 2 分之後回到「自己改過」
      c("lowNoHold", await longRun.locator(".badge", { hasText: "自己改過" }).waitFor({ timeout: 5000 }).then(async () => (await longRun.locator(".badge", { hasText: "先不要做" }).count()) === 0, () => false));
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-unwell-low-390-light.png` });

      step = "不舒服：超過 3 分";
      await reasons.getByRole("button", { name: "不舒服" }).click();
      await page.waitForFunction(() => ![...document.querySelectorAll('[aria-label="為什麼改"] button[aria-pressed="true"]')].length, null, { timeout: 5000 });
      await reasons.getByRole("button", { name: "不舒服" }).click();
      await unwell.getByRole("button", { name: "小腿" }).click();
      await unwell.getByRole("button", { name: "小腿的疼痛 5" }).click();
      await unwell.getByText(/已記下小腿 5\/10/).waitFor();
      c("highOutcome", (await unwell.locator(".unwell-outcome").innerText()) === "這堂課：先不要做");
      c("highHint", (await unwell.innerText()).includes("請教練換成不會痛的運動或休息"));
      c("highBadge", await longRun.locator(".badge", { hasText: "先不要做" }).waitFor({ timeout: 5000 }).then(() => true, () => false));
      c("noOverflowUnwell", await noOverflow(page));
      await longRun.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-unwell-high-390-light.png` });

      step = "測試模式：產生與同步";
      await E2E.settings(page, "測試模式");
      await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "啟用測試模式" }).click()]);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.settings(page, "測試模式");
      const tm = page.locator("#side-panel");
      await tm.getByLabel("週數").fill("10");
      await tm.getByLabel("每週次數").fill("4");
      await tm.getByRole("button", { name: /產生/ }).click();
      await tm.getByText(/已產生 \d+ 筆/).waitFor({ timeout: 20000 });
      await tm.getByRole("button", { name: "同步最近 14 天" }).click();
      await page.locator(".toast, .notice", { hasText: /同步完成|已是最新|新增/ }).first().waitFor({ timeout: 60000 });

      step = "測試模式：塞進過去 6 週";
      await tm.getByLabel("塞進幾週").selectOption("6");
      await tm.getByRole("button", { name: "塞進過去的課表" }).click();
      await tm.getByText(/已塞進過去 6 週的課表/).waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-testmode-390-light.png` });
      await E2E.go(page, "計畫");
      const past = page.locator(".past-weeks-card");
      await past.waitFor({ timeout: 10000 });
      await past.locator("details.past-weeks > summary").click();
      const rows = past.locator(".past-week");
      await rows.first().waitFor();
      c("sixWeeks", (await rows.count()) === 6);
      const marks = new Set((await past.locator(".past-mark").evaluateAll((els) => els.map((e) => e.getAttribute("class")))).flatMap((cls) => cls.split(/\s+/)));
      for (const o of ["achieved", "partial", "skipped", "fallback", "missed"]) c(`mark_${o}`, marks.has(o));
      // 自己改課的週：點開看得到「自己改短到…」「自己換成輕鬆」
      for (let i = 0; i < 6; i++) await rows.nth(i).locator(".past-week-row").click();
      const subs = (await past.locator(".past-sessions .list-row-sub").allInnerTexts()).join("\n");
      c("selfShorten", subs.includes("自己改短到"));
      c("selfEasy", subs.includes("自己換成輕鬆"));
      c("noOverflowPast", await noOverflow(page));
      await past.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-past-390-light.png` });

      step = "教練看得到最近 4 週";
      await send(page, "最近練得怎樣");
      const requests = (await (await fetch(`${E2E.MOCK}/_mock/requests`)).json()).filter((r) => r.kind === "llm");
      const body = requests.at(-1).body ?? requests.at(-1);
      const system = typeof body.system === "string" ? body.system : JSON.stringify(body.system ?? "");
      c("summaryInPrompt", system.includes("【最近 4 週照課表的情形】") && system.includes("選手自己在課表頁"));
      c("preToolRule", system.includes("呼叫工具之前不要先寫給選手看的文字"));

      step = "清掉塞進的課表";
      await E2E.settings(page, "測試模式");
      await tm.getByRole("button", { name: "清掉塞進的課表" }).click();
      await tm.getByText("已清掉塞進的 6 週課表。").waitFor();
      await E2E.go(page, "計畫");
      await page.locator("section#races").waitFor();
      c("clearedHidden", (await page.locator(".past-weeks-card").count()) === 0);

      step = "停用測試模式：真的資料庫沒有";
      await E2E.settings(page, "測試模式");
      await tm.getByLabel("塞進幾週").selectOption("4");
      await tm.getByRole("button", { name: "塞進過去的課表" }).click();
      await tm.getByText(/已塞進過去 4 週的課表/).waitFor({ timeout: 10000 });
      await Promise.all([page.waitForEvent("load"), tm.getByRole("button", { name: "停用測試模式" }).click()]);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.go(page, "計畫");
      await page.locator(".plan-card .timeline").waitFor({ timeout: 10000 });
      c("realNoPast", (await page.locator(".past-weeks-card").count()) === 0);
    } catch (e) {
      problems.push(`[mobile ${step}] ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-fail-390-light.png` }).catch(() => {});
    }
    await context.close();
  }

  // ---------------------------------------------------------------------------
  // 電腦深色：OpenAI 相容
  // ---------------------------------------------------------------------------
  {
    const { page, context } = await open("desktop", false);
    const c = (name, value) => (check[`desktop.${name}`] = value);
    c.size = "1280-dark";
    try {
      step = "設定（OpenAI 相容）";
      await page.goto(APP_URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK, intervals: false, timeZone: "Asia/Taipei" });

      step = "工具呼叫前的文字（OpenAI 相容）";
      await preToolText(page, c);

      step = "舊的文字課表：唯讀";
      await E2E.go(page, "計畫");
      const races = page.locator("section#races");
      await races.getByRole("button", { name: "從其他 AI 帶入" }).click();
      await races.getByLabel("整理好的內容").fill("我的目標是全馬破四，週二間歇、週四節奏跑、週日長跑");
      await races.getByRole("button", { name: "整理" }).click();
      await races.getByText("確認要帶入的資料").waitFor({ timeout: 30000 });
      await races.getByRole("button", { name: /帶入選取的/ }).click();
      const plan = page.locator("section.plan-card");
      await plan.getByText("間歇 6×800m").waitFor({ timeout: 10000 });
      c("textReadOnly", (await plan.getByRole("button", { name: /編輯|手動填寫|儲存為本週計畫/ }).count()) === 0 && (await plan.locator("textarea").count()) === 0);
      c("textNote", (await plan.innerText()).includes("不會對照你的紀錄"));
      c("noOverflowText", await noOverflow(page));
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-text-1280-dark.png` });
      await plan.getByRole("button", { name: "請教練改成可以追蹤的課表" }).click();
      await waitReply(page, "可以追蹤的課表");
      c("convertSent", true);
    } catch (e) {
      problems.push(`[desktop ${step}] ${e.message.split("\n")[0]}`);
      await page.screenshot({ path: `${E2E.OUT}/staging-fixes-fail-1280-dark.png` }).catch(() => {});
    }
    await context.close();
  }

  await browser.close();
  server.kill();
  for (const [k, v] of Object.entries(check)) if (typeof v === "boolean") console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).filter((v) => typeof v === "boolean").every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
})();
