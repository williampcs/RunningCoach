// 驗證介面改版（規格 12.28、doc/design-guidelines.md 的檢查清單）：每一頁在手機與電腦、淺色與深色、功能開關開著與關著：
// - 畫面上沒有 emoji（教練的回覆、使用說明的內文這類內容不算）
// - 主要內容用到的字級不超過五種（數字、標題、小標、內文、輔助）
// - 每張卡（卡片、整張看板、課表的一堂課、提示）最多一顆主要（實心）按鈕
// - 分頁是線條圖示＋兩個字（對話、回報、紀錄、計畫、選手）
// - 只有圖示的按鈕（✕ ? 設定 › ⓘ）都有名稱；其他按鈕旁邊都有字
// - 看板的標題不帶括號裡的數字；按鈕至少 44 高（句子裡的連結、「細節」這類收起的按鈕、清單的一列除外）；不左右捲動
// 每一頁截圖（design-{開關}-{頁}-{寬}-{配色}.png，整頁捲動的內容也截進去）。
// 開關關著用一般的建置（E2E_URL，開著 testmode）；開著的自己建置一份 VITE_FEATURES=all（4178 埠）。只需要 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium } = E2E;

const WEB = path.join(__dirname, "../../apps/web");
const PORT = 4178;
const ALL_URL = `http://localhost:${PORT}/`;
const plusDays = (d) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date(Date.now() + d * 86_400_000));

const VIEWS = [
  { width: 390, height: 844, scheme: "light" },
  { width: 390, height: 844, scheme: "dark" },
  { width: 1280, height: 860, scheme: "light" },
  { width: 1280, height: 860, scheme: "dark" },
];
const TABS = ["對話", "回報", "紀錄", "計畫", "選手"];

let step = "start";

function build() {
  const outDir = path.join(E2E.OUT, "dist-design");
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_INTERVALS_BASE_URL: `${E2E.MOCK}/intervals`,
      VITE_SYNC_URL: `${E2E.MOCK}/sync`,
      VITE_WEATHER_BASE_URL: `${E2E.MOCK}/weather`,
      VITE_FEATURES: "all",
    },
  });
  return outDir;
}

async function serve(outDir) {
  const child = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--outDir", outDir], { cwd: WEB, stdio: "ignore" });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(ALL_URL)).ok) return child;
    } catch {
      // 還沒開好
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error(`vite preview 沒有在 ${PORT} 開起來`);
}

/** 在頁面裡跑的檢查：回傳每一項的結果與找到的問題 */
function inspect() {
  const visible = (el) => {
    if (!el.getClientRects().length) return false;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none") return false;
    if (el.closest(".sr-only, [aria-hidden='true']")) return false;
    // 被面板蓋住的（inert）不算
    if (el.closest("[inert]")) return false;
    // 收起的 details 裡的內容沒有畫出來（summary 除外）
    for (let d = el.closest("details"); d; d = d.parentElement?.closest("details")) {
      if (!d.open && !el.closest("summary")) return false;
    }
    return true;
  };
  // 內容（教練的回覆、使用說明的內文、跑後分析、匯入的課表、輸入框裡打的字）不算介面
  const CONTENT = ".bubble, .markdown, .summary-text, .run-summary, .import-plan, .recovery-code, .help-section, .quote";
  const out = { emoji: [], sizes: {}, primary: [], unnamed: [], small: [], feedTitles: [], clipped: [], tabs: null, overflow: false };

  // 1. emoji：看得到的文字（不含內容）
  const emoji = /\p{Extended_Pictographic}/u;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const el = node.parentElement;
    if (!el || !node.textContent.trim() || el.closest(CONTENT) || !visible(el)) continue;
    if (emoji.test(node.textContent)) out.emoji.push(node.textContent.trim().slice(0, 40));
    // 2. 字級：主要內容（分頁、面板、標題列、分頁列）
    if (el.closest("main.page, #side-panel, .topbar, nav.tabbar, .notices") && !el.closest(".bubble, .markdown, .msg-meta, .quote")) {
      const size = getComputedStyle(el).fontSize;
      (out.sizes[size] ??= []).push(node.textContent.trim().slice(0, 20));
    }
  }

  // 3. 每張卡最多一顆主要按鈕（算最裡面的那張）；看板整張算一張卡
  const CARDS = ".card, .feed, .plan-session, .notice";
  for (const card of document.querySelectorAll(CARDS)) {
    if (!visible(card)) continue;
    const primaries = [...card.querySelectorAll("button.primary")].filter((b) => visible(b) && b.closest(CARDS) === card);
    if (primaries.length > 1) out.primary.push(`${card.className.split(" ").slice(0, 2).join(".")}：${primaries.map((b) => b.innerText.trim()).join("、")}`);
  }

  // 4. 按鈕：只有圖示的要有名稱，而且是允許的種類；高度至少 44
  const ICON_ONLY = ["icon-button", "info-button"];
  for (const b of document.querySelectorAll("button, label.button")) {
    if (!visible(b)) continue;
    const text = b.innerText.replace(/\s+/g, "");
    if (!text) {
      const name = b.getAttribute("aria-label") ?? "";
      if (!name || !ICON_ONLY.some((c) => b.classList.contains(c))) out.unnamed.push(b.outerHTML.slice(0, 80));
    }
    const exempt = b.matches(".link, .disclosure-button, .info-button, .list-row, .run-row, .plan-session-head, .plan-race, .feed-summary, .quote, .choice, .help-toc button, .msg-actions button");
    const h = b.getBoundingClientRect().height;
    if (!exempt && h < 43.5) out.small.push(`${text || b.getAttribute("aria-label")}（${Math.round(h)}）`);
  }

  // 4b. 看板的標題不帶括號裡的數字（數字放標籤）
  // 課卡強度條下面的說明（暖身、主課、緩和）：不可以被截掉或出現省略號
  out.clipped = [...document.querySelectorAll(".strip-labels, .strip-labels > span")]
    .filter((el) => el.getClientRects().length && (el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === "ellipsis"))
    .map((el) => el.textContent);
  out.feedTitles = [...document.querySelectorAll(".feed-title")].map((t) => t.textContent).filter((t) => /（[^）]*\d/.test(t));

  // 5. 分頁：線條圖示＋兩個字
  out.tabs = [...document.querySelectorAll("nav.tabbar button")].map((b) => ({ text: b.innerText.trim(), svg: !!b.querySelector("svg") }));
  out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
  return out;
}

/**
 * 整頁的截圖：暫時讓分頁與面板跟著內容長高（不在框裡捲動）. CSP 不允許插入樣式表，
 * 改用 element.style（CSSOM，CSP 允許），截完還原
 */
async function fullShot(page, file) {
  await page.evaluate(() => {
    const rules = [
      ["html, body, #root, .shell", { height: "auto", "min-height": "100%" }],
      [".page:not(.chat-page), .side-panel-body", { overflow: "visible" }],
      [".side-panel", { position: "absolute", bottom: "auto", "min-height": "100%" }],
      [".toasts", { display: "none" }],
    ];
    window.__designSaved = [];
    for (const [selector, props] of rules)
      for (const el of document.querySelectorAll(selector)) {
        window.__designSaved.push([el, el.getAttribute("style")]);
        for (const [k, v] of Object.entries(props)) el.style.setProperty(k, v, "important");
      }
  });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
  await page.evaluate(() => {
    for (const [el, style] of window.__designSaved.reverse()) {
      el.removeAttribute("style");
      if (style) for (const part of style.split(";")) {
        const [k, ...v] = part.split(":");
        if (k?.trim() && v.length) el.style.setProperty(k.trim(), v.join(":").trim());
      }
    }
  });
}

async function prepare(page, url, all) {
  step = "設定";
  await page.goto(url);
  await page.locator("nav.tabbar button").first().waitFor();
  await E2E.setupMock(page, { mock: E2E.MOCK, timeZone: "Asia/Taipei" });
  await E2E.settings(page, "天氣");
  await page.locator("#weather").getByLabel("台灣的縣市").selectOption({ label: "台北市" });
  await page.locator("#weather").getByText("目前：台北市").waitFor();
  await page.locator("#side-panel .back-button").click();
  await page.locator("#side-panel").getByRole("button", { name: "同步最近 14 天" }).click();
  await page.locator(".toast", { hasText: /同步完成/ }).first().waitFor({ timeout: 30000 });

  step = "賽事";
  await E2E.go(page, "計畫");
  const races = page.locator("#races");
  for (const [name, date, km] of [
    ["城市半馬", plusDays(12), 21.0975],
    ["秋季全馬", plusDays(40), 42.195],
  ]) {
    await races.getByRole("button", { name: "新增賽事" }).click();
    await races.getByLabel("賽事名稱").fill(name);
    await races.getByLabel("日期").fill(date);
    await races.getByLabel("距離（km）").fill(String(km));
    await races.getByRole("button", { name: "新增", exact: true }).click();
    await races.getByText(name).first().waitFor();
  }

  step = "課表";
  await E2E.go(page, "對話");
  const say = async (text) => {
    await page.getByPlaceholder("輸入訊息…").fill(text);
    await page.getByRole("button", { name: "送出" }).click();
    await page.locator(`.msg.user:has-text("${text}") ~ .msg.assistant .bubble.assistant`).first().waitFor({ timeout: 30000 });
    await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
  };
  await say(all ? "幫我排跑步和騎車的課表" : "幫我排這週的課表");
}

/** 每一頁：打開、截圖、檢查 */
const PAGES = [
  {
    id: "chat",
    open: async (page) => {
      await E2E.go(page, "對話");
      if (await page.locator(".feed-summary").count()) await page.locator(".feed-summary").click();
      await page.locator(".feed-list").waitFor();
    },
  },
  { id: "report", open: (page) => E2E.go(page, "回報") },
  {
    id: "history",
    open: async (page) => {
      await E2E.go(page, "紀錄");
      const first = page.locator("ul.runs > li").first();
      await first.waitFor();
      if ((await first.locator(".run-row").getAttribute("aria-expanded")) !== "true") await first.locator(".run-row").click();
    },
  },
  { id: "plan", open: (page) => E2E.go(page, "計畫") },
  { id: "profile", open: (page) => E2E.profile(page) },
  // 選手頁的下一層（規格 12.30）
  ...["目標", "練什麼、怎麼練", "個人最佳", "身體", "教練記得的事"].map((name) => ({ id: `profile-${name}`, open: (page) => E2E.profile(page, name) })),
  {
    id: "profile-我的數字",
    open: async (page) => {
      await E2E.profile(page);
      await page.getByRole("button", { name: /^我的數字/ }).click();
      await page.locator(".profile-subpage .title", { hasText: "我的數字" }).waitFor();
    },
  },
  {
    id: "settings",
    open: async (page) => {
      await E2E.go(page, "設定");
      const back = page.locator("#side-panel .back-button");
      if (await back.count()) await back.click();
    },
  },
  ...["AI 教練", "訓練紀錄", "天氣", "多裝置同步", "密碼鎖", "資料", "測試模式", "重置", "系統狀態"].map((name) => ({ id: `settings-${name}`, open: (page) => E2E.settings(page, name) })),
  { id: "help", open: (page) => E2E.go(page, "使用說明") },
];

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
    for (const [flag, url] of [
      ["off", E2E.URL],
      ["on", ALL_URL],
    ]) {
      // 資料準備一次（手機的大小），之後換大小與配色檢查每一頁
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "Asia/Taipei" });
      const page = await context.newPage();
      page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${flag} ${step}] ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${flag} ${step}] pageerror: ${e.message}`));
      page.on("dialog", (d) => void d.accept());
      try {
        await prepare(page, url, flag === "on");
        for (const p of PAGES) {
          step = p.id;
          await p.open(page);
          await page.waitForTimeout(300);
          for (const v of VIEWS) {
            const tag = `${flag}.${p.id}.${v.width}-${v.scheme}`;
            await page.setViewportSize({ width: v.width, height: v.height });
            await page.emulateMedia({ colorScheme: v.scheme });
            await page.waitForTimeout(200);
            const r = await page.evaluate(inspect);
            const sizes = Object.keys(r.sizes);
            check[`${tag}.noEmoji`] = r.emoji.length === 0;
            check[`${tag}.fiveSizes`] = sizes.length <= 5;
            check[`${tag}.onePrimary`] = r.primary.length === 0;
            check[`${tag}.iconButtonsNamed`] = r.unnamed.length === 0;
            check[`${tag}.touchTargets`] = r.small.length === 0;
            check[`${tag}.tabs`] =
              r.tabs.map((t) => t.text).join(",") === TABS.join(",") && r.tabs.every((t) => t.svg);
            check[`${tag}.noOverflow`] = !r.overflow;
            check[`${tag}.feedTitlesNoNumbers`] = r.feedTitles.length === 0;
            check[`${tag}.stripLabelsNotClipped`] = r.clipped.length === 0;
            if (r.clipped.length) problems.push(`[${tag}] 強度條的說明被截掉：${r.clipped.join(" | ")}`);
            if (r.feedTitles.length) problems.push(`[${tag}] 看板的標題有括號裡的數字：${r.feedTitles.join(" | ")}`);
            if (r.emoji.length) problems.push(`[${tag}] emoji：${r.emoji.join(" | ")}`);
            if (sizes.length > 5) problems.push(`[${tag}] 字級 ${sizes.length} 種：${sizes.map((s) => `${s}（${r.sizes[s].slice(0, 2).join("、")}）`).join(" ")}`);
            if (r.primary.length) problems.push(`[${tag}] 主要按鈕不只一顆：${r.primary.join(" | ")}`);
            if (r.unnamed.length) problems.push(`[${tag}] 只有圖示的按鈕：${r.unnamed.join(" | ")}`);
            if (r.small.length) problems.push(`[${tag}] 按鈕不到 44 高：${r.small.join("、")}`);
            await fullShot(page, path.join(E2E.OUT, `design-${flag}-${p.id}-${v.width}-${v.scheme}.png`));
          }
          await page.setViewportSize({ width: 390, height: 844 });
        }
      } catch (e) {
        problems.push(`[${flag} ${step}] ${e.message.split("\n")[0]}`);
        await page.screenshot({ path: path.join(E2E.OUT, `design-${flag}-FAILED.png`) }).catch(() => undefined);
        check[`${flag}.completed`] = false;
      }
      await context.close();
    }
  } finally {
    await browser.close();
    server.kill();
  }
  const failed = Object.entries(check).filter(([, v]) => !v);
  console.log(`${Object.keys(check).length} 項檢查，${failed.length} 項沒過`);
  for (const [k] of failed) console.log(`FAIL ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  const ok = Object.keys(check).length > 0 && failed.length === 0 && problems.length === 0;
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
