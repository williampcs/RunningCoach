# Running Coach Agent — 系統規格文件

**版本**：1.3  
**最後更新**：2026-03-31  
**狀態**：待實作

### 版本異動紀錄

| 版本 | 日期 | 變動內容 |
|------|------|------------|
| 1.0 | 2026-03-30 | 初版 |
| 1.1 | 2026-03-31 | 資料來源改為 Strava 官方 API；workouts table 新增體感強度與主觀感受欄位；新增跑後回報自動觸發流程；移除 Garmin 帳密，改用 OAuth2 token |
| 1.2 | 2026-03-31 | 新增 laps_json 欄位支援間歇跑分組資料；新增 streams_json 欄位儲存心率／配速時序曲線；完善跑後回報的 Strava 同步延遲處理流程（含日期驗證與主觀暫存機制）；新增 strava_auth.py 的 OAuth redirect 部署說明；更新 workout_summaries 格式支援間歇跑；新增 get_workout_laps / get_hr_stream 兩個 tool |
| 1.3 | 2026-03-31 | 新增 races table 管理具體賽事目標；athlete_profile 的 goal 欄位明確為長期方向性目標；層1 system prompt 自動注入近期賽事與距離天數；新增 add_race / get_upcoming_races / update_race_result 三個 tool |

---

## 1. 專案概述

### 1.1 目標

建立一個部署在 GCP VM 容器中的跑步教練 AI Agent，透過 Discord 作為使用者介面，解決長對話後 AI 輸出品質下降的問題。核心解法是主動管理送進 LLM 的 context 內容，而非依賴模型自身的記憶能力。

### 1.2 使用情境

- 訓練前：在 Discord 詢問今天的訓練目標與建議
- 訓練後：輸入體感強度與主觀感受，系統自動從 Strava 拉取客觀數據合併分析
- 隨時：詢問配速、飲食、裝備等跑步相關問題
- 定期：手動執行 `/sync` 補同步近期資料
- 賽事管理：新增目標賽事，賽後記錄實際成績

### 1.3 核心設計原則

- **Context Engineering 優先**：所有進入 Claude 的內容都經過主動管理，確保品質不隨時間下降
- **主客觀資料合併**：客觀數據來自 Strava API，主觀體感由使用者輸入，兩者合併才是完整的訓練紀錄
- **賽事驅動備賽**：訓練建議自動考量近期賽事距離，不需使用者每次提醒
- **簡單穩定**：技術選型以可長期維護為主，避免不必要的複雜度
- **資料永久保留**：所有訓練資料存在 SQLite，不因 context 壓縮而丟失
- **容器隔離**：服務跑在 Docker 容器中，與 VM 其他用途隔離

---

## 2. 系統架構

### 2.1 整體架構圖

```
手機 Discord App
      ↕
Discord Cloud
      ↕
┌─────────────────────────────────────────┐
│  GCP VM                                 │
│  ┌─────────────────────────────────┐    │
│  │  Docker Container: coach-bot    │    │
│  │                                 │    │
│  │  Discord Bot (discord.py)       │    │
│  │       ↕                         │    │
│  │  Agent Loop (anthropic SDK)  ←──┼────┼── Anthropic API
│  │       ↕                         │    │
│  │  Context Manager               │    │
│  │       ↕                         │    │
│  │  SQLite (/app/data/coach.db)   │    │
│  │       ↕                         │    │
│  │  Tools                          │    │
│  │   ├─ Strava Tool ←─────────────┼────┼── Strava API（官方 OAuth2）
│  │   └─ Training Plan Tool        │    │
│  └─────────────────────────────────┘    │
│  ./data/coach.db  ← volume mount       │
└─────────────────────────────────────────┘
```

### 2.2 層次說明

| 層次 | 元件 | 職責 |
|------|------|------|
| 介面層 | Discord Bot | 接收使用者訊息、回傳 Agent 回應 |
| Agent 層 | Agent Loop | 組合 context、呼叫 Claude API、執行 tool call |
| 記憶層 | Context Manager | 管理五層 context、讀寫 SQLite |
| 工具層 | Strava Tool、Training Plan Tool | 提供 Agent 可呼叫的外部能力 |
| 儲存層 | SQLite | 所有資料的持久化儲存 |

---

## 3. Context Engineering 設計

這是整個系統最核心的部分，解決長對話品質下降的根本問題。

### 3.1 核心概念

每次呼叫 Claude API 前，Context Manager 將以下五層內容組合後送入，確保：
- 重要資訊永遠存在（不受對話長度影響）
- Context window 不會被舊對話撐爆
- 歷史資料完整保留在 DB，需要時可查詢

### 3.2 五層 Context 結構

```
每次 API Call 送入的內容：

┌─────────────────────────────────────────────────┐
│ 層1 — System Prompt（永久）                     │
│ 固定選手資料：長期目標、PB、傷病注意事項         │
│ 動態注入：近期賽事清單（距今 90 天內）           │
│ 來源：athlete_profile + races table             │
│ 更新頻率：使用者明確更新，或每次呼叫動態生成    │
├─────────────────────────────────────────────────┤
│ 層2 — 訓練歷史摘要（結構化）                    │
│ 最近 N 筆 AI 生成的跑步分析                     │
│ 包含：客觀數據 + 體感強度 + 主觀感受 + AI 評語  │
│ 來源：workout_summaries table                   │
│ 更新頻率：每次跑後回報流程完成後自動生成        │
├─────────────────────────────────────────────────┤
│ 層3 — 當前訓練計畫                              │
│ 本週或當前週期的訓練計畫內容                    │
│ 來源：training_plans table（最新一筆）          │
│ 更新頻率：Coach 更新計畫時                      │
├─────────────────────────────────────────────────┤
│ 層4 — 對話摘要（中期）                          │
│ 歷史對話的壓縮版本（重要決策、狀態調整）        │
│ 來源：summaries table（最新一筆）               │
│ 更新頻率：對話輪數超過閾值時自動觸發            │
├─────────────────────────────────────────────────┤
│ 層5 — Rolling Window（短期）                    │
│ 最近 10-15 輪原始對話                           │
│ 來源：conversations table                       │
│ 更新頻率：每輪對話後更新                        │
└─────────────────────────────────────────────────┘
```

### 3.3 層1 System Prompt 組成

層1包含兩個部分：固定選手資料（來自 `athlete_profile`）與動態注入的賽事資訊（來自 `races`）。

**固定選手資料範例**：
```
你是一位專業跑步教練，以下是選手資料：

長期目標：2026 年底前半馬破二
個人最佳：5km 22:30 / 10km 47:15 / 半馬 2:08:00
傷病注意：右膝髕骨外側輕微不適，大量下坡時留意
每週目標里程：50km
```

**動態注入的近期賽事**（距今 90 天內，依日期排序）：
```
近期目標賽事：
- 2026-05-10 萬金石馬拉松 21.1km｜目標 1:58:00｜距今 40 天（已確認報名）
- 2026-06-28 台北超馬接力 10km｜目標完賽｜距今 89 天（考慮中）
```

若無近期賽事，此段落省略不注入。超過 90 天的賽事不注入 context，但仍保留在 DB 供查詢。

### 3.4 對話壓縮邏輯

當 `conversations` table 的輪數超過閾值（預設 20 輪），自動觸發：

1. 取出最舊的（總輪數 - 保留輪數）筆對話
2. 呼叫 Claude 壓縮成重點摘要，保留：
   - 訓練決策（調整了什麼、為什麼）
   - 重要發現（狀態異常、突破、傷病跡象）
   - 選手當時的狀態描述
3. 新摘要存入 `summaries`，舊摘要與原始對話刪除

壓縮於**使用者訊息送出後、Claude 回應前**非同步執行，不阻塞主流程（若壓縮失敗，保留原始對話繼續運作，下次再觸發）。

### 3.5 跑後回報流程（主客觀資料合併）

這是系統最重要的資料進入點。使用者只需輸入主觀感受，客觀數據由系統自動補入。

```
使用者在 Discord 輸入跑後感受，例如：
「剛跑完，體感 7/10，腿有點重，呼吸順，右膝無異狀」

Agent 偵測到跑後回報意圖
        ↓
先解析使用者輸入，萃取：
  - 體感強度（perceived_effort）：7
  - 主觀感受（subjective_notes）：「腿有點重，呼吸順，右膝無異狀」
        ↓
自動呼叫 Strava Tool，拉取最新跑步活動
並驗證活動日期是否為今天
        ↓
    ┌───┴────────────────────────────────┐
    │                                    │
日期相符                           日期不符（Strava 尚未同步）
    │                                    │
合併主客觀資料                     先將主觀感受暫存至 pending_subjective table
存入 workouts table                 回應：「Strava 尚未同步今天的跑步，
呼叫 Claude 生成完整摘要                    主觀感受已幫你記下。
存入 workout_summaries                     Strava 同步後輸入 /sync 完成合併。」
Claude 回應分析結果
```

**跑後回報意圖偵測**：

Agent 的 system prompt 中定義，當訊息包含以下特徵時視為跑後回報：
- 出現「跑完」、「剛跑」、「今天跑」等關鍵詞
- 出現體感數字（如「7/10」、「體感7」）
- 出現身體感受描述（「腿重」、「呼吸」、「心率」、膝蓋等部位）

**Strava 同步延遲說明**：Garmin 手錶上傳資料到 Strava 通常需要 5–15 分鐘，跑完立即回報可能拿不到當天活動。日期驗證確保不會把昨天的活動誤判為今天。

### 3.6 手動同步流程（`/sync`）

```
使用者在 Discord 輸入 /sync
        ↓
Strava Tool 拉取最近 14 天的跑步活動
        ↓
以 strava_id 去重，只處理新資料
        ↓
檢查 pending_subjective table
是否有符合日期的主觀暫存資料
        ↓
    ┌───┴──────────────────────────────┐
    │                                  │
有暫存資料                         無暫存資料
    │                                  │
合併主觀暫存 + 客觀數據            僅存客觀數據
刪除 pending_subjective 對應紀錄   subjective_notes 留空
        │                                  │
        └────────────┬─────────────────────┘
                     ↓
              存入 workouts table
              對每筆新資料生成摘要（完整版或客觀版）
              存入 workout_summaries
                     ↓
              同步時額外拉取 laps 與 streams 資料
              更新 laps_json、streams_json 欄位
                     ↓
              回傳「已同步 N 筆新資料」
```

---

## 4. 資料庫設計

### 4.1 SQLite Schema

```sql
-- 選手固定資料
CREATE TABLE athlete_profile (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
-- 初始資料：
--   goal_long_term  → 長期方向性目標，例：「2026年底前半馬破二」
--   pb_5k / pb_10k / pb_half / pb_full → 個人最佳成績
--   injuries        → 目前傷病或注意事項
--   weekly_km_target → 每週目標里程

-- 具體賽事目標
CREATE TABLE races (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,        -- '2026 萬金石馬拉松'
    date         TEXT NOT NULL,        -- '2026-05-10'（ISO 格式，用於排序與距今計算）
    distance_km  REAL NOT NULL,        -- 21.1
    target_time  TEXT,                 -- '1:58:00'（可為空，表示目標完賽即可）
    confirmed    INTEGER DEFAULT 1,    -- 1=確認報名, 0=考慮中
    result_time  TEXT,                 -- 賽後填入實際完賽時間（可為空）
    notes        TEXT,                 -- 其他備注，例：「山路賽，需練習爬坡」
    created_at   TEXT NOT NULL
);

-- 跑步資料（永久保留，客觀 + 主觀合併）
CREATE TABLE workouts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id         TEXT UNIQUE,          -- 避免重複匯入，來源識別
    date              TEXT NOT NULL,
    type              TEXT DEFAULT 'run',
    distance_km       REAL,
    duration_min      REAL,
    avg_hr            INTEGER,
    max_hr            INTEGER,
    avg_pace          TEXT,                 -- 格式：'5:30/km'
    elevation_m       REAL,
    calories          INTEGER,
    perceived_effort  INTEGER,             -- 體感強度 1-10，使用者輸入
    subjective_notes  TEXT,               -- 主觀感受，使用者輸入（可為空）
    laps_json         TEXT,               -- Strava laps API 回傳的分組陣列（可為空）
    streams_json      TEXT,               -- 心率／配速時序資料（降採樣，可為空）
    raw_json          TEXT,               -- Strava 活動原始回應
    source            TEXT DEFAULT 'strava', -- 'strava' 或 'manual'
    synced_at         TEXT NOT NULL
);

-- AI 生成的跑步分析摘要
CREATE TABLE workout_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id  INTEGER REFERENCES workouts(id),
    summary     TEXT NOT NULL,             -- AI 生成的分析文字
    created_at  TEXT NOT NULL
);

-- 訓練計畫
CREATE TABLE training_plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,              -- 例：'2026-W14'
    content    TEXT NOT NULL,              -- 計畫內容（純文字）
    created_at TEXT NOT NULL,
    is_active  INTEGER DEFAULT 1
);

-- 對話紀錄（rolling window 用）
CREATE TABLE conversations (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT NOT NULL,               -- 'user' 或 'assistant'
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
);

-- 壓縮後的對話摘要
CREATE TABLE summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL,
    covers_up_to_id INTEGER,               -- 壓縮到哪一輪對話為止
    created_at      TEXT NOT NULL
);

-- Strava OAuth token 儲存
CREATE TABLE strava_tokens (
    id            INTEGER PRIMARY KEY CHECK (id = 1), -- 只存一筆
    access_token  TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at    INTEGER NOT NULL         -- Unix timestamp
);

-- 主觀感受暫存（Strava 尚未同步時使用）
CREATE TABLE pending_subjective (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,        -- 跑步日期，用於之後與 Strava 活動配對
    perceived_effort INTEGER,
    subjective_notes TEXT,
    created_at       TEXT NOT NULL
);
```

### 4.2 目標資料的兩層設計

| 類型 | 存放位置 | 範例 | 說明 |
|------|----------|------|------|
| 長期方向性目標 | `athlete_profile.goal_long_term` | 「2026年底前半馬破二」 | 沒有固定日期，是訓練的整體方向 |
| 具體賽事目標 | `races` table | 2026-05-10 萬金石半馬，目標 1:58 | 有明確日期、距離、目標時間 |

兩者都會進入層1 system prompt，但方式不同：長期目標是固定文字，賽事目標由 Context Manager 動態查詢距今 90 天內的賽事後組合注入。

### 4.3 laps_json 與 streams_json 說明

**laps_json**（來自 `GET /activities/{id}/laps`）

儲存每一個分組（lap）的完整數據，間歇跑分析的核心資料：

```json
[
  {"lap_index": 1, "distance_m": 400, "elapsed_time_s": 96, "avg_speed_mps": 4.17, "avg_hr": 158, "max_hr": 164},
  {"lap_index": 2, "distance_m": 400, "elapsed_time_s": 95, "avg_speed_mps": 4.21, "avg_hr": 162, "max_hr": 168}
]
```

對輕鬆跑來說 laps 通常只是每公里自動分段，對間歇跑則是每一組的關鍵指標。

**streams_json**（來自 `GET /activities/{id}/streams?keys=time,heartrate,velocity_smooth`）

儲存逐秒的心率與配速時序資料，**降採樣為每 10 秒一筆**以控制儲存大小：

```json
{
  "time":      [0, 10, 20, 30],
  "heartrate": [128, 131, 135, 142],
  "pace_per_km": ["6:32", "6:21", "6:10", "5:55"]
}
```

一場 10km 跑步降採樣後約 360 筆，JSON 大小約 30–50KB。一年 300 次跑步約佔 10–15MB，SQLite 完全承受得住。

**注意**：laps 與 streams 各需一次額外 API call，會在 `/sync` 時一次拉取，跑後回報的即時拉取只取基本活動資料，不拉 laps/streams，避免延遲回應。laps/streams 在後續 `/sync` 時補入。

### 4.4 workout_summaries 摘要格式

**輕鬆跑 — 完整版**（跑後回報，含主觀資料）：
```
2026-03-30｜輕鬆跑 8.2km｜配速 5:45/km｜平均心率 142bpm
體感強度：7/10｜感受：腿有點重，呼吸順，右膝無異狀
AI 評估：心率正常但體感偏高，可能為累積疲勞，建議明日降強度。
```

**間歇跑 — 含 laps 分析版**：
```
2026-03-28｜間歇跑 10×400m
各組配速：4:02, 4:00, 3:59, 4:03, 4:05, 4:08, 4:07, 4:11, 4:15, 4:18
心率趨勢：157→182bpm（後段明顯上升）
體感強度：8/10｜感受：後半段腿很重，喘但還能控制
AI 評估：第7組後配速下滑且心率上升幅度偏大，有氧底子可能限制恢復速度，
建議下週減量至 8×400m，待恢復能力提升後再加量。
```

**客觀版**（`/sync` 補同步，無主觀資料）：
```
2026-03-26｜輕鬆跑 6.5km｜配速 5:52/km｜平均心率 138bpm
體感資料：未記錄
AI 評估：數據正常，無異常跡象。
```

### 4.5 資料保留策略

| Table | 保留策略 |
|-------|---------|
| athlete_profile | 永久，使用者更新時覆寫 |
| races | 永久，不刪除（保留歷史賽事與成績紀錄） |
| workouts | 永久，不刪除 |
| workout_summaries | 永久，不刪除 |
| training_plans | 永久，新計畫新增，is_active 標記當前 |
| conversations | 滾動，超過閾值後舊的被壓縮刪除 |
| summaries | 保留最新一筆，舊的在新摘要生成後刪除 |
| strava_tokens | 永久，access token 過期時自動 refresh |
| pending_subjective | 配對成功後刪除；超過 7 天未配對自動清除 |

---

## 5. 檔案結構

```
running-coach/
├── docker-compose.yml
├── Dockerfile
├── .env                          # 環境變數（不進 git）
├── .env.example                  # 環境變數範本
├── .gitignore
├── data/                         # SQLite volume mount 目標
│   └── coach.db                  # 自動建立
├── src/
│   ├── main.py                   # 進入點
│   ├── config.py                 # 設定讀取
│   ├── bot/
│   │   └── discord_bot.py        # Discord Bot 主體
│   ├── agent/
│   │   └── loop.py               # Agent Loop
│   ├── memory/
│   │   ├── context_manager.py    # Context 組合與壓縮邏輯
│   │   ├── db.py                 # SQLite 初始化與查詢
│   │   └── summarizer.py         # 對話壓縮
│   └── tools/
│       ├── strava_tool.py        # Strava API 資料同步
│       └── training_plan_tool.py # 訓練計畫讀寫
├── scripts/
│   ├── init_profile.py           # 初始化選手資料
│   └── strava_auth.py            # 一次性 OAuth 授權流程
└── README.md
```

---

## 6. 元件規格

### 6.1 Discord Bot（`bot/discord_bot.py`）

**職責**：接收 Discord 訊息，轉發給 Agent，回傳結果

**行為規格**：
- 監聽指定 channel ID 的訊息（環境變數設定）
- 收到訊息時顯示 typing 狀態
- 回應超過 2000 字時自動切割分段送出
- 支援以下斜線指令：
  - `/sync`：手動觸發 Strava 資料同步（含 laps/streams，並嘗試合併主觀暫存）
  - `/plan [內容]`：更新本週訓練計畫
  - `/profile [key] [value]`：更新選手資料
  - `/status`：顯示目前記憶層摘要（debug 用）
- 一般文字訊息直接送給 Agent 處理（包含跑後回報、賽事新增等自然語言操作）

**賽事管理透過自然語言進行**，不需要另外的斜線指令。例如：
- 「我報名了五月十號萬金石半馬，目標 1:58」→ Claude 呼叫 `add_race`
- 「剛跑完萬金石，成績 1:55:30」→ Claude 呼叫 `update_race_result`

**錯誤處理**：
- API 呼叫失敗時回傳「目前無法回應，請稍後再試」
- Strava 拉不到資料時明確告知，不靜默失敗
- 不對使用者暴露技術錯誤細節

### 6.2 Agent Loop（`agent/loop.py`）

**職責**：組合 context、呼叫 Claude API、處理 tool call 迴圈

**行為規格**：
- 每次收到訊息，從 Context Manager 取得完整 context
- 呼叫 Claude API（模型：`claude-sonnet-4-5`）
- 若回應包含 tool call，執行對應工具後繼續迴圈
- 最多執行 5 輪 tool call，避免無限迴圈
- 最終文字回應存入 conversations，回傳給 Bot

**Tool 定義**（供 Claude 呼叫）：

```
fetch_latest_strava_activity()
  → 拉取 Strava 上最新一筆跑步活動（基本資料，不含 laps/streams）
  → 用途：跑後回報時快速取得客觀數據，驗證日期是否為今天

save_workout(strava_data: dict, perceived_effort: int, subjective_notes: str)
  → 合併客觀與主觀資料，存入 workouts table，生成摘要
  → 用途：跑後回報流程的最終儲存步驟

save_pending_subjective(date: str, perceived_effort: int, subjective_notes: str)
  → 將主觀感受暫存至 pending_subjective table
  → 用途：Strava 尚未同步時，先保留主觀資料

get_recent_workouts(days: int)
  → 從 DB 取最近 N 天的跑步資料（含主觀感受與摘要）
  → 用途：使用者問具體訓練細節時

get_workout_laps(workout_id: int)
  → 從 DB 取指定跑步的 laps_json 並解析
  → 用途：使用者詢問間歇跑各組表現、配速分析時

get_hr_stream(workout_id: int)
  → 從 DB 取指定跑步的 streams_json 並解析
  → 用途：使用者詢問心率變化曲線、心率區間分佈時

get_pace_trend(weeks: int)
  → 計算過去 N 週的週平均配速
  → 用途：趨勢分析

add_race(name: str, date: str, distance_km: float, target_time: str, confirmed: int, notes: str)
  → 新增目標賽事至 races table
  → 用途：使用者說「我報名了 OOO 比賽」時呼叫

get_upcoming_races(days: int)
  → 查詢距今 N 天內的賽事清單
  → 用途：使用者詢問「我最近有什麼比賽」時呼叫

update_race_result(race_id: int, result_time: str, notes: str)
  → 更新賽事實際完賽時間與備注
  → 用途：賽後記錄成績

save_training_plan(week_label: str, content: str)
  → 儲存訓練計畫到 DB
  → 用途：Coach 制定或更新計畫時

update_athlete_profile(key: str, value: str)
  → 更新選手固定資料
  → 用途：長期目標、PB、傷病更新
```

### 6.3 Context Manager（`memory/context_manager.py`）

**職責**：組合五層 context，管理對話壓縮觸發

**`get_context_for_api()` 回傳格式**：

```python
{
    "system": str,       # 層1：選手資料 + 動態近期賽事
    "messages": [
        # 層2：最近 N 筆 workout_summaries（user/assistant pair）
        # 層3：當前 training_plan（user/assistant pair）
        # 層4：最新 summary（user/assistant pair，若有）
        # 層5：conversations 最近 N 輪
    ]
}
```

**層1 組合邏輯**：每次呼叫時，從 `athlete_profile` 讀取固定資料，再查詢 `races` table 中 date 在今天到 90 天後的賽事，動態組合成完整 system prompt。

**壓縮觸發條件**：`conversations` table 超過 20 筆時，保留最新 10 筆，其餘壓縮。觸發時機為使用者訊息送出後、API call 前，非同步執行不阻塞回應。

**可調整參數**（`config.py`）：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `CONVERSATION_MAX` | 20 | 超過此數觸發壓縮 |
| `CONVERSATION_KEEP` | 10 | 壓縮後保留的輪數 |
| `WORKOUT_SUMMARY_COUNT` | 7 | 注入 context 的跑步摘要筆數 |
| `RACE_LOOKAHEAD_DAYS` | 90 | 注入 context 的賽事前瞻天數 |

### 6.4 Strava Tool（`tools/strava_tool.py`）

**職責**：與 Strava 官方 API 溝通，處理 token 管理與資料拉取

**認證方式**：OAuth2。Access token 存在 `strava_tokens` table，過期前自動用 refresh token 換新，不需要儲存帳號密碼。

**主要方法**：

```
fetch_latest_activity() → dict
  呼叫 GET /athlete/activities?per_page=1
  驗證回傳活動的日期是否為今天
  回傳活動基本資料（不含 laps/streams）

fetch_activities(days: int) → list[dict]
  呼叫 GET /athlete/activities
  回傳指定天數內的跑步活動列表（基本資料）

fetch_activity_laps(activity_id: str) → list[dict]
  呼叫 GET /activities/{id}/laps
  回傳各分組詳細數據（配速、心率、距離等）
  用途：間歇跑分析的核心資料來源

fetch_activity_streams(activity_id: str) → dict
  呼叫 GET /activities/{id}/streams?keys=time,heartrate,velocity_smooth
  對逐秒資料進行降採樣（每 10 秒取一筆）後回傳
  回傳格式：{"time": [...], "heartrate": [...], "pace_per_km": [...]}

_refresh_token_if_needed()
  檢查 expires_at，過期前 5 分鐘自動換新 token
  新 token 更新回 strava_tokens table
```

**Strava API 限制**：每 15 分鐘 200 次、每天 2000 次。本系統每天最多呼叫約 10–15 次（含 laps/streams），遠低於限制。

### 6.5 `scripts/strava_auth.py`（一次性授權腳本）

OAuth 授權需要瀏覽器完成，有兩種執行方式：

**方式 A（推薦）：在本機執行，token 複製到 VM**

```bash
# 在本機執行（非 VM）
python scripts/strava_auth.py
# → 開啟瀏覽器完成授權
# → 在終端顯示 access_token 與 refresh_token
# → 手動執行以下指令將 token 存入 VM 的 DB：
python scripts/strava_auth.py --import-token
```

**方式 B：在 VM 執行，用 SSH port forwarding 接 callback**

```bash
# 先在本機開 SSH tunnel
ssh -L 8080:localhost:8080 your-vm
# 在 VM 上執行
python scripts/strava_auth.py
# → 複製輸出的 URL 到本機瀏覽器開啟
# → 授權後 callback 透過 tunnel 傳回 VM
```

Strava App 設定頁面的 redirect_uri 需設為 `http://localhost:8080/callback`。

完成後系統自動維護 token 更新，不需要再手動操作。Strava refresh token 有效期限長（數月至數年），正常使用下不需要重新授權。

---

## 7. 容器化設計

### 7.1 Dockerfile

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY scripts/ ./scripts/

RUN mkdir -p /app/data

CMD ["python", "src/main.py"]
```

### 7.2 docker-compose.yml

```yaml
services:
  coach-bot:
    build: .
    container_name: running-coach
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data        # SQLite 持久化，含 Strava token
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

`./data` 目錄在 VM 本地，容器重建或映像更新不影響資料與 token。

### 7.3 VM 上的 systemd 設定

```ini
# /etc/systemd/system/running-coach.service
[Unit]
Description=Running Coach Agent
After=docker.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=/home/ubuntu/running-coach
ExecStart=docker compose up
ExecStop=docker compose down
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## 8. 環境變數

### 8.1 `.env.example`

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Discord
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_CHANNEL_ID=123456789012345678

# Strava OAuth（從 strava.com/settings/api 取得）
STRAVA_CLIENT_ID=12345
STRAVA_CLIENT_SECRET=abc123...
# 注意：access_token 與 refresh_token 存在 DB，不放這裡

# Agent 參數（可選，有預設值）
CLAUDE_MODEL=claude-sonnet-4-5
CONVERSATION_MAX=20
CONVERSATION_KEEP=10
WORKOUT_SUMMARY_COUNT=7
RACE_LOOKAHEAD_DAYS=90
```

### 8.2 安全注意事項

- `.env` 加入 `.gitignore`，不進版本控制
- Strava 使用 OAuth2，不儲存帳號密碼，只存 token（在 DB 中）
- `./data/` 目錄設定適當權限（`chmod 700 data/`）
- Discord Bot Token 如洩漏請立即到 Discord Developer Portal 重新生成
- Strava token 如洩漏，到 Strava 設定頁面撤銷授權，重新執行 `strava_auth.py`

---

## 9. 費用估算

### 9.1 Anthropic API（按使用量計費）

假設每天：訓練前問一次、訓練後回報一次、其他問題 1-2 次，約 4 次對話。

| 項目 | 估算 |
|------|------|
| 每次 call input token | ~1,800（system + 近期賽事 + 摘要 + window + 訊息） |
| 每次 call output token | ~400 |
| 每次費用（Sonnet） | ~$0.012 |
| 每天費用（4 次） | ~$0.048 |
| **每月費用** | **約 $1.5 USD** |

新增賽事注入後 input token 略增（每筆賽事約 30–40 token），備賽密集期最多約 3–5 筆賽事，影響可忽略不計。

### 9.2 Strava API

免費，無費用。

### 9.3 GCP VM

已有閒置 VM，無額外費用。

---

## 10. 開發階段規劃

### 階段一：基礎對話（可用狀態）

目標：從手機 Discord 能跟 Claude 對話，資料基本存入 DB

- [ ] `db.py`：SQLite 初始化，建立所有 table（含 races、v1.2 所有欄位）
- [ ] `discord_bot.py`：Bot 上線，接收/回傳訊息，支援斜線指令
- [ ] `loop.py`：基本 Agent Loop，無 tool call
- [ ] `context_manager.py`：只實作層1（system prompt）+ 層5（rolling window）
- [ ] `Dockerfile` + `docker-compose.yml`：容器可跑起來
- [ ] `scripts/init_profile.py`：初始化選手資料（含 goal_long_term）

**驗收標準**：在手機 Discord 發訊息，Claude 能回應，對話存入 DB

### 階段二：完整記憶 + 賽事管理（核心功能）

目標：實作完整五層 context（含賽事注入），解決原始問題，支援賽事管理

- [ ] `summarizer.py`：對話壓縮邏輯（含非同步觸發機制）
- [ ] `context_manager.py`：補完層2（workout summaries）、層3（training plan）、層4（對話摘要）
- [ ] `context_manager.py`：層1 動態注入近期賽事邏輯
- [ ] Tool call 接線：`add_race`、`get_upcoming_races`、`update_race_result`
- [ ] Tool call 接線：`update_athlete_profile`
- [ ] `/plan` 指令：更新訓練計畫
- [ ] `/profile` 指令：更新選手資料
- [ ] `/status` 指令：顯示目前記憶狀態（含近期賽事）

**驗收標準**：
- 對話超過 20 輪後，品質不下降；重開機後記憶完整保留
- 說「我報名了五月十號萬金石半馬，目標 1:58」，賽事正確存入並出現在後續對話的 context 中
- 賽後說「成績 1:55:30」，能正確更新賽事結果

### 階段三：Strava 整合與跑後回報

目標：串接 Strava 資料，實現主客觀資料合併的完整跑後回報流程

- [ ] `scripts/strava_auth.py`：OAuth 授權腳本（含方式 A 本機執行流程）
- [ ] `strava_tool.py`：OAuth token 管理、基本活動拉取、去重
- [ ] 跑後回報意圖偵測（system prompt 定義）
- [ ] 日期驗證邏輯：確認 Strava 活動為今天
- [ ] `save_pending_subjective` tool：主觀感受暫存
- [ ] `save_workout` tool：合併主客觀資料，生成完整摘要
- [ ] `/sync` 指令：補同步 + 合併 pending 主觀資料
- [ ] Tool call 接線：`fetch_latest_strava_activity`、`get_recent_workouts`、`get_pace_trend`

**驗收標準**：
- 輸入「剛跑完，體感 7/10，腿有點重」，Claude 自動補入 Strava 數據並回傳完整分析
- Strava 未同步時，主觀感受正確暫存，`/sync` 後自動合併
- Token 過期後自動 refresh，不需要人工介入

### 階段四：進階分析（間歇跑與心率曲線）

目標：支援間歇跑分組分析與心率時序查詢

- [ ] `strava_tool.py` 補充：`fetch_activity_laps`、`fetch_activity_streams`（含降採樣）
- [ ] `/sync` 補充：同步時一併拉取並儲存 laps_json 與 streams_json
- [ ] Tool call 接線：`get_workout_laps`、`get_hr_stream`
- [ ] 間歇跑摘要格式：生成 AI 摘要時依 type 判斷使用 laps 分析版格式

**驗收標準**：
- 詢問「上次間歇跑各組配速」，Claude 能逐組列出並給出分析
- 詢問「昨天跑步心率變化」，Claude 能描述心率趨勢（如後段上升幅度）

---

## 11. 相依套件

```
# requirements.txt
anthropic>=0.40.0
discord.py>=2.3.0
requests>=2.31.0          # Strava API HTTP 呼叫
```

Python 版本：3.12+

---

## 12. 已知風險與對應方式

| 風險 | 可能性 | 對應方式 |
|------|--------|---------|
| Strava 尚未同步 Garmin 資料（跑後立即回報） | 中 | 日期驗證後明確告知；主觀感受暫存至 pending_subjective，/sync 後自動合併 |
| laps/streams API 拉取失敗（部分活動無資料） | 低 | laps_json / streams_json 允許為空，摘要生成時自動退回客觀版格式 |
| Strava OAuth token 失效（refresh token 過期） | 低 | 重新執行 `strava_auth.py`，約每數月至數年一次 |
| strava_auth.py OAuth callback 設定複雜 | 低 | 優先用方式 A（本機執行），README 詳細說明步驟 |
| 跑後回報意圖偵測誤判 | 低 | Claude 確認後再執行，使用者可更正 |
| add_race 時日期或距離解析錯誤 | 低 | Claude 在存入前先向使用者確認解析結果 |
| Discord Bot Token 洩漏 | 低 | 立即到 Developer Portal 重新生成 |
| VM 重開機服務未啟動 | 低 | systemd `restart=always` 自動處理 |
| SQLite 資料損毀 | 極低 | 定期 `cp coach.db coach.db.bak` |
| Claude API 費用超出預期 | 極低 | 每月約 $1.5，有大幅緩衝空間 |
