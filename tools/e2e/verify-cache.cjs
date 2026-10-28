// 驗證 Prompt Caching（規格 12.23 第 2 點）：送出的快取標記、斷點前不帶會變的內容、頁尾的快取讀寫與金額。
// Claude 直連與 OpenRouter 上的 Claude 都把請求轉到模擬上游（模擬服務依快取標記回傳快取的讀與寫）
const E2E = require("./env.cjs");
const { chromium } = E2E;
const URL = E2E.URL;

// 和 packages/core/src/llm/pricing.ts 的 claude-sonnet-5-5 一樣（每百萬 token 的美元）
const PRICE = { input: 2, cacheWrite: 2.5, cacheRead: 0.1, output: 10 };
const formatUsd = (n) => (n >= 1 ? `US$${n.toFixed(2)}` : n >= 0.01 ? `US$${n.toFixed(3)}` : `US$${n.toFixed(4)}`);
const fmt = (n) => n.toLocaleString("en-US");

let step = "start";
(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const mockRequests = async () => (await (await fetch(`${E2E.MOCK}/_mock/requests`)).json()).filter((r) => r.kind === "llm");

  for (const route of ["anthropic", "openrouter"]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "Asia/Taipei" });
    const page = await context.newPage();
    page.on("console", (m) => m.type() === "error" && problems.push(`[${route} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${route} ${step}] pageerror: ${e.message}`));
    // 送到 Anthropic 或 OpenRouter 的請求改送模擬上游
    const forward = (prefix) => async (r) => {
      const target = r.request().url().replace(prefix, `${E2E.MOCK}/v1`);
      const response = await r.fetch({ url: target });
      await r.fulfill({ response });
    };
    await page.route("https://api.anthropic.com/v1/**", forward("https://api.anthropic.com/v1"));
    await page.route("https://openrouter.ai/api/v1/**", forward("https://openrouter.ai/api/v1"));
    const c = {};
    try {
      step = "設定";
      await page.goto(URL);
      await page.locator("nav.tabbar button").first().waitFor();
      // 設定的「AI 教練」；模型名稱在「進階」（規格 12.28）
      await E2E.settings(page, "AI 教練");
      const openAdvanced = async () => {
        const advanced = page.locator("#side-panel details.advanced");
        if (!(await advanced.evaluate((d) => d.open))) await advanced.locator("summary").click();
      };
      if (route === "anthropic") {
        await page.getByLabel("供應商").selectOption("anthropic");
        await page.getByLabel("API key", { exact: true }).fill("mock-key");
        await openAdvanced();
        await page.getByLabel("主對話模型").fill("claude-sonnet-5-5");
      } else {
        await page.getByLabel("供應商").selectOption("openai-compatible");
        await page.getByLabel("API key", { exact: true }).fill("mock-key");
        await page.getByLabel("服務網址").fill("https://openrouter.ai/api/v1");
        await openAdvanced();
        await page.getByLabel("主對話模型").fill("anthropic/claude-sonnet-5.5");
      }
      await page.getByLabel("我了解並同意以上的資料流向").check();
      await E2E.settings(page, "訓練紀錄");
      await page.getByLabel("API key", { exact: true }).fill("mock-intervals-key");
      await page.getByRole("button", { name: "儲存設定" }).click();
      await page.getByText("設定已儲存在這個瀏覽器。").waitFor();

      step = "對話";
      await E2E.go(page, "對話");
      const send = async (text) => {
        // 模擬上游只留最近 50 筆：用最後一筆對齊，不用索引
        const prev = await mockRequests();
        const lastSeen = prev.length ? JSON.stringify(prev.at(-1)) : null;
        const answered = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
        await page.getByLabel("訊息").fill(text);
        await page.getByLabel("訊息").press("Enter");
        await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, answered, { timeout: 30000 });
        await page.locator(".footer").waitFor({ timeout: 10000 });
        // 跑後摘要等背景的請求不帶工具；只看主對話的
        const now = await mockRequests();
        const from = lastSeen ? now.map((r) => JSON.stringify(r)).lastIndexOf(lastSeen) + 1 : 0;
        const calls = now.slice(from).filter((r) => (r.body.tools ?? []).length > 0);
        return { calls, footer: await page.locator(".footer").innerText() };
      };
      const first = await send("這週的課表怎麼樣？"); // 模擬上游會呼叫 get_training_plan，再回覆
      const second = await send("好，謝謝");

      step = "請求";
      const all = [...first.calls, ...second.calls];
      c.toolLoop = first.calls.length === 2 && second.calls.length === 1;
      c.topLevelCache = all.every((r) => JSON.stringify(r.body.cache_control) === JSON.stringify({ type: "ephemeral" }));
      const systemBlocks = (body) => (route === "anthropic" ? body.system : body.messages.find((m) => m.role === "system")?.content);
      const blocks = all.map((r) => systemBlocks(r.body));
      c.systemSplit = blocks.every((b) => Array.isArray(b) && b.length === 2 && b[0].cache_control?.type === "ephemeral" && !b[1].cache_control);
      const prefix = (r) => JSON.stringify(r.body.tools) + systemBlocks(r.body)[0].text;
      c.samePrefix = all.every((r) => prefix(r) === prefix(all[0]));
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
      c.dateAfterBreakpoint = !blocks[0][0].text.includes(today) && blocks[0][1].text.includes(`今天日期：${today}`);
      c.parallelHint = blocks[0][0].text.includes("在同一輪一起呼叫");

      step = "頁尾";
      const sum = (calls, key) => calls.reduce((n, r) => n + r.usage[key], 0);
      for (const [label, turn] of [["first", first], ["second", second]]) {
        const read = sum(turn.calls, "cacheRead");
        const write = sum(turn.calls, "cacheWrite");
        c[`${label}.cacheInFooter`] = turn.footer.includes(`快取 讀 ${fmt(read)} 寫 ${fmt(write)}`);
        if (route === "anthropic") {
          const cost =
            (sum(turn.calls, "input") * PRICE.input + write * PRICE.cacheWrite + read * PRICE.cacheRead + sum(turn.calls, "output") * PRICE.output) /
            1_000_000;
          c[`${label}.cost`] = turn.footer.includes(`約 ${formatUsd(cost)}`);
        } else {
          // 模型名稱不在價格表（OpenRouter 的寫法），不顯示金額
          c[`${label}.noCost`] = !turn.footer.includes("US$");
        }
        console.log(`${route} ${label}: ${turn.footer}`);
      }
      // 第一則：第一次寫入，工具迴圈的第二輪讀到第一輪寫的；第二則：一開始就讀到前面寫的
      c.firstWrites = first.calls[0].usage.cacheWrite > 0 && first.calls[0].usage.cacheRead === 0;
      c.toolRoundReads = first.calls[1].usage.cacheRead >= first.calls[0].usage.cacheWrite;
      c.nextMessageReads = second.calls[0].usage.cacheRead > 0;

      await page.screenshot({ path: `${E2E.OUT}/cache-${route}.png` });
    } catch (e) {
      problems.push(`[${route} ${step}] ${e.message}`);
    }
    for (const [k, v] of Object.entries(c)) check[`${route}.${k}`] = v;
    await context.close();
  }

  await browser.close();
  for (const [k, v] of Object.entries(check)) console.log(`${v ? "OK  " : "FAIL"} ${k}`);
  for (const p of problems) console.log(`PROBLEM ${p}`);
  console.log(Object.values(check).every(Boolean) && !problems.length ? "ALL OK" : "SOME CHECKS FAILED");
})();
