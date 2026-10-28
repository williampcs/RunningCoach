// 驗證選手頁的重整（規格 12.30 第 1 點）：我的數字＋五列的摘要、點進去改了就存、「從其他 AI 帶入」的入口
// （五列上方、目標／個人最佳／身體的最上面、計畫頁的賽事旁）、紀錄頁的軌道上切換里程碑
const E2E = require("./env.cjs");
const { chromium } = E2E;

let step = "start";
(async () => {
  const browser = await chromium.launch();
  const problems = [];
  const check = {};
  for (const mobile of [true, false]) {
    const tag = mobile ? "mobile" : "desktop";
    const context = await browser.newContext({
      ...(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } }),
      timezoneId: "Asia/Taipei",
    });
    const page = await context.newPage();
    page.on("console", (m) => (m.type() === "error" || m.text().includes("Content Security Policy")) && problems.push(`[${tag} ${step}] ${m.text()}`));
    page.on("pageerror", (e) => problems.push(`[${tag} ${step}] pageerror: ${e.message}`));
    page.on("dialog", (d) => void d.accept());
    const c = {};
    const list = page.locator(".profile-list");
    const row = (name) => list.getByRole("button", { name, exact: true });
    const back = () => page.locator(".profile-subpage .back-button").click();
    const importButton = () => page.getByRole("button", { name: "從其他 AI 帶入" });
    try {
      step = "設定與同步";
      await page.goto(E2E.URL);
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.setupMock(page, { mock: E2E.MOCK });
      await E2E.go(page, "回報");
      await page.getByRole("button", { name: /同步/ }).last().click();
      await page.locator(".toast, .notice", { hasText: /同步完成|已是最新/ }).first().waitFor({ timeout: 30000 });

      step = "第一層";
      await E2E.profile(page);
      await page.locator(".my-numbers").waitFor({ timeout: 10000 });
      c.myNumbers = (await page.locator(".my-numbers").innerText()).includes("我的數字");
      c.fiveRows = JSON.stringify(await list.locator(".list-row-title").allInnerTexts()) === JSON.stringify(["目標", "練什麼、怎麼練", "個人最佳", "身體", "教練記得的事"]);
      c.emptyRows = (await list.locator(".list-row-sub .not-filled", { hasText: "還沒填" }).count()) >= 4;
      c.importOnList = (await list.locator(".profile-list-head").getByRole("button", { name: "從其他 AI 帶入" }).count()) === 1;
      c.noSaveButton = (await page.getByRole("button", { name: "儲存選手資料" }).count()) === 0;
      c.noRegionHere = (await page.getByLabel("紀錄頁的里程碑").count()) === 0;
      for (const scheme of ["light", "dark"]) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.screenshot({ path: `${E2E.OUT}/profile-${tag}-${scheme}.png`, fullPage: true });
      }
      await page.emulateMedia({ colorScheme: "light" });

      step = "我的數字的下一層";
      await page.getByRole("button", { name: /^我的數字/ }).click();
      c.valuesPage = await page.locator(".profile-subpage section.training-values").waitFor({ timeout: 10000 }).then(() => true, () => false);
      await back();

      step = "目標：改了就存";
      await row("目標").click();
      c.goalImport = (await page.locator(".profile-subpage").getByRole("button", { name: "從其他 AI 帶入" }).count()) === 1;
      await E2E.profileSave(page, () => page.getByLabel("長期目標").fill("全馬破四"));
      await E2E.profileSave(page, () => page.getByLabel("每週目標里程（km）").fill("40"));
      c.savedToast = await page.locator(".toast", { hasText: "已儲存" }).first().isVisible();
      if (mobile) await page.screenshot({ path: `${E2E.OUT}/profile-goal-${tag}.png` });
      await back();
      c.goalSummary = (await row("目標").innerText()).includes("全馬破四 · 每週 40 km");

      step = "個人最佳、身體";
      await row("個人最佳").click();
      c.pbImport = (await page.locator(".profile-subpage").getByRole("button", { name: "從其他 AI 帶入" }).count()) === 1;
      await E2E.profileSave(page, () => page.getByLabel("半馬").fill("1:52:10"));
      await back();
      c.pbSummary = (await row("個人最佳").innerText()).includes("半馬 1:52:10");
      await row("身體").click();
      c.bodyImport = (await page.locator(".profile-subpage").getByRole("button", { name: "從其他 AI 帶入" }).count()) === 1;
      await E2E.profileSave(page, () => page.getByLabel("最大心率（實測）").fill("190"));
      // 長文字的欄位按 Enter 就是打完了（存起來、不換行）
      await page.getByLabel("舊傷與長期要注意的").fill("右膝舊傷");
      await E2E.profileSave(page, () => page.getByLabel("舊傷與長期要注意的").press("Enter"));
      await back();
      c.bodySummary = (await row("身體").innerText()).includes("最大心率 190 · 右膝舊傷");

      step = "練什麼、怎麼練";
      await row("練什麼、怎麼練").click();
      c.trainingImportNotHere = (await page.locator(".profile-subpage").getByRole("button", { name: "從其他 AI 帶入" }).count()) === 0;
      await E2E.profileSave(page, () => page.locator("label", { hasText: /^強度/ }).locator("select").selectOption("moderate"));
      c.moreCollapsed = (await page.locator(".profile-more[open]").count()) === 0 && (await page.getByText("其他會做的運動").isHidden());
      await back();
      c.trainingSummary = (await row("練什麼、怎麼練").innerText()).includes("適度");

      step = "教練記得的事";
      await row("教練記得的事").click();
      c.memoriesHere = (await page.locator(".profile-subpage section.memories").count()) === 1;
      await back();

      step = "重新整理後還在";
      await page.reload();
      await page.locator("nav.tabbar button").first().waitFor();
      await E2E.profile(page);
      await page.waitForFunction(() => document.querySelector(".profile-list")?.textContent.includes("全馬破四"), null, { timeout: 10000 });
      c.persisted = (await row("身體").innerText()).includes("右膝舊傷") && (await row("練什麼、怎麼練").innerText()).includes("適度");

      step = "從其他 AI 帶入：從目標打開，取消後回到目標";
      await row("目標").click();
      await page.locator(".profile-subpage").getByRole("button", { name: "從其他 AI 帶入" }).click();
      c.importOpened = (await page.locator(".profile-subpage .title").innerText()) === "從其他 AI 帶入" && (await page.getByRole("button", { name: "複製提示詞" }).isVisible());
      await page.getByRole("button", { name: "取消" }).click();
      c.importBackToGoal = (await page.locator(".profile-subpage .title").innerText()) === "目標";
      await back();

      step = "從其他 AI 帶入：計畫頁的賽事旁";
      await E2E.go(page, "計畫");
      const races = page.locator("section#races");
      await races.getByRole("button", { name: "從其他 AI 帶入" }).click();
      await races.getByLabel("整理好的內容").fill("我的目標是全馬破四，10K 48:30，明年有一場城市馬拉松");
      await races.getByRole("button", { name: "整理" }).click();
      await races.getByText("確認要帶入的資料").waitFor({ timeout: 30000 });
      // 確認的畫面照舊列出全部（選手資料、賽事、課表）
      const review = await races.innerText();
      c.planImportListsAll = review.includes("選手資料") && review.includes("未來賽事") && review.includes("設為本週課表");
      if (mobile) await races.screenshot({ path: `${E2E.OUT}/profile-plan-import-${tag}.png` });
      await races.getByRole("button", { name: "取消" }).click();
      c.planImportClosed = (await races.getByRole("button", { name: "新增賽事" }).isVisible()) && (await races.getByText("確認要帶入的資料").count()) === 0;

      step = "紀錄頁的軌道上切換里程碑";
      await E2E.go(page, "紀錄");
      const picker = page.locator("section.totals").getByLabel("紀錄頁的里程碑");
      await picker.waitFor({ timeout: 10000 });
      c.regionChoices = JSON.stringify(await picker.locator("option").allInnerTexts()) === JSON.stringify(["通用", "依時區自動判斷", "台灣"]);
      await picker.selectOption("TW");
      c.regionTaiwan = await page.locator(".journey-origin", { hasText: "環島：從基隆出發" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
      if (mobile) await page.locator("section.totals .totals-hero").screenshot({ path: `${E2E.OUT}/profile-region-${tag}.png` });
      await picker.selectOption("");
      c.regionGeneral = await page.locator(".journey-stations li", { hasText: "全馬" }).waitFor({ timeout: 5000 }).then(() => true, () => false);
      c.noOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
    } catch (e) {
      console.error(`FAILED [${tag}] at [${step}]:`, e.message.split("\n").slice(0, 3).join(" | "));
      c.completed = false;
    }
    for (const [k, v] of Object.entries(c)) check[`${tag}.${k}`] = v;
    await context.close();
  }
  check.noConsoleErrors = problems.length === 0;
  console.log(JSON.stringify(check, null, 1));
  if (problems.length) console.log(problems.join("\n"));
  const ok = Object.values(check).every(Boolean);
  console.log(ok ? "ALL OK" : "SOME CHECKS FAILED");
  await browser.close();
  process.exit(ok ? 0 : 1);
})();
