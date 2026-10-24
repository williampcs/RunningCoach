// 驗證介面調整第一輪（規格 12.16）：教練動態的「今天的重點」看板（展開即全部、看板內捲動）、
// 對話輸入框一行高與自動長高、各欄位的 Enter、訊息的時間戳（今天、昨天、今年更早、不同年）。
// 手機（390 寬）與電腦（1280 寬）、淺色與深色各截一組圖。
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;
const mockToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const shift = (iso, days) => new Date(Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

let step = "start";

async function setup(page) {
  const tab = (label) => page.getByRole("button", { name: label, exact: true }).click();
  await page.goto(URL);
  await page.locator("nav.tabbar button").first().waitFor();
  await tab("設定");
  // 時區設成和模擬服務一樣，「今天」才對得上
  await page.getByLabel("時區").fill("Asia/Taipei");
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();
  await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
  // 天氣：教練動態多一則需要留意的提醒
  const weather = page.locator("#weather");
  await weather.getByLabel("台灣的縣市").selectOption({ label: "台北市" });
  await weather.getByText("目前：台北市").waitFor();
  await page.getByRole("button", { name: "同步最近 14 天" }).first().click();
  await page.getByText(/同步完成/).waitFor({ timeout: 30000 });
  await tab("對話");
  await page.locator(".feed-item").first().waitFor();
}

async function send(page, text) {
  const before = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
  await page.getByLabel("訊息").fill(text);
  await page.getByLabel("訊息").press("Enter");
  await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, before, { timeout: 20000 });
  await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
}

const boxHeight = (locator) => locator.evaluate((el) => el.getBoundingClientRect().height);

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    for (const scheme of ["light", "dark"]) {
      const tag = `${mobile ? "390" : "1280"}-${scheme}`;
      const context = await browser.newContext({
        ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 860 } }),
        colorScheme: scheme,
        timezoneId: "Asia/Taipei",
      });
      const page = await context.newPage();
      page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
      page.on("dialog", (d) => void d.accept());
      const tab = (label) => page.getByRole("button", { name: label, exact: true }).click();
      const c = {};
      // 完整的功能檢查只在手機淺色跑一次，其他組合看版面
      const full = mobile && scheme === "light";
      try {
        step = "設定與同步";
        await setup(page);
        const feed = page.locator("section.feed");

        step = "看板：展開即全部";
        const items = await page.locator(".feed-item").count();
        c.feedShowsAll = items >= 3;
        c.noShowMore = (await page.getByRole("button", { name: /顯示其餘/ }).count()) === 0 && (await page.getByRole("button", { name: /只顯示前/ }).count()) === 0;
        c.feedDate = (await feed.locator(".feed-head .feed-date").innerText()).startsWith("今天 ") && (await feed.locator(".feed-head .feed-date").innerText()).includes("（");
        // 看板不是卡片：沒有圓角的框線與陰影（手機）、底色和對話背景不同
        const look = await feed.evaluate((el) => {
          const s = getComputedStyle(el);
          return { bg: s.backgroundColor, body: getComputedStyle(document.body).backgroundColor, shadow: s.boxShadow, left: el.getBoundingClientRect().left, width: el.getBoundingClientRect().width };
        });
        c.boardTint = look.bg !== look.body && look.shadow === "none";
        if (mobile) c.fullBleed = look.left === 0 && look.width === 390;
        await page.screenshot({ path: `${OUT}/ui-${tag}-1-board.png` });

        if (full) {
          step = "看板：最高半個畫面，超過在看板內捲動";
          await page.setViewportSize({ width: 390, height: 560 });
          await page.waitForTimeout(200);
          const box = await feed.evaluate((el) => ({ h: el.clientHeight, sh: el.scrollHeight, vh: window.innerHeight, overflow: getComputedStyle(el).overflowY }));
          c.feedMaxHalf = box.h <= box.vh * 0.5 + 1;
          c.feedScrollsInside = box.sh > box.h && box.overflow === "auto";
          await feed.evaluate((el) => (el.scrollTop = el.scrollHeight));
          c.feedHeadSticky = await feed.locator(".feed-head").isVisible();
          await page.screenshot({ path: `${OUT}/ui-${tag}-2-board-scroll.png` });
          await page.setViewportSize({ width: 390, height: 844 });

          step = "輸入框：一行高、長高到 6 行、送出後縮回";
          const box1 = page.getByLabel("訊息");
          const sendButton = page.getByRole("button", { name: "送出" });
          const oneLine = await boxHeight(box1);
          c.composerOneLine = Math.abs(oneLine - (await boxHeight(sendButton))) <= 2;
          const lh = await box1.evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
          await box1.fill("一\n二\n三");
          const three = await boxHeight(box1);
          c.composerGrows = Math.abs(three - (oneLine + 2 * lh)) <= 2;
          await box1.fill(Array.from({ length: 10 }, (_, i) => `第 ${i + 1} 行`).join("\n"));
          const ten = await boxHeight(box1);
          c.composerCapsAtSix = Math.abs(ten - (oneLine + 5 * lh)) <= 2 && (await box1.evaluate((el) => getComputedStyle(el).overflowY)) === "auto";
          await page.screenshot({ path: `${OUT}/ui-${tag}-3-composer-grown.png` });
          // Shift+Enter 換行、Enter 送出
          await box1.fill("");
          await box1.type("今天想跑輕鬆一點");
          await box1.press("Shift+Enter");
          await box1.type("可以嗎？");
          c.shiftEnterNewline = (await box1.inputValue()) === "今天想跑輕鬆一點\n可以嗎？";
          const before = await page.locator(".bubble.assistant:not(.muted):not(.streaming)").count();
          const timesBefore = await page.locator(".msg.assistant .msg-time").count();
          await box1.press("Enter");
          // 串流中教練那則沒有時間
          await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").first().waitFor({ timeout: 5000 });
          c.noTimeWhileStreaming = (await page.locator(".msg.assistant .msg-time").count()) === timesBefore;
          c.composerShrinks = Math.abs((await boxHeight(box1)) - oneLine) <= 1;
          await page.waitForFunction((n) => document.querySelectorAll(".bubble.assistant:not(.muted):not(.streaming)").length > n, before, { timeout: 20000 });
          await page.locator(".bubble.assistant.muted, .bubble.assistant.streaming").waitFor({ state: "detached", timeout: 20000 }).catch(() => undefined);
          // 回覆列出現時一樣一行高
          const coachMsg = page.locator(".msg.assistant").last();
          await coachMsg.getByRole("button", { name: "回覆" }).click();
          c.replyingOneLine = Math.abs((await boxHeight(box1)) - oneLine) <= 1;
          await page.getByRole("button", { name: "取消回覆" }).click();
        } else {
          await send(page, "今天想跑輕鬆一點，可以嗎？");
        }

        step = "時間戳：今天";
        await send(page, "那明天呢？");
        const times = await page.locator(".msg .msg-time").allInnerTexts();
        c.timesShown = times.length === (await page.locator(".msg").count()) && times.every((t) => /^\d{2}:\d{2}$/.test(t));
        c.bothSides = (await page.locator(".msg.user .msg-time").count()) > 0 && (await page.locator(".msg.assistant .msg-time").count()) > 0;
        // 開始對話後收成一行：截一張收起的，再展開截一張
        await page.screenshot({ path: `${OUT}/ui-${tag}-4-chat-collapsed.png` });
        await page.locator(".feed-summary").click();
        await page.locator(".feed-list").waitFor();
        c.expandShowsAll = (await page.locator(".feed-item").count()) === items;
        await page.screenshot({ path: `${OUT}/ui-${tag}-5-chat-expanded.png` });

        if (full) {
          step = "Enter：賽事名稱送出、不換行；備註換行";
          await tab("計畫與賽事");
          const card = page.locator("#races");
          await card.getByRole("button", { name: "新增賽事" }).click();
          await card.getByLabel("日期").fill(shift(mockToday, 60));
          await card.getByLabel("距離（km）").fill("21.1");
          await card.getByLabel("備註").fill("第一行");
          await card.getByLabel("備註").press("End");
          await card.getByLabel("備註").press("Enter");
          await card.getByLabel("備註").type("第二行");
          c.notesNewline = (await card.getByLabel("備註").inputValue()) === "第一行\n第二行";
          c.nameIsAutogrow = (await card.getByLabel("賽事名稱").evaluate((el) => el.tagName)) === "TEXTAREA";
          await card.getByLabel("賽事名稱").fill("一個名字很長很長的城市國際半程馬拉松暨健康路跑嘉年華");
          await card.screenshot({ path: `${OUT}/ui-${tag}-6-race-form.png` });
          await card.getByLabel("賽事名稱").press("Enter");
          await card.locator(".list li").filter({ hasText: "健康路跑嘉年華" }).first().waitFor({ timeout: 5000 });
          c.nameEnterSubmits = true;
          c.notesKept = (await card.locator(".list li").filter({ hasText: "健康路跑嘉年華" }).first().innerText()).includes("第一行");

          step = "Enter：記住的事";
          await tab("選手資料");
          const memories = page.locator(".memories");
          await memories.getByLabel("新增記住的事").fill("貼上\n的兩行");
          c.pasteNewlineToSpace = (await memories.getByLabel("新增記住的事").inputValue()) === "貼上 的兩行";
          await memories.getByLabel("新增記住的事").press("Enter");
          await memories.locator(".memory-text", { hasText: "貼上 的兩行" }).waitFor({ timeout: 5000 });
          c.memoryEnterSubmits = true;
          c.goalIsAutogrow = (await page.getByLabel("長期目標").evaluate((el) => el.tagName)) === "TEXTAREA";

          step = "時間戳：昨天、今年更早、不同年（測試模式的模擬日期）";
          await tab("設定");
          // 啟用後頁面重新載入、回到對話頁，改用測試資料庫（沒有剛才的對話）
          await Promise.all([page.waitForEvent("load"), page.getByRole("button", { name: "啟用測試模式" }).click()]);
          await page.locator("nav.tabbar button").first().waitFor();
          await tab("對話");
          await send(page, "測試模式的第一句");
          const label = async () => page.locator(".msg.user", { hasText: "測試模式的第一句" }).locator(".msg-time").innerText();
          c.todayFormat = /^\d{2}:\d{2}$/.test(await label());
          const setDate = async (date) => {
            await tab("設定");
            await page.getByLabel("模擬日期").fill(date);
            await page.getByRole("button", { name: "套用" }).click();
            await page.getByText(`模擬日期改為 ${date}。`).waitFor();
            await tab("對話");
            await page.locator(".msg.user", { hasText: "測試模式的第一句" }).waitFor();
          };
          await setDate(shift(mockToday, 1));
          c.yesterdayFormat = /^昨天 \d{2}:\d{2}$/.test(await label());
          // 至少隔兩天、而且同一年：年底時改成往前
          const later = shift(mockToday, 3).slice(0, 4) === mockToday.slice(0, 4) ? shift(mockToday, 3) : null;
          if (later) {
            await setDate(later);
            const [, m, d] = mockToday.split("-").map(Number);
            c.sameYearFormat = new RegExp(`^${m}/${d} \\d{2}:\\d{2}$`).test(await label());
          }
          await setDate(`${Number(mockToday.slice(0, 4)) + 1}-02-01`);
          const [y, m, d] = mockToday.split("-").map(Number);
          c.otherYearFormat = new RegExp(`^${y}/${m}/${d} \\d{2}:\\d{2}$`).test(await label());
          await page.screenshot({ path: `${OUT}/ui-${tag}-7-times.png` });
        }
      } catch (e) {
        problems.push(`[${tag} ${step}] ${e.message.split("\n")[0]}`);
      }
      check[tag] = c;
      await context.close();
    }
  }
  await browser.close();
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log("problems:\n" + problems.join("\n"));
  const ok = problems.length === 0 && Object.values(check).every((c) => Object.values(c).every(Boolean));
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
})();
