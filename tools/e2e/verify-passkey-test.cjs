// 驗證 passkey（PRF）的測試頁（規格 12.44、9.4「帳號管理第 2 步」）：
// - staging 的建置：設定最下面有「passkey 測試」，點了整頁換成測試頁；直接打開 /#passkey-test 也可以（不用設定、不用精靈）
// - Chromium 的虛擬驗證器（CDP WebAuthn.addVirtualAuthenticator）：
//   - hasPrf: true（手機淺色）：建立 → PRF 啟用；算兩次 → 指紋一樣（和第 1 次一樣）；重新整理後還記得這把
//   - hasPrf: false（電腦深色）：建立 → PRF 沒有啟用；算一次 → 拿不到 PRF
// - 畫面上與「複製結果」（剪貼簿）都沒有 credential id 與 PRF 的值（base64、base64url、十六進位都查）
// - 測試頁沒有送出任何外部請求（只有本站的檔案）；「回到 App」回到平常的畫面
// - 正式版的建置：設定沒有入口，打開 /#passkey-test 還是平常的 App
// - 設計：沒有 emoji、字級只用五級、每張卡最多一顆實心按鈕、按鈕高度至少 44、沒有左右捲動；截圖 passkey-*.png
// 這個腳本自己建置 staging 與正式版兩份（$E2E_OUT 底下），用 4186、4187 埠開 vite preview；要先開 npm run dev:mock。
const { spawn, execFileSync } = require("child_process");
const path = require("path");

const E2E = require("./env.cjs");
const { chromium, skipWizard, go } = E2E;

const WEB = path.join(__dirname, "../../apps/web");
const BUILDS = {
  staging: { port: 4186, env: { VITE_STAGING: "1" } },
  production: { port: 4187, env: {} },
};
const SALT = "Zone2Mate passkey PRF test v1";
const FONT_SIZES = ["28px", "20px", "16px", "15px", "13px"];

let step = "start";

function build(name) {
  const outDir = path.join(E2E.OUT, `dist-passkey-${name}`);
  execFileSync("npx", ["vite", "build", "--outDir", outDir, "--emptyOutDir"], {
    cwd: WEB,
    stdio: "ignore",
    env: {
      ...process.env,
      VITE_FEATURES: "",
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
  mobile: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: "light" },
  desktop: { viewport: { width: 1280, height: 860 }, colorScheme: "dark" },
};

/** 虛擬驗證器：像手機或電腦內建的（internal、可驗證使用者、resident key） */
async function addAuthenticator(page, hasPrf) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable", { enableUI: false });
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      hasPrf,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, authenticatorId };
}

/** 這把 passkey 的 id 與 PRF 的值的各種寫法：畫面與複製的結果都不能出現 */
async function secretsOf(page, cdp, authenticatorId) {
  const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
  const forms = (b64) => {
    const buf = Buffer.from(b64, "base64");
    return [buf.toString("base64"), buf.toString("base64url"), buf.toString("hex")];
  };
  const ids = credentials.flatMap((c) => forms(c.credentialId));
  // PRF 的值：在頁面裡用同一個鹽再算一次（虛擬驗證器自動通過）
  const prf = await page.evaluate(async ({ salt, id }) => {
    const raw = atob(id);
    const credential = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: Uint8Array.from(raw, (c) => c.charCodeAt(0)) }],
        userVerification: "required",
        extensions: { prf: { eval: { first: new TextEncoder().encode(salt) } } },
      },
    });
    const first = credential.getClientExtensionResults().prf?.results?.first;
    return first ? btoa(String.fromCharCode(...new Uint8Array(first))) : null;
  }, { salt: SALT, id: credentials[0].credentialId });
  return { count: credentials.length, values: [...ids, ...(prf ? forms(prf) : [])], prf };
}

/** 設計準則的檢查清單裡能自動查的 */
async function designCheck(page) {
  return page.evaluate((sizes) => {
    const out = { emoji: [], sizes: [], primary: [], small: [], overflow: false };
    const emoji = /\p{Extended_Pictographic}/u;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const el = node.parentElement;
      if (!el || !node.textContent.trim() || el.closest("textarea") || !el.getClientRects().length) continue;
      if (emoji.test(node.textContent)) out.emoji.push(node.textContent.trim().slice(0, 40));
      const size = getComputedStyle(el).fontSize;
      if (!sizes.includes(size)) out.sizes.push(`${size} ${node.textContent.trim().slice(0, 20)}`);
    }
    for (const card of document.querySelectorAll(".card")) {
      const n = card.querySelectorAll("button.primary").length;
      if (n > 1) out.primary.push(card.dataset.part ?? card.className);
    }
    // 和 verify-design 一樣只查按鈕（共用的「細節」是 summary，不在這裡查）
    for (const b of document.querySelectorAll("button")) {
      const r = b.getBoundingClientRect();
      if (r.width && r.height < 44) out.small.push(`${b.textContent.trim().slice(0, 20)} ${Math.round(r.height)}`);
    }
    out.overflow = document.documentElement.scrollWidth > window.innerWidth + 1;
    return out;
  }, FONT_SIZES);
}

(async () => {
  const problems = [];
  const check = {};
  const servers = [];
  try {
    step = "build";
    for (const name of Object.keys(BUILDS)) servers.push(await serve(build(name), BUILDS[name].port));
  } catch (e) {
    console.error(`FAILED at [${step}]:`, e.message);
    for (const s of servers) s.kill();
    process.exit(1);
  }
  const url = (name, hash = "") => `http://localhost:${BUILDS[name].port}/${hash}`;
  const browser = await chromium.launch();
  try {
    // 1. staging、手機淺色、有 PRF：從設定最下面進去
    step = "staging-prf";
    {
      const context = await browser.newContext(viewports.mobile);
      await skipWizard(context);
      await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: url("staging").slice(0, -1) });
      const page = await context.newPage();
      const outside = [];
      page.on("request", (r) => {
        if (!r.url().startsWith(url("staging")) && !r.url().startsWith("data:")) outside.push(r.url());
      });
      const { cdp, authenticatorId } = await addAuthenticator(page, true);
      await page.goto(url("staging"));
      await go(page, "設定");
      const entry = page.locator("#side-panel .settings-list").getByRole("button", { name: /passkey 測試/ });
      check.stagingEntry = await entry.isVisible();
      // 只看測試頁送出的請求
      outside.length = 0;
      await entry.click();
      await page.locator(".passkey-test").waitFor({ timeout: 10000 });
      check.entryOpensPage = page.url().endsWith("#passkey-test");
      // 測試頁上不開 App（沒有分頁列）
      check.noAppUnder = (await page.locator(".tabbar").count()) === 0;
      await page.locator(".passkey-fact", { hasText: "系統與瀏覽器" }).getByText(/Android|Linux|macOS|Windows|iOS/).waitFor({ timeout: 5000 });

      await page.locator('[data-part="create"]').getByRole("button", { name: "建立" }).click();
      const created = page.locator('[data-result="create"]');
      await created.waitFor({ timeout: 10000 });
      check.createOk = (await created.innerText()).includes("成功");
      check.prfEnabled = await created.locator(".passkey-fact", { hasText: "PRF" }).getByText("啟用", { exact: true }).isVisible();

      const getBtn = page.locator('[data-part="get"]').getByRole("button", { name: "算一次" });
      await getBtn.click();
      await page.locator('[data-result="get"] li').nth(0).waitFor({ timeout: 10000 });
      await getBtn.click();
      await page.locator('[data-result="get"] li').nth(1).waitFor({ timeout: 10000 });
      const rows = await page.locator('[data-result="get"] li').allInnerTexts();
      const fps = rows.map((r) => r.match(/指紋 ([0-9a-f]{8})/)?.[1]);
      check.twoFingerprints = !!fps[0] && fps[0] === fps[1];
      check.saysSame = rows[1].includes("和第 1 次一樣");
      check.usedCreated = rows.every((r) => r.includes("這頁建立的那把"));

      await page.locator('[data-part="report"]').getByRole("button", { name: "複製結果" }).click();
      await page.locator('[data-part="report"]').getByRole("button", { name: "已複製" }).waitFor({ timeout: 5000 });
      const clip = await page.evaluate(() => navigator.clipboard.readText());
      check.reportHasResults = clip.includes("PRF 啟用") && clip.includes("（和第 1 次一樣）") && clip.includes(`指紋 ${fps[0]}`);
      await page.screenshot({ path: path.join(E2E.OUT, "passkey-mobile-light.png"), fullPage: true });
      const design = await designCheck(page);

      const secrets = await secretsOf(page, cdp, authenticatorId);
      check.gotSecrets = secrets.count === 1 && !!secrets.prf;
      // 報告的文字框也算畫面的一部分
      const shown = (await page.locator("body").innerText()) + (await page.locator("#passkey-report").inputValue());
      check.noSecretsOnPage = secrets.values.every((v) => !shown.includes(v));
      check.noSecretsInReport = secrets.values.every((v) => !clip.includes(v));
      check.noOutsideRequests = outside.length === 0;
      if (outside.length) problems.push(`外部請求：${outside.join(" | ")}`);

      // 重新整理：還記得這把（有「自己選 passkey」與「忘記這把」）
      await page.reload();
      await page.locator(".passkey-test").waitFor();
      check.remembers = await page.getByRole("button", { name: "忘記這把" }).isVisible();
      // 回到 App
      await page.getByRole("button", { name: "回到 App" }).click();
      await page.locator(".tabbar").waitFor({ timeout: 10000 });
      check.backToApp = !page.url().includes("#passkey-test");

      for (const [k, v] of Object.entries({ emoji: design.emoji, sizes: design.sizes, primary: design.primary, small: design.small })) {
        check[`mobile.${k}`] = v.length === 0;
        if (v.length) problems.push(`[mobile] ${k}：${v.join(" | ")}`);
      }
      check["mobile.noOverflow"] = !design.overflow;
      await context.close();
    }

    // 2. staging、電腦深色、沒有 PRF：直接打開網址（沒有設定、沒有跳過精靈）
    step = "staging-noprf";
    {
      const context = await browser.newContext(viewports.desktop);
      const page = await context.newPage();
      const { cdp, authenticatorId } = await addAuthenticator(page, false);
      await page.goto(url("staging", "#passkey-test"));
      await page.locator(".passkey-test").waitFor({ timeout: 10000 });
      check.directUrl = true;
      check.noForget = (await page.getByRole("button", { name: "忘記這把" }).count()) === 0;
      await page.locator('[data-part="create"]').getByRole("button", { name: "建立" }).click();
      const created = page.locator('[data-result="create"]');
      await created.waitFor({ timeout: 10000 });
      const createText = await created.innerText();
      check.noPrfCreate = createText.includes("成功") && /沒有啟用|瀏覽器沒有回報/.test(createText);
      await page.locator('[data-part="get"]').getByRole("button", { name: "算一次" }).click();
      const row = page.locator('[data-result="get"] li').first();
      await row.waitFor({ timeout: 10000 });
      check.noPrfGet = (await row.innerText()).includes("拿不到 PRF");
      const report = await page.locator("#passkey-report").inputValue();
      check.noPrfReport = report.includes("拿不到 PRF");
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      const id = Buffer.from(credentials[0].credentialId, "base64");
      const forms = [id.toString("base64"), id.toString("base64url"), id.toString("hex")];
      const shown = (await page.locator("body").innerText()) + report;
      check.noIdNoPrf = forms.every((f) => !shown.includes(f));
      await page.locator(".disclosure > summary", { hasText: "細節" }).click();
      await page.locator(".disclosure > summary", { hasText: "測完之後" }).click();
      await page.screenshot({ path: path.join(E2E.OUT, "passkey-desktop-dark.png"), fullPage: true });
      const design = await designCheck(page);
      for (const [k, v] of Object.entries({ emoji: design.emoji, sizes: design.sizes, primary: design.primary, small: design.small })) {
        check[`desktop.${k}`] = v.length === 0;
        if (v.length) problems.push(`[desktop] ${k}：${v.join(" | ")}`);
      }
      check["desktop.noOverflow"] = !design.overflow;
      await context.close();
    }

    // 3. 正式版：沒有入口，打開網址還是平常的 App
    step = "production";
    {
      const context = await browser.newContext(viewports.mobile);
      await skipWizard(context);
      const page = await context.newPage();
      await page.goto(url("production", "#passkey-test"));
      await page.locator(".tabbar").waitFor({ timeout: 15000 });
      check.productionNoPage = (await page.locator(".passkey-test").count()) === 0;
      await go(page, "設定");
      await page.locator("#side-panel .settings-list").waitFor();
      check.productionNoEntry = (await page.locator("#side-panel .settings-list").getByText("passkey 測試").count()) === 0;
      await context.close();
    }
  } catch (e) {
    problems.push(`FAILED at [${step}]: ${e.message}`);
  } finally {
    await browser.close();
    for (const s of servers) s.kill();
  }

  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`  ${p}`);
  const ok = problems.length === 0 && Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  process.exit(ok ? 0 : 1);
})();
