# Running Coach 🏃

一個運行在 Discord 上的 AI 跑步教練。使用者以自然語言對話，Agent 會結合 **Intervals.icu 客觀數據**與**個人主觀感受**，提供個人化的訓練建議、賽事規劃與跑後分析。

核心設計是一套 **五層記憶架構**，讓 Claude 在有限的 context window 內維持長期記憶（選手資料、訓練歷史、賽事目標、對話重點），並透過 **Tool Use（function calling）** 按需載入資料，把每次 API 呼叫的 token 用量壓到最低。

> 個人 side project，用來實驗「LLM Agent 的記憶管理與 context 工程」在真實、持續使用的場景下該如何設計。

---

## ✨ 特色

- **對話式教練** — 直接用中文聊天，例如「今天跑完 10K，體感 7/10，右膝有點緊」，Agent 會自動抓取跑步活動、合併主觀感受、生成分析摘要並存檔。
- **五層記憶架構** — 系統提示、訓練歷史、訓練計畫、對話摘要、rolling window 分層管理，兼顧「記得住」與「不爆 token」。
- **Tool Use 按需載入** — 訓練歷史、訓練計畫等大型資料不常駐 context，由 Claude 依對話意圖自行決定何時呼叫工具讀取。
- **自動對話壓縮** — 對話超過閾值時，非同步將舊訊息壓縮成結構化摘要，不阻塞主回應。
- **Intervals.icu 整合** — 透過個人 API Key 直接串接，支援 Garmin / Coros / Wahoo 等手錶數據即時回報與 `/sync` 批次補齊。
- **GitHub Actions 自動部署 (CI/CD)** — 透過 Self-hosted Runner 實現 `git push` 後由 GCP VM 自動拉取程式碼並重啟 Docker 容器。
- **Token 用量透明化** — 每則回應附上各記憶層的 input/output token 估算，方便觀察 context 成本。

---

## 🧠 五層記憶架構

每次呼叫 Claude API 時，`context_manager` 動態組合以下五層：

| 層 | 內容 | 載入方式 |
|----|------|----------|
| **層 1** — System Prompt | 當前日期/時區、選手資料、心率區間、近期賽事 | 常駐（動態組合） |
| **層 2** — 訓練歷史摘要 | 最近數筆訓練的 AI 分析摘要 | 按需（`get_recent_workouts` tool） |
| **層 3** — 訓練計畫 | 當前啟用中的週訓練計畫 | 按需（`get_training_plan` tool） |
| **層 4** — 對話摘要 | 壓縮後的歷史對話重點 | 常駐（壓縮後產生） |
| **層 5** — Rolling Window | 最近 N 輪原始對話 | 常駐 |

層 2、層 3 刻意改為 tool 按需載入，只有在討論訓練狀態或計畫時才進入 context，避免每則閒聊都付出完整歷史的 token 成本。

---

## 🏗️ 專案結構

```
.github/
└── workflows/
    └── deploy.yml             # GitHub Actions CI/CD 自動部署工作流程

src/
├── main.py                    # 進入點：初始化 DB、啟動 Bot
├── config.py                  # 環境變數集中管理
├── bot/
│   └── discord_bot.py         # Discord 事件處理、slash 指令、訊息分段
├── agent/
│   ├── loop.py                # Agent 主迴圈：組 context、tool call 迴圈、token 統計
│   └── sync.py                # /sync：批次拉取 Intervals.icu 並合併主觀暫存
├── memory/
│   ├── db.py                  # SQLite 存取層（所有 table 與查詢）
│   ├── context_manager.py     # 五層 context 組合
│   └── summarizer.py          # 非同步對話壓縮
└── tools/
    ├── intervals_tool.py      # Intervals.icu API 連線 / 活動拉取 / 正規化
    └── training_plan_tool.py  # 訓練計畫工具

scripts/
├── test_intervals.py          # 測試 Intervals.icu API 連線與活動抓取
└── init_profile.py            # 互動式初始化選手資料

doc/                           # 開發規格書（多版本迭代）與已知問題
```

---

## 🛠️ 技術棧

- **Python 3.12**
- **[Anthropic Claude](https://www.anthropic.com/)** — Agent 推理與 Tool Use
- **[discord.py](https://discordpy.readthedocs.io/)** — Discord Bot 介面
- **[Intervals.icu API](https://intervals.icu/)** — 跑步活動資料來源（支援手錶自動同步）
- **SQLite** — 本地持久化（選手資料、訓練、對話、token）
- **Docker / docker-compose** — 容器化部署
- **GitHub Actions (Self-hosted Runner)** — 自動化 CI/CD 部署

---

## 🚀 快速開始

### 1. 前置需求

- 一個 [Discord Bot](https://discord.com/developers/applications)（需開啟 Message Content Intent）
- 一組 [Anthropic API Key](https://console.anthropic.com/)
- 一組 [Intervals.icu API Key 與 Athlete ID](https://intervals.icu/settings)（免費取得）

### 2. 設定環境變數

```bash
cp .env.example .env
# 編輯 .env，填入你的 API key 與 token
```

`.env` 已列入 `.gitignore`，不會被 git 追蹤。

### 3. 使用 Docker 執行（建議）

```bash
docker compose up -d --build
```

### 4. 首次設定

```bash
# 初始化選手資料（互動式）
docker compose run --rm coach-bot python scripts/init_profile.py

# 測試 Intervals.icu 連線
python scripts/test_intervals.py
```

> 完整部署步驟（含 GCP VM / GitHub Actions CI/CD 設定）請參考 [doc/deployment-guide.md](doc/deployment-guide.md)。

### 本機開發（不使用 Docker）

```bash
pip install -r requirements.txt
python src/main.py
```

---

## 💬 使用方式

在指定的 Discord 頻道（`DISCORD_ALLOWED_CHANNEL_ID`）直接對話即可。Slash 指令：

| 指令 | 說明 |
|------|------|
| `/sync` | 手動觸發 Intervals.icu 同步，合併主觀暫存資料 |
| `/plan <content>` | 更新本週訓練計畫 |
| `/profile <key> <value>` | 更新選手資料欄位 |
| `/status` | 顯示目前五層記憶狀態（debug 用） |

一般訊息範例：

- 「幫我記下 3/15 的萬金石半馬，目標破二」→ 新增賽事
- 「剛跑完 8K，體感 6，腿有點重」→ 抓跑步活動並存檔分析
- 「我最近配速有進步嗎？」→ 計算週平均配速趨勢
- 「幫我排這週的課表」→ 結合選手資料與訓練歷史制定計畫

---

## 📐 設計文件

- [running-coach-spec1_3.md](doc/running-coach-spec1_3.md) — 最新版規格書（v1.3）
- [known-issues.md](doc/known-issues.md) — 已知問題與設計取捨
- [deployment-guide.md](doc/deployment-guide.md) — 部署指南

`doc/` 保留了 spec v1.0 → v1.3 的多版本迭代，記錄設計思路的演進過程。

---

## 📄 授權

本專案採用 MIT License（見 [LICENSE](LICENSE)）。
