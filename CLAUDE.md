# Running Coach

AI 跑步教練。TypeScript 版（`packages/`、`apps/`）於 2026-10-15 由 `v2` 合併到 `main`，自建的 Discord bot 以 GHCR 映像部署到 VM（KI-025），網頁版在 Cloudflare Pages（12.13，正式版 `app.zone2mate.com`），多裝置同步服務在 Cloudflare Workers（12.10）；另有一套 staging（`staging.zone2mate.com`，12.19）。v1 的 Python 程式（`src/`）保留到觀察期結束後移除。

## 必須遵守

- **不要 push 或合併到 `main`。** push 到 `main` 會觸發部署：bot 用到的檔案有改動時重新部署 Discord bot（`doc/known-issues.md` 的 KI-025），網頁版或核心有改動時發布網頁版（KI-026）；何時部署由使用者決定。開發在 `v2` 分支：push 到 `v2` 只會更新 staging（網頁版與 staging 自己的同步服務，資料和正式的分開，12.19），不碰正式環境；其他分支的 push 不會觸發部署。
- **這個 repo 是公開的。** 金鑰、個人的訓練與生理資料、主機名稱與登入資訊都不要寫進會進版控的檔案。使用者家目錄的路徑也不要寫進去。
- 使用者貼過的 API key 不要在回覆裡重複。workflow 不可以把 secrets 印出來。
- 使用者真實的訓練資料不進雲端 session；需要真實資料的驗證由使用者在本機跑腳本。
- commit、PR 與程式裡不寫模型的名稱。
- 回覆使用者用繁體中文。

## 協作方式：協調 session 與開發 session

使用者和一個長期的**協調 session** 討論，開發交給**開發 session**。

**協調 session**（討論與分派）
- 接使用者的想法、覺得哪裡怪的地方、要不要做的問題；查程式回答現況，提出建議，和使用者討論到有決定。
- 把討論與決定寫進文件（見下面的「紀錄方式」），要開發的寫成工作單，放在規格 9.4 的「已決定、待開發」。
- 決定誰做：只改文件的自己做；要改程式的開一個開發 session（有 session 工具時直接建立並交付工作單，否則請使用者開），告訴使用者是哪一個。
- 原則上不改程式；很小或緊急的修正例外，要說明。
- 開發 session 回報後，檢查結果、更新工作單的狀態，再回覆使用者。

**開發 session**（一次一個主題）
- 開始時讀：本檔、規格第 9 節（進度、下一步、接手須知）、工作單指到的章節。工作單沒寫清楚的，先問協調 session 或使用者，不要自己猜大方向。
- 開發在 `v2`，開始前先 `git pull`。做完：`npm test`、`npm run typecheck`、網頁實測（`tools/e2e/README.md`）、更新文件，commit 並推到 `v2`。推上去後 staging 會自動更新，回報時請使用者在 staging 試。
- 回報：做了什麼、怎麼驗證的、沒驗證到的、使用者要做的事。
- 發現工作單以外的問題：記到規格 9.4 或 KI，回報時提出，不要順手擴大範圍；明顯的錯誤可以修，但要在回報裡說。

**共同規則**
- 同一時間只有一個開發 session 改程式並推 `v2`；協調 session 推文件前先 `git pull`。
- 一個主題做完、合併部署後，下一個大主題開新的開發 session，避免 context 壓縮後細節不足。

## 紀錄方式

- `doc/running-coach-spec2_0.md`（v2 規格）
  - 開頭的版本異動表：每個推上 `v2` 的改動一行，寫日期、改了什麼、對應章節。
  - 第 9 節：9.1 進度、9.3 本機開發、9.4 下一步（工作單）、9.5 接手須知。
  - 第 11 節：待決定事項總表（編號延續；決定後劃掉標題，寫結論與日期）。
  - 第 12 節：各主題的討論與決定（12.x，編號延續）：使用者的問題與原話重點、選項、決定、實作、驗證、沒做的。
- `doc/known-issues.md`：問題與決策紀錄，KI 編號延續。寫：發現時機、狀態、原因、修正或決定、驗證、使用者要做的。
- 記下使用者的理由（例如「一長串 DNF 會讓人挫折」），之後的決定才有依據。
- 要保留的都要 commit 並推到 `v2`：雲端的容器用完就回收，scratchpad 與聊天內容都會消失。

工作單的格式（規格 9.4）：標題、對應章節、要做什麼、不做什麼、驗收方式（測試、E2E 腳本）、注意事項、狀態（待開發／開發中（哪個 session）／已推上 v2／已部署）。

## staging 與正式環境

流程：開發 session 推 `v2` → staging（`staging.zone2mate.com`）自動更新（`.github/workflows/staging.yml`）→ 使用者在 staging 實際試 → 使用者說「合併部署」→ 正式環境（`app.zone2mate.com`）。緊急修正一樣走這條。

- staging 的網頁版是另一個 Pages 專案，同步服務是另一個 Worker 與 D1：在 staging 試的資料不碰正式的；網頁上標示「Staging」。
- 兩個環境的網址、專案名稱、D1 的 id 都在 GitHub 的 Variables（規格 12.19 有清單），不寫進 repo。
- 改同步服務允許的來源要特別小心：設錯了，那個網址的同步就會失敗。

## 合併部署

只有使用者說「合併部署」時才做；授權只限那一次，之後的改動仍要等使用者再說。合併前確認使用者已經在 staging 試過這一版（沒試過的要在回報裡說）。

每次合併部署就是發一版（規格 12.19）。版號只有一個來源：repo 根目錄 `package.json` 的 `version`，網頁版（標題列的 Beta、設定頁最下面的完整版號）與 Discord bot（`/status`）都讀它。

1. 發版（在 `v2` 上，建 PR 之前）：
   - 決定版號：看上一個標籤之後的改動（`git log v上一版..origin/v2 --oneline` 與版本異動表）。
     - 有新功能（使用者看得到的新東西：新的畫面、設定、指令、教練會做的新事）→ 加**中間那碼**：`npm run version:bump -- minor`（0.1.0 → 0.2.0）。
     - 只有修錯誤、文字或版面微調、文件、內部整理 → 加**最後一碼**：`npm run version:bump -- patch`（0.2.0 → 0.2.1）。
     - 兩種都有就加中間那碼。第一碼（1.0.0）只在使用者說要正式給大家用時才加。
     - 第一次發版（還沒有任何標籤）版號已經是 0.1.0，不用改。
   - 指令會一起改根目錄、各套件的 `package.json` 與 `package-lock.json`；不要手改。
   - 規格開頭的版本異動表加一行：「發版 vX.Y.Z：這一版的內容（使用者看得懂的幾點）」。
   - `npm test`、`npm run typecheck`，commit（`release: vX.Y.Z`）並推到 `v2`。
2. 建 PR：`v2` → `main`，標題帶版號，說明改了什麼與怎麼驗證的。
3. 在背景輪詢那個 commit 的 check runs，等 CI 全部成功。
4. 合併：merge method 用 `merge`（不要 squash），帶完整 40 字元的 head SHA（`git rev-parse HEAD`）。
5. 標籤：合併後由 workflow「Tag release」（`.github/workflows/tag-release.yml`）依 `package.json` 的版號在合併的 commit 自動打 `vX.Y.Z`，不用手動打（雲端 session 的 git 只能推自己的分支，推不了標籤）。在下一步確認它成功；漏掉時手動執行它（不指定 commit 就是 `main` 最新的 commit）。補打更早的 commit 常會失敗：那個 commit 的 workflow 檔和現在的 `main` 不同時，GitHub 不讓 workflow 推指向它的標籤（規格 12.19），這時請使用者在本機打。標籤不觸發部署；部署失敗要重來時不改標籤，修好後發下一個 patch 版。
6. 在背景輪詢合併後 commit 的 workflow runs（Deploy web app、Deploy sync service、Deploy Discord bot、Tag release），失敗時看 job log，回報結果（含這一版的版號）與使用者要確認的事。

## 文件入口

- `doc/running-coach-spec2_0.md`：v2 規格。第 9 節是進度、下一步與接手須知；第 11 節是待決定事項；第 12 節是各主題的討論與決定。
- `doc/known-issues.md`：決策與問題紀錄（KI 編號），新的決策接續編號寫在這裡。
- `doc/architecture.md`：架構說明：組成、技術、核心的分層、資料存在哪裡、schema 與資料的關聯、同步、部署。程式有大改時一起更新。
- `tools/e2e/README.md`：網頁實測的做法與腳本。
- `doc/running-coach-spec1_4.md`：v1 規格。

## 指令（v2）

```bash
npm install
npm test
npm run typecheck
```

沒有金鑰時以模擬服務開發與測試，啟動方式見規格 9.3；網頁實測見 `tools/e2e/README.md`。
