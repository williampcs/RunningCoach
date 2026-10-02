# Running Coach — 專案重構歷程、評估報告與未來產品藍圖

**文件版本**：2.0  
**整理日期**：2026-10-02  
**文件目的**：完整記錄自專案交接以來，關於資料源替換（Strava → Intervals.icu）、CI/CD 自動化部署、程式碼重構清理，以及未來打造獨立 App 的成本效益與商業模式討論成果。

---

## 目錄

1. [專案架構與記憶機制回顧](#一專案架構與記憶機制回顧)
2. [Strava 替代方案評估：Intervals.icu vs. Runalyze](#二strava-替代方案評估intervalsicu-vs-runalyze)
3. [伺服器架構決策與手機端可行性](#三伺服器架構決策與手機端可行性)
4. [Intervals.icu 遷移實作與歷史相容設計](#四intervalsicu-遷移實作與歷史相容設計)
5. [GitHub Actions CI/CD 免費自動化部署](#五github-actions-cicd-免費自動化部署)
6. [程式碼清理與歷史債務排除 (ADR)](#六程式碼清理與歷史債務排除-adr)
7. [商業 App 轉型與 Token 成本優化深度評估](#七商業-app-轉型與-token-成本優化深度評估)
8. [未來產品發展路線圖 (Roadmap)](#八未來產品發展路線圖-roadmap)

---

## 一、專案架構與記憶機制回顧

### 1.1 核心設計目標
本專案為一人工智慧跑步教練，旨在解決大型語言模型（LLM）在持續對話下的**「記憶衰退（Context Rot）」**與**「Token 成本失控」**問題。

### 1.2 五層記憶架構 (Context Engineering)
每次向 Claude API 發起請求時，Context Manager 動態組裝五層上下文：

| 層次 | 內容說明 | 載入機制 | 目的與成效 |
| :--- | :--- | :--- | :--- |
| **層 1（System Prompt）** | 當前日期/時區/星期、選手生理資料（年齡、身高、體重、心率區間 Z1~Z5 由 Python 計算好注入）、90天內近期目標賽事。 | 每次請求常駐 | 提供個人化客製基底，不浪費 LLM 算力計算心率區間。 |
| **層 2（訓練歷史摘要）** | 最近數筆跑步的 AI 評估分析摘要。 | **Tool 按需載入** (`get_recent_workouts`) | 避免每則閒聊都攜帶龐大歷史數據，需討論訓練時才讀取。 |
| **層 3（當前訓練計畫）** | 當前啟用中的本週課表內容。 | **Tool 按需載入** (`get_training_plan`) | 審視、對比或調整課表時由模型主動呼叫載入。 |
| **層 4（對話摘要）** | 壓縮後的歷史重點（訓練狀態、重要決策、待追蹤事項）。 | 每次請求常駐 | 提取長對話精華，避免遺忘前期重要決策。 |
| **層 5（Rolling Window）** | 最近 N 輪原始對話（預設保留 10 輪）。 | 每次請求常駐 | 維持即時對話連貫性；單則訊息超長時自動截斷至 600 字，防止 Context 暴增。 |

### 1.3 核心技術棧
* **語言與框架**：Python 3.12、`discord.py`、`anthropic` Python SDK
* **推理模型**：Claude Sonnet 4.5 (`claude-sonnet-4-5`)
* **資料儲存**：SQLite（開啟 WAL 模式，資料永久留存於本地 `coach.db`）
* **容器化與部署**：Docker、Docker Compose、GCP Compute Engine (VM)

---

## 二、Strava 替代方案評估：Intervals.icu vs. Runalyze

### 2.1 評估背景
Strava 於 2024 年底起調整開發者條款，並於 2026 年正式實施新政策：
1. 強制 Standard 級別個人開發者綁定付費訂閱會員。
2. 嚴格禁止第三方將 Strava 活動資料傳輸給 AI 或機器學習模型處理。
導致原專案之 Strava API 資料鏈斷裂，必須選定新數據平台替代。

### 2.2 兩大耐力運動平台橫向對比

| 評估維度 | **Intervals.icu**（⭐ 最終獲選） | **Runalyze** |
| :--- | :--- | :--- |
| **API 存取與計費** | **完全免費**。提供個人專屬 API Key（Basic Auth），每日額度高達 5,000 次，每 15 分鐘 2,500 次。 | **讀取需付費**。免費帳號僅開放 Write（匯入），**無法透過 API 讀取活動資料**；需訂閱 Supporter/Premium（約 €2.5~€5/月）。 |
| **手錶原廠同步** | 支援 Garmin Connect、Coros、Wahoo、Suunto 自動推播。手錶跑完自動同步至雲端。 | 支援 Garmin Connect 等平台自動同步。 |
| **運動科學數據深度** | 極高：<br>• 基本跑量、配速、心率、爬升、卡路里<br>• Laps 間歇分段與秒級 Streams 時序數據<br>• **體能疲勞模型：Fitness (CTL)、Fatigue (ATL)、Form (TSB)**<br>• **Wellness 數據：靜息心率、HRV、睡眠品質** | 高：<br>• Effective VO2max 趨勢計算<br>• Marathon Shape 馬拉松完賽能力預估<br>• TRIMP 訓練衝量算法 |
| **資料安全與隱私** | • **伺服器設於德國 Hetzner 資料中心**<br>• **受歐盟 GDPR 與德國 BDSG 法律嚴格監管**<br>• 預設所有活動與健康指標為 Private<br>• 無 Google Analytics/Meta 商業廣告追蹤（採開源 Umami）<br>• 創立至今**零資料外洩不良紀錄** | • 伺服器位於德國，遵守 GDPR<br>• 德國團隊維運，隱私合規良好 |
| **串接複雜度** | 極低。靜態 API Key，免去 OAuth Redirect 伺服器與 Refresh Token 維護。 | 中等。Token 需綁定付費帳號，讀取 API 演進中。 |

---

## 三、伺服器架構決策與手機端可行性

### 3.1 當初使用 GCP VM 的歷史背景
1. **已有閒置資源**：規格書（Section 9.3）記載「已有閒置 VM，無額外費用」，邊際硬體成本為 0。
2. **Discord Gateway 連線需求**：`discord.py` 需透過 WebSocket Gateway 24/7 維持長連線傾聽事件，需常駐背景行程（Daemon），不適合按次計費的 Serverless（如 Cloud Functions）。
3. **本地 SQLite 檔案持久化**：追求單純穩定，避免每月花費數十美元租用託管雲端資料庫（Cloud SQL）。

### 3.2 轉向「純手機端 App」之深度評估

若未來脫離 GCP VM，以跨平台框架（如 Flutter）重構成純客戶端應用：

* **架構優勢**：
  1. **零伺服器維護成本**：不需要管理 Linux VM、Docker 重啟、安全更新與固定主機租金。
  2. **數據自主權與隱私保障**：可直接讀取手機系統內建的 **Apple HealthKit (iOS)** 或 **Health Connect (Android)**，不需經過任何第三方雲端轉發，資料 100% 留存手機本地 SQLite。
  3. **UI/UX 表現力飛躍**：擺脫 Discord 純文字限制，可原生繪製心率區間圓餅圖、配速高程時序圖、課表打卡日曆。
* **技術挑戰**：
  1. **背景推播限制**：行動作業系統對背景常駐有嚴格電量控管，無法隨意在伺服器端定時主動喚醒，需依賴 Local Notifications 或用戶開 App 時觸發。
  2. **跨裝置資料同步**：若無中央伺服器，需實作 iCloud / Google Drive 備份與同步機制。

---

## 四、Intervals.icu 遷移實作與歷史相容設計

### 4.1 核心實作清單
1. **配置環境變數**：
   * 移除舊有 `STRAVA_CLIENT_ID` / `STRAVA_CLIENT_SECRET`。
   * 新增 `INTERVALS_API_KEY` 與 `INTERVALS_ATHLETE_ID`（預設為 `"0"`）。
2. **工具模組實作 ([`src/tools/intervals_tool.py`](file:///Users/williampcs0203/projs/running_coach/src/tools/intervals_tool.py))**：
   * 使用 HTTP Basic Auth（用戶名固定為 `API_KEY`，密碼為使用者的 API Key）。
   * `fetch_latest_activity()`：查詢最近 7 天內的最新一筆跑步活動。
   * `fetch_activities(days)`：批次拉取指定天數內的跑步紀錄。
   * `_normalize()`：統一轉換為系統標準格式（距離、配速、心率、爬升，並額外支援 `icu_training_load` 訓練負荷）。
   * 預留 Phase 4 間歇分段 `fetch_activity_laps()` 與秒級時序心率 `fetch_activity_streams()`。
3. **資料庫向下相容遷移 ([`src/memory/db.py`](file:///Users/williampcs0203/projs/running_coach/src/memory/db.py))**：
   * 啟動時自動檢查 `workouts` 表；若無 `intervals_id` 則動態執行 `ALTER TABLE workouts ADD COLUMN intervals_id TEXT` 並建立唯一索引。
   * 既有 `strava_id` 欄位予以保留，確保過往已存在的歷史跑步資料完全不遺失。
   * `save_workout()` 更新為通用儲存邏輯，相容兩種外部來源。
4. **Agent 與指令串接**：
   * [`src/agent/loop.py`](file:///Users/williampcs0203/projs/running_coach/src/agent/loop.py)：工具命名升級為 `fetch_latest_activity`，跑後回報支援顯示訓練負荷（Load）。
   * [`src/agent/sync.py`](file:///Users/williampcs0203/projs/running_coach/src/agent/sync.py)：`/sync` 指令改向 Intervals.icu 同步，以 `intervals_id` 去重並合併主觀體感暫存。
   * [`src/memory/context_manager.py`](file:///Users/williampcs0203/projs/running_coach/src/memory/context_manager.py)：更新跑後偵測提示詞。
5. **連線驗證工具 ([`scripts/test_intervals.py`](file:///Users/williampcs0203/projs/running_coach/scripts/test_intervals.py))**：
   * 獨立 CLI 工具，支援讀取 `.env` 或命令列參數直接測試 Intervals.icu 連線與數據解析，已實測驗證通過。

---

## 五、GitHub Actions CI/CD 免費自動化部署

### 5.1 架構設計：GitHub Self-hosted Runner
為了實現 100% 免費且極高安全性的自動化部署，採用將 GCP VM 註冊為 GitHub Self-hosted Runner 的模式。

* **架構優勢**：
  * **零防火牆風險**：GCP 不需要對公網開放 Port 22（SSH）。VM 是由內向外透過 HTTPS 長連線監聽 GitHub 事件。
  * **零金鑰外洩風險**：不需要在 GitHub Secrets 儲存主機 SSH 私鑰。
  * **無額度上限**：Self-hosted Runner 完全不扣除 GitHub Actions 每月 2,000 分鐘的免費額度。

### 5.2 自動部署工作流程 ([`.github/workflows/deploy.yml`](file:///Users/williampcs0203/projs/running_coach/.github/workflows/deploy.yml))
```yaml
name: Auto Deploy to GCP VM

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    name: Deploy on GCP VM
    runs-on: self-hosted
    steps:
      - name: Pull latest changes and restart container
        run: |
          cd ~/projs/RunningCoach 2>/dev/null || cd ~/projs/running_coach
          git pull origin main
          docker compose up --build -d
          docker compose ps
```

### 5.3 維運常駐設定 (Linux systemd)
* 避免使用暫時性的 `./run.sh`，改用內建腳本註冊為背景服務：
  ```bash
  sudo ./svc.sh install
  sudo ./svc.sh start
  ```
* 確保 Docker 操作權限：
  ```bash
  sudo usermod -aG docker $USER
  sudo systemctl restart actions.runner.*
  ```

---

## 六、程式碼清理與歷史債務排除 (ADR)

針對專案演進中遺留的過時程式碼，執行全面盤點並採取處理：

1. **死碼拔除（已自 Git 移除）**：
   * `src/tools/strava_tool.py`：舊 Strava API 客戶端，全數被 `intervals_tool.py` 取代。
   * `scripts/strava_auth.py`：舊 Strava OAuth 本地授權腳本，完全廢棄。
2. **資料庫冗餘結構清理**：
   * `src/memory/db.py`：刪除 `CREATE TABLE strava_tokens`、`get_strava_token()`、`save_strava_token()`。
3. **註解修正**：
   * `src/tools/training_plan_tool.py` 與 `src/tools/intervals_tool.py` 移除過時說明。
4. **架構決策紀錄 (ADR)**：
   * 於 [`doc/known-issues.md`](file:///Users/williampcs0203/projs/running_coach/doc/known-issues.md) 正式收錄 **`[KI-016]`**，記載遷移原因、刪除檔案與向下相容保證。

---

## 七、商業 App 轉型與 Token 成本優化深度評估

### 7.1 現實商業痛點：單位經濟（Unit Economics）
若將此專案擴展為多租戶商業行動 App，面臨的最大挑戰在於**「高階模型 API 成本 vs. 消費者付費意願」**：
* **目前單次對話 Context 規模**：約 10k tokens。
* **跑後回報雙倍扣款問題**：在 Discord 文字對話中，跑後回報需歷經「觸發 Tool → 取得活動 → 二次送入生成分析」，等於單次互動打 2 輪 API，累積 Input Tokens 衝上 20k~30k。
* **成本估算（以 Claude Sonnet 4.5 為例）**：
  * 每位活躍用戶單月跑 20 次＋日常閒聊 40 次，單人每月純 API 成本約 **$3.5 ~ $4.5 美元（約 NT$110 ~ NT$140）**。
  * 加上 Apple App Store 15%~30% 抽成與重度用戶風險，月費定價若被迫落在 **$9.99 ~ $14.99 美元（NT$300 ~ NT$480）**，可能引發非極客大眾用戶抗拒。

### 7.2 技術降本解法：削波 60%~80% 成本

#### 解法 A：原生 UI 取代 Agent Tool（單次回報成本暴降 70%）
* **原理**：Discord 因無表單介面，迫使所有資料讀寫（修改生理資料、新增賽事、拉取手錶活動）都必須塞入 Tool Schema，讓 LLM 進行 Function Calling。
* **App 化改善**：
  1. 選手檔案設定、賽事管理做成原生 UI 表單，直接寫入手機本地 SQLite（**耗費 0 Token**）。
  2. 跑後數據由 App 直接在背景透過 HealthKit / Intervals.icu 拉取（**耗費 0 Token**）。
  3. 跑後分析直接由 App 組合單一 Prompt 送入：「*這是今日跑步數據：{...}，體感 7/10。請以教練角度評估。*」
  * **成效**：**取消跑後回報的 Tool Use 迴圈，從 2~3 次 API 來回精簡為單次 API 呼叫，Token 消耗由 25k 驟降至 3k~4k**。

#### 解法 B：Anthropic Prompt Caching（提示詞快取）
* **規格**：`claude-sonnet-4-5` 支援，門檻 1,024 tokens，TTL 5 分鐘，快取命中享 **90% 折扣**（只要 0.1 倍費用）。
* **商業價值**：在多用戶後端服務中，所有用戶共享相同的教練 System Prompt（運動科學架構、週期化原則、VDOT 換算規則，約 2,000+ tokens）。一旦快取建立，所有用戶請求的基礎上下文幾乎常駐命中快取。

#### 解法 C：功能級模型路由 (Model Routing)
* **輕量級模型（Claude Haiku / Gemini 2.0 Flash）**：負責非同步對話壓縮摘要、日常小知識 FAQ、賽事配速速算。單次成本僅約 NT$0.01。
* **主力旗艦模型（Claude Sonnet 4.5）**：負責跑後心率漂移與疲勞深度剖析、週期化課表動態修訂、傷病防護判斷。

---

## 八、未來產品發展路線圖 (Roadmap)

### 階段一：現有 Discord Bot 穩固與微優化（目前階段）
- [x] 完成 Intervals.icu 全面取代 Strava
- [x] 建立 GitHub Actions CI/CD 免費自動部署
- [x] 清理 Strava 殘留死碼與資料庫廢棄結構
- [ ] 於 `src/agent/loop.py` 啟用 Prompt Caching（驗證多輪對話降本與延遲縮短效果）
- [ ] 將非同步對話壓縮 (`summarizer.py`) 改用輕量模型

### 階段二：獨立行動 App 原型（Local-First Prototype）
- [ ] 評估以 Flutter 打造行動端介面（iOS / Android）
- [ ] 移植 5 層記憶架構與 SQLite Schema 至手機端（利用 `drift` 或 `sqflite`）
- [ ] 串接 iOS HealthKit 與 Android Health Connect，實現原生裝置數據直讀
- [ ] 原生化 UI：選手生理檔案、賽事日曆、課表視覺化展示

### 階段三：商業化與發行模式選擇
根據目標受眾與法律隱私責任，可採用以下三種路徑之一：

1. **極客本地工具 (BYOK 模式 - 類似 Obsidian / Raycast)**：
   * 用戶自備 API Key（Anthropic / Gemini），資料 100% 存在手機本地。
   * 開發者零伺服器維護成本、零隱私法律責任、零代墊 API 破產風險。
   * 採 App 買斷制（如 NT$150 / $4.99 USD）。
2. **嚴肅跑者訂閱制 (Runna 模式 - 垂直高價值定位)**：
   * 避開大眾泛健康市場，主打半馬/全馬破 PB 嚴肅跑者，強調自適應週期化與疲勞監控。
   * 透過「原生 UI 瘦身 + Prompt Caching」，將單人 API 成本壓低至 NT$25~35/月。
   * 定價 NT$199 ~ NT$299 / 月（或年繳 NT$1,800），維持 80%+ 軟體毛利率。
3. **雙軌混合制 (Hybrid)**：
   * 免費版：BYOK 自填金鑰，吸引開源社群與極客推廣。
   * Pro 訂閱版：開箱即用、免配金鑰、內建雲端同步與高階圖表。
