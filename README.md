# Running Coach 🏃

AI 跑步教練。用自然語言對話，教練會結合 **Intervals.icu 的客觀數據**與**你自己的主觀感受**，給出個人化的訓練建議、賽事規劃與跑後分析。

核心是一套 **五層記憶架構**：在有限的 context window 內維持長期記憶（選手資料、訓練歷史、賽事目標、對話重點），並透過 **Tool Use** 按需載入資料，把每次呼叫的 token 用量壓到最低。

> 這是 v2（TypeScript）：資料留在使用者裝置的網頁版、可選的訂閱代理，以及自建的 Discord bot。
> 作者自己的 Discord bot 自 2026-10-15 起改由 v2 部署；上線前沒有先以真實的 API key 測試，進度與尚未驗證的部分見 [v2 規格第 9 節](doc/running-coach-spec2_0.md)。網頁版與代理還沒有部署。
> v1 是 Python 的 Discord bot，規格見 [running-coach-spec1_4.md](doc/running-coach-spec1_4.md)，最後一版是 commit `62ae45f`。

---

## ✨ 特色

- **對話式教練**：例如「今天跑完 10K，體感 7/10，右膝有點緊」，教練會抓取跑步活動、合併主觀感受、產生分析並存檔。
- **資料留在你的裝置**：網頁版的資料庫存在瀏覽器裡（SQLite／OPFS），金鑰也只存在瀏覽器。作者的伺服器不保存對話與訓練資料。
- **兩種使用 AI 的方式**：
  - **自備 key**：Claude、OpenAI、Gemini 或其他 OpenAI 相容服務，由瀏覽器直接連線。
  - **訂閱**：經作者的薄代理轉發，只提供 Claude；代理只記帳號與用量，不留內容。
- **五層記憶 + 按需載入**：訓練歷史與計畫不常駐 context，由模型視對話需要呼叫工具讀取。
- **逐字串流**：思考時顯示「思考中」，執行工具時顯示正在做的事，文字一產生就顯示。
- **透明**：設定頁依模式與供應商列出資料會送到哪裡，確認後才能開始對話。
- **可以自建 Discord bot**：同一份核心，跑在你自己的機器上。

---

## 🧠 五層記憶架構

每次呼叫模型時，`packages/core/src/context.ts` 組合以下五層：

| 層 | 內容 | 載入方式 |
|----|------|----------|
| **層 1** — System Prompt | 當前日期/時區、選手資料、心率區間、近期賽事 | 常駐（動態組合） |
| **層 2** — 訓練歷史摘要 | 最近數筆訓練的 AI 分析摘要 | 按需（`get_recent_workouts` 工具） |
| **層 3** — 訓練計畫 | 當前啟用中的週訓練計畫 | 按需（`get_training_plan` 工具） |
| **層 4** — 對話摘要 | 壓縮後的歷史對話重點 | 常駐（壓縮後產生） |
| **層 5** — Rolling Window | 尚未壓縮的原始對話 | 常駐 |

對話超過上限時，背景把較舊的對話壓縮成結構化摘要，不阻塞主回應。

---

## 🏗️ 架構

```
                    packages/core（共用核心，Coach 類別）
                 不碰任何平台 API，只用 fetch 和 Anthropic SDK
          ┌───────────────────┼───────────────────┐
     apps/discord          apps/web            apps/proxy
     Node，自建用           瀏覽器              Node／Cloudflare Workers
     discord.js            React + Vite        只轉發 LLM 請求、記用量
     better-sqlite3        sqlite-wasm（OPFS）
```

| 路徑 | 內容 |
|------|------|
| `packages/core` | 共用核心：agent 迴圈、五層記憶、對話壓縮、13 個工具、Intervals.icu 串接、LLM 轉接層（Claude／OpenAI 相容）、SQL schema |
| `packages/sqlite-node` | Node 的 SQLite 儲存驅動 |
| `apps/web` | 網頁版 |
| `apps/discord` | 自建用的 Discord bot |
| `apps/proxy` | 訂閱用的薄代理 |
| `tools/mock-upstream.ts` | 本機開發用的模擬 LLM 與 Intervals.icu |

核心只透過幾個介面接觸外界（儲存驅動、LLM 供應商、活動來源、時鐘與時區），各外殼各自實作。資料庫 schema 與 v1 相容，v1 的 `coach.db` 可以直接使用。

---

## 🚀 本機開發

需要 Node.js 22 以上。

```bash
npm install
npm test
npm run typecheck
```

**不需要任何金鑰**就能把整條流程跑起來。開三個終端機：

```bash
npm run dev:mock                                # 模擬上游（LLM 與 Intervals.icu），埠 8788
npm run dev:mock -w @running-coach/proxy        # 薄代理，上游指向模擬服務，埠 8787，管理憑證 dev-admin
npm run dev:mock -w @running-coach/web          # 網頁版，Intervals.icu 指向模擬服務，埠 5173
```

在代理上建立一個測試帳號，取得訂閱憑證：

```bash
curl -X POST -H 'authorization: Bearer dev-admin' http://127.0.0.1:8787/admin/accounts
```

打開 http://localhost:5173 ，到「設定」選「訂閱（經代理）」，代理網址填 `http://localhost:8787`，貼上憑證，勾選資料流向後儲存。Intervals.icu 的 API key 隨意填即可。

想不經代理、測試 OpenAI 相容的路徑：設定頁選「使用自己的 API key」→「其他 OpenAI 相容服務」，服務網址填 `http://127.0.0.1:8788/v1`，API key 與模型隨意填。

---

## 🌐 網頁版

```bash
npm run dev -w @running-coach/web      # 連真實服務
npm run build -w @running-coach/web    # 建置到 apps/web/dist
```

- 建置結果是靜態檔案，不需要後端。瀏覽器的 OPFS 只在 HTTPS（或 localhost）下可用。
- 作者的版本由 GitHub Actions 發布到 Cloudflare Pages（網址設在 repo 的 Variables：`WEB_URL`）。原本的 GitHub Pages 已經收掉（見 [KI-026](doc/known-issues.md)、規格 12.13）。
- 可選的建置變數：`VITE_PROXY_URL`（設定頁預填的代理網址）、`VITE_INTERVALS_BASE_URL`（改連其他 Intervals.icu 端點，開發用）。
- 資料只存在這個瀏覽器。同時開第二個分頁時，第二個分頁只能用暫時性的記憶體資料庫（畫面上會有警告）。換裝置或清除網站資料前，請在設定頁匯出資料庫；匯入也接受 v1 的 `coach.db`。
- 設定頁底部有原始碼連結（AGPL-3.0 第 13 條）。部署修改過的版本時，請把 `apps/web/src/views/Settings.tsx` 的 `SOURCE_URL` 改成你的版本。

---

## 🤖 自建 Discord bot

功能與 v1 相同：在指定頻道直接對話，加上幾個 slash 指令。只支援自備 key。

```bash
cp .env.example .env    # 填入 Discord、Intervals.icu、LLM 的設定
npm run dev -w @running-coach/discord
```

用 Docker（以 repo 根目錄為 context）：

```bash
docker build -f apps/discord/Dockerfile -t running-coach-bot .
docker run -d --env-file .env -v "$PWD/data:/app/data" running-coach-bot
```

或用 docker compose 拉取 GHCR 上預先建好的公開映像（作者的 VM 就是這樣部署，見 [KI-025](doc/known-issues.md)）：

```bash
docker compose pull && docker compose up -d
```

環境變數名稱沿用 v1，v1 的 `.env` 與 `data/coach.db` 可以直接用；但 `docker run --env-file` 不會去掉行尾的「# …」註解，要先把註解移到獨立一行。各變數的說明見 [.env.example](.env.example)。

| 指令 | 說明 |
|------|------|
| `/sync` | 從 Intervals.icu 同步最近的活動，合併暫存的主觀感受 |
| `/plan <content>` | 更新本週訓練計畫 |
| `/profile <key> <value>` | 更新選手資料欄位 |
| `/status` | 顯示模型設定與各記憶層狀態 |

一般訊息範例：

- 「幫我記下 3/15 的萬金石半馬，目標破二」→ 新增賽事
- 「剛跑完 8K，體感 6，腿有點重」→ 抓跑步活動並存檔分析
- 「我最近配速有進步嗎？」→ 計算週平均配速趨勢
- 「幫我排這週的課表」→ 結合選手資料與訓練歷史制定計畫

---

## 🔁 薄代理（訂閱）

訂閱者以代理發的憑證取代 API key，其餘與直連 Anthropic 相同。每次請求依序驗證憑證、檢查頻率與額度、只轉發白名單內的欄位、累計用量；請求與回應內容只在記憶體中經過。

| 端點 | 用途 |
|------|------|
| `POST /v1/messages` | 轉發（含串流） |
| `GET /v1/usage` | 訂閱者查詢本月用量與額度 |
| `POST /admin/accounts` | 建立帳號，回傳憑證（只出現這一次） |
| `GET` / `PATCH /admin/accounts/:id` | 查詢帳號；停用（`status`）或調整每月預算（`monthly_budget_usd`） |
| `POST /admin/accounts/:id/rotate-token` | 重發憑證 |

管理端點以 `ADMIN_TOKEN` 驗證，供帳號與金流服務（不在本 repo）呼叫。

```bash
cp apps/proxy/.env.example apps/proxy/.env
npm run dev -w @running-coach/proxy
```

設定說明見 [apps/proxy/.env.example](apps/proxy/.env.example)。**預設的模型價格與每月 3 美元預算只是佔位**，上線前要依現行價目與定價調整。Cloudflare Workers 進入點（用量存在 D1）只通過型別檢查，還沒有實際部署，見 `apps/proxy/wrangler.toml`。

---

## 🛠️ 技術棧

- **TypeScript**（npm workspaces）
- **[Anthropic Claude](https://www.anthropic.com/)**（官方 SDK）與 OpenAI 相容的 Chat Completions
- **React + Vite**，**[SQLite WASM](https://sqlite.org/wasm)**（OPFS）
- **[discord.js](https://discord.js.org/)**，**better-sqlite3**
- **[Intervals.icu API](https://intervals.icu/)**：跑步活動資料來源（支援 Garmin／Coros／Wahoo 等手錶）
- **Vitest**、**esbuild**、**GitHub Actions**（CI：型別檢查、測試、建置、Discord 映像）

---

## 📐 文件

- [running-coach-spec2_0.md](doc/running-coach-spec2_0.md)：v2 規格。第 9 節是進度、尚未驗證的部分與下一步，第 11 節是待決定事項
- [known-issues.md](doc/known-issues.md)：決策與問題紀錄（KI 編號）
- [running-coach-spec1_4.md](doc/running-coach-spec1_4.md)：v1 規格；`doc/` 也保留了 v1.0 到 v1.4 的演進
- [deployment-guide.md](doc/deployment-guide.md)：v1 的部署指南（GCP VM）

`src/`、`scripts/`、根目錄的 `Dockerfile` 與 `requirements.txt` 是 v1 的 Python 版，等自己的 bot 切換到 v2、觀察一段時間後移除。

---

## 📄 授權

Copyright (C) 2026 William

本專案自 v2 起採用 GNU Affero General Public License v3.0（`AGPL-3.0-only`，見 [LICENSE](LICENSE)）。你可以自由使用、修改與散布；若散布修改後的版本，或以修改後的版本對外提供網路服務，必須以相同授權公開對應的原始碼。本程式不附任何擔保。

v1.4 與更早的版本（commit `62ae45f` 為止）是以 MIT License 釋出，那些版本的授權不受影響。
