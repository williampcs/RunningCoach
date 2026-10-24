// 驗證賽事的生命週期（手機尺寸）：重複提醒、賽前／賽後的編輯、不參加了、成績（手錶紀錄的提示）、沒有完賽、刪除、教練看得到
const E2E = require("./env.cjs");
const { chromium } = E2E;

const OUT = E2E.OUT;
const URL = E2E.URL;

async function setup(page, { intervals }) {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("供應商").selectOption("openai-compatible");
  await page.getByLabel("API key", { exact: true }).first().fill("mock-key");
  await page.getByLabel("服務網址").fill(`${E2E.MOCK}/v1`);
  await page.getByLabel("主對話模型").fill("mock-model");
  if (intervals) await page.getByLabel("API key", { exact: true }).last().fill("mock-intervals-key");
  await page.getByLabel("我了解並同意以上的資料流向").check();
  await page.getByRole("button", { name: "儲存設定" }).click();
  await page.getByText("設定已儲存在這個瀏覽器。").waitFor();
}

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
const mockToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei" }).format(new Date());

(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  const page = await newPage(browser, problems);
  // 時區設成和模擬服務一樣，「今天」才對得上
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByLabel("時區").fill("Asia/Taipei");
  await setup(page, { intervals: true });
  await page.getByRole("button", { name: "同步最近 14 天" }).click();
  await page.getByText(/同步完成/).waitFor({ timeout: 30000 });

  await page.getByRole("button", { name: "計畫與賽事", exact: true }).click();
  const card = page.locator("#races");
  const addRace = async (name, date, km) => {
    await card.getByRole("button", { name: "新增賽事" }).click();
    await card.getByLabel("賽事名稱").fill(name);
    await card.getByLabel("日期").fill(date);
    await card.getByLabel("距離（km）").fill(String(km));
    await card.getByRole("button", { name: "新增", exact: true }).click();
    await card.locator(".list li").filter({ hasText: name }).first().waitFor();
  };
  const item = (name) => card.locator(".list li").filter({ has: page.locator("strong", { hasText: new RegExp(`^${name}$`) }) });

  // 1. 重複：新增時先問；列出重複的提醒；刪除後提醒消失
  await addRace("春季半馬", "2027-03-01", 21.1);
  let asked = "";
  page.once("dialog", (d) => {
    asked = d.message();
    d.accept();
  });
  await addRace("春季半程馬拉松", "2027-03-01", 21.0975);
  check.askedDuplicate = asked.includes("確定不是同一場");
  check.duplicateNotice = (await card.locator(".notice.warn").innerText()).includes("看起來重複");
  await page.screenshot({ path: `${OUT}/races-1-duplicate.png`, fullPage: true });
  page.once("dialog", (d) => d.accept());
  await item("春季半程馬拉松").getByRole("button", { name: "刪除" }).click();
  await item("春季半程馬拉松").waitFor({ state: "detached" });
  check.duplicateGone = (await card.locator(".notice.warn").count()) === 0;

  // 2. 賽前可以改全部；不參加了要選原因，之後只能改名稱與備註
  await item("春季半馬").getByRole("button", { name: "編輯" }).click();
  check.beforeRaceFullEdit = (await card.getByLabel("日期").count()) === 1;
  await card.getByRole("button", { name: "取消", exact: true }).click();
  await item("春季半馬").getByRole("button", { name: "不參加了" }).click();
  await item("春季半馬").getByLabel("原因").selectOption({ label: "受傷或生病" });
  await item("春季半馬").getByLabel("補充（選填）").fill("右膝");
  await page.screenshot({ path: `${OUT}/races-2-dns-form.png`, fullPage: true });
  await item("春季半馬").getByRole("button", { name: "確定不參加" }).click();
  // 沒有出賽、沒有完賽的收在「其他紀錄」裡，預設收起
  const other = card.locator("details.races-other");
  await other.waitFor();
  check.foldedByDefault = (await other.getAttribute("open")) === null && !(await item("春季半馬").isVisible());
  await other.locator("summary").click();
  check.foldLabel = (await other.locator("summary").innerText()) === "其他紀錄（1 場）";
  await item("春季半馬").getByText("沒有出賽（受傷或生病）").waitFor();
  check.dnsNoRestore = (await item("春季半馬").getByRole("button", { name: /不參加|記錄成績/ }).count()) === 0;
  await item("春季半馬").getByRole("button", { name: "編輯" }).click();
  check.afterOnlyNameNotes = (await card.getByLabel("日期").count()) === 0 && (await card.getByLabel("備註").count()) === 1;
  await card.getByRole("button", { name: "取消", exact: true }).click();

  // 3. 比賽當天：記錄成績時顯示手錶紀錄，可以直接用；之後可以改成沒有完賽
  await addRace("城市 10K", mockToday, 10);
  await item("城市 10K").getByRole("button", { name: "記錄成績" }).click();
  const hint = item("城市 10K").getByText(/參考手錶紀錄：/);
  await hint.waitFor();
  check.watchHint = (await hint.innerText()).includes("55:06");
  await page.screenshot({ path: `${OUT}/races-3-result-form.png`, fullPage: true });
  await item("城市 10K").getByRole("button", { name: "用這個時間" }).click();
  check.usedWatchTime =
    (await item("城市 10K").getByLabel("個人成績（淨時間）").inputValue()) === "55:06" &&
    (await item("城市 10K").getByLabel("成績來源").inputValue()) === "watch";
  // 改用晶片成績，另外填大會成績
  await item("城市 10K").getByLabel("個人成績（淨時間）").fill("55:01");
  await item("城市 10K").getByLabel("大會成績（槍聲起算，選填）").fill("55:40");
  await item("城市 10K").getByLabel("成績來源").selectOption("chip");
  await item("城市 10K").getByRole("button", { name: "儲存" }).click();
  await item("城市 10K").getByText("完賽 55:01").waitFor();
  check.finished = (await item("城市 10K").innerText()).includes("大會成績 55:40｜晶片計時");
  await page.screenshot({ path: `${OUT}/races-5-finished.png`, fullPage: true });
  await item("城市 10K").getByRole("button", { name: "修改成績" }).click();
  await item("城市 10K").getByLabel("沒有完賽").check();
  await item("城市 10K").getByLabel("說明（選填）").fill("8K 抽筋");
  await item("城市 10K").getByRole("button", { name: "儲存" }).click();
  await item("城市 10K").getByText("沒有完賽（8K 抽筋）").waitFor();
  check.dnf = (await other.locator("summary").innerText()) === "其他紀錄（2 場）";

  // 4. 還沒到的比賽不能記錄成績
  await addRace("秋季全馬", "2027-11-01", 42.195);
  check.noResultBeforeRace = (await item("秋季全馬").getByRole("button", { name: "記錄成績" }).count()) === 0;
  await page.screenshot({ path: `${OUT}/races-4-list.png`, fullPage: true });

  // 5. 教練看得到賽事頁上的所有賽事（含沒有出賽、沒有完賽的）
  await page.getByRole("button", { name: "對話", exact: true }).click();
  await page.getByPlaceholder("輸入訊息…").fill("我有哪些比賽");
  await page.getByRole("button", { name: "送出" }).click();
  const reply = page.locator(".msg.assistant").last();
  await reply.getByText("賽事頁上的賽事").waitFor({ timeout: 20000 });
  const text = await reply.innerText();
  check.coachSeesAll = ["春季半馬", "城市 10K", "秋季全馬", "沒有出賽（受傷或生病）", "沒有完賽（8K 抽筋）"].every((s) => text.includes(s));
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
