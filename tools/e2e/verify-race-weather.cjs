// 驗證比賽地點的天氣（規格 12.31 第 3 點）：沒設天氣的城市也能用；賽事的地點與起跑時間、看板在賽前三天的「比賽日的天氣」、
// 教練查得到天氣、送出的只有四捨五入的座標、模型看不到地點；清除地點後看板不再顯示
const E2E = require("./env.cjs");
const { chromium } = E2E;

const width = Number(process.argv[2] || 390);
const height = Number(process.argv[3] || 844);
const scheme = process.argv[4] || "light";
const mobile = width < 600;
const MOCK = E2E.MOCK;
// 模擬上游只留最近 50 筆，也包括之前的腳本送的：只看這個腳本開始以後的（用開始時的最後一筆對齊）
let startMark = null;
const requests = async () => {
  const all = await (await fetch(`${MOCK}/_mock/requests`)).json();
  const at = startMark ? all.map((r) => JSON.stringify(r)).lastIndexOf(startMark) : -1;
  return all.slice(at + 1);
};
// 模擬上游的「今天」是台北時間
const TODAY = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());
const plusDays = (iso, n) => new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
let step = "start";

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({
    ...(mobile ? { viewport: { width, height }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width, height } }),
    colorScheme: scheme,
    timezoneId: "Asia/Taipei",
  });
  const page = await context.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`[${step}] console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`[${step}] pageerror: ${e.message}`));
  page.on("dialog", (d) => void d.accept());
  const check = {};
  const shot = (name) => page.screenshot({ path: `${E2E.OUT}/race-weather-${width}-${scheme}-${name}.png` });

  const before = await (await fetch(`${MOCK}/_mock/requests`)).json();
  startMark = before.length ? JSON.stringify(before.at(-1)) : null;

  step = "設定（沒有天氣的城市）";
  await page.goto(E2E.URL);
  await E2E.setupMock(page, { mock: E2E.MOCK });
  check.noWeatherCity = (await page.evaluate(() => JSON.parse(localStorage.getItem("running-coach.settings.v1")).weather ?? null)) === null;

  step = "新增有地點的賽事";
  await E2E.go(page, "計畫");
  const races = page.locator("section#races");
  await races.getByRole("button", { name: "新增賽事" }).click();
  await races.getByLabel("賽事名稱").fill("秋季半程馬拉松");
  await races.getByLabel("日期").fill(plusDays(TODAY, 3));
  await races.getByLabel("距離（km）").fill("21.1");
  await races.getByLabel("目標時間").fill("1:55:00");
  await races.getByLabel("起跑時間（選填）").fill("06:30");
  // 說明收在 ⓘ
  await races.getByRole("button", { name: "比賽地點只用來查天氣" }).click();
  check.placePrivacy = await races.getByText("教練只看得到天氣，看不到地點").isVisible();
  await races.getByRole("button", { name: "比賽地點只用來查天氣" }).click();
  // 台灣的縣市在本機對照，不送出去搜尋
  const searchesBefore = (await requests()).filter((r) => r.kind === "weather" && r.body.path === "/weather/v1/search").length;
  await races.getByLabel("其他地方（用英文搜尋）").fill("臺北");
  await races.getByLabel("其他地方（用英文搜尋）").press("Enter");
  check.enterDoesNotSubmit = (await races.getByRole("button", { name: "新增", exact: true }).count()) === 1;
  await races.locator(".weather-results").getByRole("button", { name: "台北市" }).click();
  check.localNotSent = (await requests()).filter((r) => r.kind === "weather" && r.body.path === "/weather/v1/search").length === searchesBefore;
  check.chosen = (await races.locator(".race-place").innerText()).includes("目前：台北市");
  await races.locator("form").screenshot({ path: `${E2E.OUT}/race-weather-${width}-${scheme}-form.png` });
  await races.getByRole("button", { name: "新增", exact: true }).click();
  const row = races.locator("li", { hasText: "秋季半程馬拉松" });
  await row.waitFor({ timeout: 5000 });
  check.listShowsStartAndPlace = /06:30 起跑 · 台北市/.test(await row.innerText());
  // 存在資料庫的座標已四捨五入
  await shot("races");

  step = "看板：比賽日的天氣";
  await E2E.go(page, "對話");
  await page.locator(".feed-summary, .feed-list").first().waitFor({ timeout: 10000 });
  if (await page.locator(".feed-summary").count()) await page.locator(".feed-summary").click();
  const item = page.locator(".feed-item").filter({ has: page.locator(".feed-title", { hasText: /^比賽日的天氣：/ }) });
  await item.waitFor({ timeout: 10000 });
  const title = await item.locator(".feed-title").innerText();
  check.feedTitle = /^比賽日的天氣：.+/.test(title) && !/[（(]\d/.test(title);
  check.feedTags = (await item.locator(".feed-tags .chip").allInnerTexts()).some((t) => /^體感 \d+°C$/.test(t));
  check.feedDetail = (await item.locator(".feed-sub").innerText()).startsWith("秋季半程馬拉松 · 起跑 06:30");
  check.feedCredit = (await item.getByRole("link", { name: "Weather data by Open-Meteo.com" }).count()) === 1;
  check.feedNoPlace = !(await item.innerText()).includes("台北");
  await item.scrollIntoViewIfNeeded();
  await shot("feed");
  await item.screenshot({ path: `${E2E.OUT}/race-weather-${width}-${scheme}-feed-item.png` });
  // 送出的是四捨五入的座標、比賽地點的時區、16 天
  const raceQs = (await requests()).filter((r) => r.kind === "weather" && r.body.path === "/weather/v1/forecast" && r.body.query.timezone === "auto");
  check.forecastQueried = raceQs.length > 0 && raceQs.every((r) => r.body.query.latitude === "25" && r.body.query.longitude === "121.6" && r.body.query.forecast_days === "16");
  // 沒設天氣的城市：沒有查「今天的天氣」
  check.noCityForecast = (await requests()).every((r) => r.kind !== "weather" || r.body.path === "/weather/v1/search" || r.body.query.timezone === "auto");

  step = "問教練怎麼配速";
  await item.getByRole("button", { name: "問教練怎麼配速" }).click();
  await page.locator(".msg.user", { hasText: "的天氣預報：" }).last().waitFor({ timeout: 10000 });
  await page.getByText("參考了").last().waitFor({ timeout: 30000 });
  check.askSent = (await page.locator(".msg.user").last().innerText()).includes("我該怎麼配速");
  check.sourceLabel = (await page.getByText("比賽日的天氣預報（Open-Meteo）").count()) > 0;
  const lastReply = await page.locator(".bubble.assistant").last().innerText();
  check.coachSawWeather = lastReply.includes("「秋季半程馬拉松」") && lastReply.includes("起跑 06:30") && /露點/.test(lastReply);
  await shot("chat");

  step = "模型看不到地點";
  const llm = (await requests()).filter((r) => r.kind === "llm").map((r) => JSON.stringify(r.body));
  check.modelNeverSeesPlace = llm.length > 0 && llm.every((t) => !t.includes("台北市") && !t.includes("121.6") && !t.includes("Mock City"));
  check.systemHint = llm.some((t) => t.includes("已設定地點（可查比賽日天氣）") && t.includes("get_race_weather"));

  step = "清除地點";
  await E2E.go(page, "計畫");
  await row.getByRole("button", { name: "編輯" }).click();
  check.editKeepsValues = (await races.getByLabel("起跑時間（選填）").inputValue()) === "06:30" && (await races.locator(".race-place").innerText()).includes("目前：台北市");
  await races.getByRole("button", { name: "清除地點" }).click();
  await races.getByRole("button", { name: "儲存變更" }).click();
  await page.waitForTimeout(500);
  check.placeCleared = !(await row.innerText()).includes("台北市") && (await row.innerText()).includes("06:30 起跑");
  await E2E.go(page, "對話");
  await page.waitForTimeout(800);
  check.feedGone = (await page.locator(".feed-title", { hasText: /^比賽日的天氣/ }).count()) === 0;
  check.noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);

  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error(`FAILED at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
  process.exit(1);
});
