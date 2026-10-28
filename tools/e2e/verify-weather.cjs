// 驗證天氣（手機尺寸）：只給天氣用的城市、送出的座標、對話與跑後分析、教練動態、清除
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;

// 設定的第一層是清單（規格 12.28）：用 env.cjs 的 setupMock 進到「AI 教練」「訓練紀錄」填好
const setup = (page, { intervals, timeZone = null }) => E2E.setupMock(page, { mock: E2E.MOCK, intervals, timeZone });

async function newPage(browser, problems) {
  // 每次用新的 context：OPFS 與 localStorage 都是空的，等同第一次使用
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(URL);
  return page;
}

const MOCK = E2E.MOCK;
const requests = async () => (await fetch(`${MOCK}/_mock/requests`)).json();

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const page = await newPage(browser, problems);
  await setup(page, { intervals: true });

  // 設定的「天氣」：說明收在 ⓘ「這個城市只用來查天氣」裡（規格 12.28）
  await E2E.settings(page, "天氣");
  const card = page.locator("#weather");
  check.notSetYet = await card.getByText("還沒設定：教練不會參考天氣。").isVisible();
  await card.getByRole("button", { name: "這個城市只用來查天氣" }).click();
  check.privacyNotice = await card.getByText("不會給 AI 模型看").isVisible();
  check.separateFromLandmark = await card.getByText("「紀錄頁的里程碑」是分開的設定").isVisible();
  check.credit = (await card.getByRole("link", { name: "Weather data by Open-Meteo.com" }).getAttribute("href")) === "https://open-meteo.com/";
  const search = card.getByLabel("其他地方（用英文搜尋）");
  await search.fill("找不到的地方");
  await card.getByRole("button", { name: "搜尋城市" }).click();
  await card.getByText("找不到這個城市").waitFor();
  check.noResults = true;
  // 中文的台灣縣市在本機對照，不送出去
  const before = (await requests()).filter((r) => r.kind === "weather").length;
  await search.fill("臺北");
  await card.getByRole("button", { name: "搜尋城市" }).click();
  check.localTaiwanMatch = (await card.locator(".weather-results button").allInnerTexts()).join("|") === "台北市";
  check.localNotSent = (await requests()).filter((r) => r.kind === "weather").length === before;
  // 其他地方：英文的結果
  await search.fill("Mock");
  await card.getByRole("button", { name: "搜尋城市" }).click();
  await card.getByRole("button", { name: "Mock City, North, Mockland" }).click();
  await card.getByText("目前：").waitFor();
  check.chosenEnglish = (await card.innerText()).includes("目前：Mock City, North, Mockland");
  check.englishRequested = (await requests()).some((r) => r.kind === "weather" && r.body.path === "/weather/v1/search" && r.body.query.language === "en");
  check.selectShowsOther = (await card.getByLabel("台灣的縣市").locator("option:checked").innerText()) === "（不是台灣的縣市）";
  // 直接選台灣的縣市
  await card.getByLabel("台灣的縣市").selectOption({ label: "台北市" });
  await card.getByText("目前：台北市").waitFor();
  check.chosenFromMenu = true;
  await page.screenshot({ path: `${OUT}/weather-1-settings.png`, fullPage: false });
  await card.screenshot({ path: `${OUT}/weather-1-card.png` });

  // 存在 localStorage 的設定裡、座標已四捨五入；不在資料庫
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")).weather);
  check.storedRounded = stored.label === "台北市" && stored.lat === 25 && stored.lon === 121.6;

  // 其他設定存檔不會蓋掉天氣
  await page.locator("#side-panel .back-button").click();
  await page.locator("#side-panel").getByRole("button", { name: "同步最近 14 天" }).click();
  await page.getByText(/同步完成/).waitFor({ timeout: 30000 });

  // 教練動態：濕熱的提醒與來源標示
  await E2E.go(page, "對話");
  // 標題是短句（濕熱，可能下雨），數字是標籤（規格 12.28）
  // 看板每天第一次打開是收起的：先展開
  await page.locator(".feed-summary, .feed-list").first().waitFor({ timeout: 10000 });
  if (await page.locator(".feed-summary").count()) await page.locator(".feed-summary").click();
  const heat = page.locator(".feed-item").filter({ has: page.locator(".feed-title", { hasText: /^濕熱/ }) });
  await heat.waitFor({ timeout: 10000 });
  // 濕熱與下雨合成一則
  check.oneWeatherItem = (await page.locator(".feed-item").filter({ hasText: "Weather data by Open-Meteo.com" }).count()) === 1 && (await heat.locator(".feed-title").innerText()) === "濕熱，可能下雨";
  check.weatherTags = (await heat.locator(".feed-tags .chip").allInnerTexts()).some((t) => /^體感 \d+°C$/.test(t)) && !/（/.test(await heat.locator(".feed-title").innerText());
  check.feedCredit = (await heat.getByRole("link", { name: "Weather data by Open-Meteo.com" }).count()) === 1;
  await page.screenshot({ path: `${OUT}/weather-2-feed.png`, fullPage: false });

  // 對話：教練用 get_weather，回覆列出依據
  await page.getByPlaceholder("輸入訊息…").fill("明天天氣適合跑嗎");
  await page.getByRole("button", { name: "送出" }).click();
  await page.getByText("參考了").last().waitFor({ timeout: 20000 });
  check.sourceLabel = (await page.getByText("天氣預報（Open-Meteo）").count()) > 0;
  await page.screenshot({ path: `${OUT}/weather-3-chat.png`, fullPage: false });

  // 送出了什麼：天氣服務只收到四捨五入的座標；模型看不到城市與座標
  const all = await requests();
  const weatherQs = all.filter((r) => r.kind === "weather" && r.body.path !== "/weather/v1/search" && r.body.query.latitude === "25");
  check.weatherQueried = weatherQs.length > 0;
  check.onlyRoundedSent = weatherQs.every((r) => r.body.query.latitude === "25" && r.body.query.longitude === "121.6");
  const llm = all.filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body));
  check.modelNeverSeesPlace = llm.every((t) => !t.includes("台北市") && !t.includes("Mock City") && !t.includes("121.6") && !t.includes("135.5"));
  check.systemHasWeather = llm.some((t) => t.includes("今天的天氣（Open-Meteo 的預報，約略）"));
  check.summaryHasRunWeather = llm.some((t) => t.includes("當時天氣（模型估計，約略）"));
  check.toolResultHasForecast = llm.some((t) => t.includes("天氣預報（Open-Meteo 的模型預報，約略"));

  // 改時區後存檔：天氣的城市還在
  await E2E.settings(page, "訓練紀錄");
  await page.locator("#side-panel details.advanced > summary").click();
  await page.getByLabel("時區").fill("Asia/Tokyo");
  await page.getByRole("button", { name: "儲存設定" }).click();
  await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
  await E2E.settings(page, "天氣");
  check.keptAfterSave = (await page.locator("#weather").innerText()).includes("目前：台北市");

  // 清除
  await page.locator("#weather").getByRole("button", { name: "清除天氣的城市" }).click();
  await page.locator("#weather").getByText("還沒設定：教練不會參考天氣。").waitFor();
  check.cleared = (await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")).weather)) === null;
  await E2E.go(page, "對話");
  await page.waitForTimeout(800);
  check.feedGoneAfterClear = (await page.locator(".feed-item").filter({ hasText: "Weather data by Open-Meteo.com" }).count()) === 0;
  await page.context().close();

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message);
  process.exit(1);
});
