# Running Coach Agent — 系統規格文件

**版本**：1.4  
**最後更新**：2026-10-09  
**狀態**：階段一至三已實作並上線；階段四（間歇分段與心率曲線）未實作

> v1.3 以前的版本是「實作前的設計」，本版改為描述**目前實際運作的系統**。
> 每項設計決策的來龍去脈記錄在 [known-issues.md](known-issues.md)，本文以 `[KI-xxx]` 標註出處。

### 版本異動紀錄

| 版本 | 日期 | 變動內容 |
|------|------|------------|
| 1.0 | 2026-03-30 | 初版 |
| 1.1 | 2026-03-31 | 資料來源改為 Strava 官方 API；workouts table 新增體感強度與主觀感受欄位；新增跑後回報自動觸發流程；移除 Garmin 帳密，改用 OAuth2 token |
| 1.2 | 2026-03-31 | 新增 laps_json、streams_json 欄位；完善跑後回報的同步延遲處理流程（含日期驗證與主觀暫存機制）；新增 get_workout_laps / get_hr_stream 兩個 tool |
| 1.3 | 2026-03-31 | 新增 races table 管理具體賽事目標；層1 system prompt 自動注入近期賽事與距離天數；新增 add_race / get_upcoming_races / update_race_result 三個 tool |
| 1.4 | 2026-10-09 | 依實作現況全面改寫：資料來源由 Strava 改為 Intervals.icu [KI-016]；層2、層3 改為 tool 按需載入 [KI-015]；層5 帶入所有未壓縮對話 [KI-017]；新增 LLM 呼叫層 `llm.py`、分用途模型與累計用量統計 [KI-018]；模型遷移至 5.5 世代並以 effort 控制思考 [KI-019]，再依用途分層：主對話 Opus 5.5、跑後摘要 Haiku 5.5、對話壓縮 Sonnet 5.5 [KI-020]；賽事可修改與取消 [KI-002]；選手資料加入生理數據、心率區間與訓練偏好 [KI-003][KI-008]；對話摘要改為延續更新 [KI-011]；GitHub Actions 自動部署；一週起始日統一為週一 [KI-006]；賽後 14 天內仍可補登成績 [KI-021]；`/status` 改為顯示模型設定與實際載入方式 [KI-022] |

---

## 1. 專案概述

### 1.1 目標

建立一個部署在 GCP VM 容器中的跑步教練 AI Agent，透過 Discord 作為使用者介面，解決長對話後 AI 輸出品質下降的問題。核心解法是主動管理送進 LLM 的 context 內容，而非依賴模型自身的記憶能力。

### 1.2 使用情境

- 訓練前：在 Discord 詢問今天的訓練目標與建議
- 訓練後：輸入體感強度與主觀感受，系統自動從 Intervals.icu 拉取客觀數據合併分析
- 隨時：詢問配速、飲食、裝備等跑步相關問題
- 定期：手動執行 `/sync` 補同步近期資料
- 賽事管理：新增、修改、取消目標賽事，賽後記錄實際成績

### 1.3 核心設計原則

- **Context Engineering 優先**：所有進入模型的內容都經過主動管理，確保品質不隨時間下降
- **按需載入**：體積大、不是每次都用得到的資料（訓練歷史、訓練計畫）不常駐 context，由模型透過 tool 取用
- **主客觀資料合併**：客觀數據來自 Intervals.icu，主觀體感由使用者輸入，兩者合併才是完整的訓練紀錄
- **賽事驅動備賽**：訓練建議自動考量近期賽事距離，不需使用者每次提醒
- **能算的不交給模型算**：年齡、心率區間、距賽事天數由 Python 計算後注入
- **LLM 呼叫集中**：只有一個模組直接使用模型 SDK，換模型或調整參數只改一處
- **簡單穩定**：技術選型以可長期維護為主，避免不必要的複雜度
- **資料永久保留**：所有訓練資料存在 SQLite，不因 context 壓縮而丟失

---

## 2. 系統架構

### 2.1 整體架構圖

```
手機 Discord App                         Garmin 手錶
      ↕                                      ↓
Discord Cloud                          Garmin Connect
      ↕                                      ↓（直連，不經 Strava）
┌──────────────────────────────────────┐  Intervals.icu
│  GCP VM                              │       ↑
│  ┌────────────────────────────────┐  │       │
│  │ Docker Container: running-coach│  │       │
│  │                                │  │       │
│  │  Discord Bot (discord.py)      │  │       │
│  │       ↕                        │  │       │
│  │  Agent Loop ── Tools ──────────┼──┼───────┘  Intervals.icu API（API Key）
│  │    ↕     ↘                     │  │
│  │ Context   LLM 呼叫層 (llm.py) ─┼──┼──────────  Anthropic API
│  │ Manager                        │  │
│  │    ↕                           │  │
│  │  SQLite (/app/data/coach.db)   │  │
│  └────────────────────────────────┘  │
│  ./data/coach.db  ← volume mount     │
│  GitHub Actions self-hosted runner   │ ←── git push 觸發自動部署
└──────────────────────────────────────┘
```

### 2.2 層次說明

| 層次 | 元件 | 職責 |
|------|------|------|
| 介面層 | Discord Bot | 接收使用者訊息與斜線指令、回傳回應與 token 用量頁尾 |
| Agent 層 | Agent Loop | 組合 context、定義與執行 tools、處理模型無法回覆的情況 |
| LLM 呼叫層 | `llm.py` | 唯一直接使用 anthropic SDK 的模組：tool call 迴圈、模型與參數選擇、用量統計 |
| 記憶層 | Context Manager、Summarizer | 組合 context、對話壓縮 |
| 工具層 | Intervals Tool | 與 Intervals.icu API 溝通 |
| 儲存層 | SQLite | 所有資料的持久化儲存 |

---

## 3. Context Engineering 設計

這是整個系統最核心的部分，解決長對話品質下降的根本問題。

### 3.1 核心概念

每次呼叫模型前，Context Manager 重新組合要送出的內容，確保：
- 重要資訊永遠存在（不受對話長度影響）
- Context 不會被舊對話或用不到的資料撐大
- 歷史資料完整保留在 DB，需要時可查詢

### 3.2 五層 Context 結構

| 層 | 內容 | 來源 | 載入方式 |
|----|------|------|----------|
| **層1** — System Prompt | 日期時區、選手資料、心率區間、訓練偏好、近期賽事、行為指示 | `athlete_profile`、`races` | 常駐（每次即時組合） |
| **層2** — 訓練歷史 | 近期每筆訓練的客觀數據、主觀感受與 AI 分析摘要 | `workouts`、`workout_summaries` | 按需：`get_recent_workouts` tool |
| **層3** — 訓練計畫 | 當前啟用中的訓練計畫 | `training_plans` | 按需：`get_training_plan` tool |
| **層4** — 對話摘要 | 壓縮後的歷史對話重點 | `summaries`（最新一筆） | 常駐（有摘要時） |
| **層5** — Rolling Window | 所有尚未壓縮的原始對話 | `conversations` | 常駐 |

層2、層3 原本每次都注入，後來改為按需載入 [KI-015]：賽事管理、閒聊、更新個人資料等對話完全用不到它們。需要訓練背景時，模型可在同一輪同時呼叫兩個 tool。

實際送給 API 的順序是：tool 定義 → system prompt（層1）→ messages（層4 摘要 → 層5 對話）。

### 3.3 層1 System Prompt 組成

每次呼叫前由 `context_manager._build_system_prompt()` 即時組合，同一天內內容不變（除非選手資料或賽事有更新）。

1. **時間資訊**：今天日期、星期、時區（Asia/Taipei）、一週起始日（週一）
2. **選手資料**：長期目標、PB、傷病注意、每週目標里程
3. **生理資料**：性別、年齡（由 `birth_year` 計算）、身高、體重、體脂
4. **心率**：最大心率（有實測值用實測，否則以 220－年齡推算並標註）、靜息心率、Z1–Z5 區間（以最大心率的 60 / 70 / 80 / 90% 為界，Python 計算）
5. **訓練偏好**：長跑日、固定休息日、偏好時段
6. **近期賽事**：距今 `RACE_LOOKAHEAD_DAYS`（90）天內、未取消的賽事，附 `[id]` 與距今天數；無賽事時整段省略
7. **待記錄成績的賽事**：過去 `RACE_LOOKBACK_DAYS`（14）天內已結束、尚未記錄成績的賽事，附 `[id]`；讓賽後隔幾天才回報成績時仍取得到 id [KI-021]。記錄成績後即不再列出
8. **行為指示**：何時載入訓練歷史與訓練計畫、跑後回報的處理流程

未填寫的欄位不會出現。實際輸出範例：

```
今天日期：2026-10-09（星期五）｜時區：Asia/Taipei（UTC+8）｜以星期一為一週的第一天

你是一位專業跑步教練，以下是選手資料：

長期目標：半馬：2026年底破二；全馬：2027年底破430
個人最佳：5km 22:30 / 10km 47:15 / 半馬 2:08:00
傷病注意：右膝髕骨外側輕微不適，大量下坡時留意
每週目標里程：50km
生理資料：性別：男｜年齡：36歲｜身高：175cm｜體重：68kg
最大心率：184bpm（推算，220－年齡）
靜息心率：52bpm
心率區間：Z1 <110  Z2 110–128  Z3 128–147  Z4 147–165  Z5 >165
訓練偏好：長跑日：週日｜休息日：週一,週五｜偏好時段：早晨

近期目標賽事：
- [1] 2026-11-15 萬金石馬拉松 21.1km｜目標 1:58:00｜距今 37 天（已確認報名）
- [2] 2026-12-20 台北馬拉松 42.195km｜目標完賽｜距今 72 天（考慮中）

請根據選手資料給予個人化的跑步訓練建議。回應使用繁體中文。

【訓練歷史載入時機】
以下情況請主動呼叫 get_recent_workouts 取得訓練歷史與分析摘要：
・進行跑後回饋分析（save_workout 後）
・討論訓練狀態、疲勞程度、體能趨勢
・使用者詢問過去訓練內容或表現
get_training_plan — 以下情況請主動呼叫：
・制定、調整或審視訓練計畫
・需要確認本週計畫安排或訓練目標時
・與當前計畫進行對比分析時
一般閒聊、賽事管理、個人資料更新等情況不需要呼叫以上兩個 tool。

【跑後回報】
當使用者是在回報一次剛完成的跑步（例如「剛跑完 8K，體感 7/10，腿有點重」），先呼叫 fetch_latest_activity 取得客觀數據。
只是詢問訓練、心率或傷痛等問題，沒有回報這次跑步時，不需要呼叫。
取得 Intervals.icu 資料後：
・若活動日期 = 今天 → 呼叫 save_workout 合併主客觀資料並生成分析
・若活動日期 ≠ 今天（手錶尚未同步至 Intervals.icu）→ 呼叫 save_pending_subjective 暫存主觀感受，並告知使用者手錶同步後輸入 /sync 完成合併
```

有待記錄成績的賽事時，賽事區塊之後會多一段：

```
待記錄成績的賽事（已結束、尚未回報成績）：
- [3] 2026-10-08 城市路跑 10.0km｜目標 50:00｜1 天前
```

一週起始日統一為週一，與 `/plan` 的週標籤、`get_pace_trend` 的分組（皆為 ISO 週）一致 [KI-006]。

### 3.4 層4、層5 與對話壓縮

**層5 視窗**：帶入 `conversations` table 中所有尚未壓縮的對話。已壓縮的對話會從 DB 刪除，因此「層4 摘要 + 層5 視窗」恰好涵蓋全部歷史，沒有空窗 [KI-017]。

- 單則訊息超過 `CONVERSATION_MSG_MAX_CHARS`（600）字時，送出前截斷並加上「…（訊息過長，已截短至 N 字）」標記；DB 保留完整內容 [KI-014]
- 上限 `CONVERSATION_MAX × 2` 筆，作為壓縮持續失敗時的保險
- 穩定狀態下視窗大小在 `KEEP + 2` 到 `MAX + 2` 筆之間（預設 12～22 筆）

**壓縮流程**：

1. 使用者訊息存入 DB 後，若對話數超過 `CONVERSATION_MAX`（20），啟動非同步壓縮（不阻塞本次回應）
2. 取出最舊的（總數 − `CONVERSATION_KEEP`）筆對話
3. 呼叫模型產生摘要。若已有前次摘要，改用「將新對話融入現有摘要」的 prompt：新舊資訊衝突時以新資訊為準，已過時的可刪除 [KI-011]
4. 摘要固定三區塊：【訓練狀態】【重要決策】【待追蹤】，每區塊 1–3 點，總計 300 字以內
5. 存入 `summaries`（只保留最新一筆），並刪除已壓縮的對話

壓縮失敗（API 錯誤、模型拒絕回答或沒有產生文字）時只記錄 warning，原對話保留，下一輪再試。

**已知限制**：連續快速送出兩則訊息時，可能對同一批對話觸發兩次壓縮 [KI-001]。

### 3.5 跑後回報流程（主客觀資料合併）

使用者只需輸入主觀感受，客觀數據由系統自動補入。是否為跑後回報由模型依 system prompt 的意圖描述判斷（不是關鍵字比對）。

```
使用者：「剛跑完，體感 7/10，腿有點重，呼吸順，右膝無異狀」
        ↓
模型呼叫 fetch_latest_activity
  → 向 Intervals.icu 查詢最近 7 天，取最新一筆跑步活動
  → 結果暫存於程序內（_activity_cache），並標示活動日期是否為今天
        ↓
    ┌───┴─────────────────────────────────┐
日期為今天                           日期不是今天（手錶尚未同步）
    │                                     │
模型呼叫 save_workout                模型呼叫 save_pending_subjective
（帶入體感強度與主觀感受）            （暫存至 pending_subjective）
    │                                     │
合併暫存的活動資料存入 workouts       回覆使用者：同步後輸入 /sync 完成合併
呼叫模型生成分析摘要
存入 workout_summaries
    │
模型依摘要回覆分析結果
```

手錶上傳到 Garmin Connect 再同步到 Intervals.icu 需要一些時間，跑完立即回報可能拿不到當天活動；日期驗證確保不會把昨天的活動誤判為今天。

### 3.6 手動同步流程（`/sync`）

1. 從 Intervals.icu 拉取最近 14 天的跑步活動
2. 以 `intervals_id` 去重，已存在的跳過
3. 依活動日期查 `pending_subjective`，有暫存就合併主觀感受
4. 存入 `workouts`，並為每筆新資料生成 AI 摘要存入 `workout_summaries`
5. 刪除已配對的暫存；清除超過 7 天未配對的暫存
6. 回報新增、合併、略過的筆數

`/sync` 目前不拉取間歇分段與時序資料（階段四）。

### 3.7 Token 用量統計

每則回覆末端附上用量頁尾 [KI-013][KI-018]：

```
📊 輸入 1,847（層1系統~312  層4摘要~91  層5對話~415  訊息~233） | 輸出 412 | 工具 2 輪，累計輸入 5,940 | 快取 讀 3,200 寫 410
```

- 「輸入」是第一輪的完整輸入，代表 context 大小
- 「累計輸入」是所有 tool call 輪次的輸入加總，才是實際計費量（每輪都會重送整段 context）；沒有 tool call 時不顯示
- 「快取」只在有快取讀寫時顯示
- 摘要生成與對話壓縮的用量不在頁尾，記錄於 log（`summary tokens —`、`compress tokens —`）

**已知限制**：括號內各層數字是依字元數佔比換算的**估算值**。tool 定義沒有獨立欄位，其 token 會被攤到各層，因此對話越長「層1」的數字越小，並非 system prompt 真的在變動。

---

## 4. 資料庫設計

### 4.1 SQLite Schema

`init_db()` 於啟動時建立不存在的 table，並執行增量 migration（以 `PRAGMA table_info` 檢查欄位是否存在）。以下為 migration 後的完整結構。

```sql
-- 選手資料（key-value）
CREATE TABLE athlete_profile (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- 具體賽事目標
CREATE TABLE races (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    date         TEXT NOT NULL,        -- 'YYYY-MM-DD'
    distance_km  REAL NOT NULL,
    target_time  TEXT,                 -- 可為空，表示目標完賽
    confirmed    INTEGER DEFAULT 1,    -- 1=確認報名, 0=考慮中
    result_time  TEXT,                 -- 賽後填入實際完賽時間
    notes        TEXT,
    created_at   TEXT NOT NULL,
    cancelled    INTEGER DEFAULT 0     -- migration 新增：1=已取消（軟刪除）[KI-002]
);

-- 跑步資料（永久保留，客觀 + 主觀合併）
CREATE TABLE workouts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    strava_id         TEXT UNIQUE,          -- 舊資料相容用；新資料不再寫入 [KI-016]
    date              TEXT NOT NULL,        -- 活動當地日期 'YYYY-MM-DD'
    type              TEXT DEFAULT 'run',
    distance_km       REAL,
    duration_min      REAL,                 -- 移動時間
    avg_hr            INTEGER,
    max_hr            INTEGER,
    avg_pace          TEXT,                 -- 格式：'5:30/km'
    elevation_m       REAL,
    calories          INTEGER,
    perceived_effort  INTEGER,              -- 體感強度 1-10，使用者輸入
    subjective_notes  TEXT,                 -- 主觀感受，使用者輸入
    laps_json         TEXT,                 -- 階段四預留，目前未寫入
    streams_json      TEXT,                 -- 階段四預留，目前未寫入
    raw_json          TEXT,                 -- 活動 API 原始回應
    source            TEXT DEFAULT 'strava',-- 新資料寫入 'intervals'
    synced_at         TEXT NOT NULL,
    intervals_id      TEXT,                 -- migration 新增，另建唯一索引 [KI-016]
    training_load     INTEGER               -- migration 新增：Intervals.icu 的 icu_training_load
);
CREATE UNIQUE INDEX idx_workouts_intervals_id ON workouts(intervals_id);

-- AI 生成的跑步分析摘要
CREATE TABLE workout_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id  INTEGER REFERENCES workouts(id),
    summary     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- 訓練計畫
CREATE TABLE training_plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,              -- ISO 週，例：'2026-W41'
    content    TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_active  INTEGER DEFAULT 1           -- 儲存新計畫時，舊計畫全部設為 0
);

-- 對話紀錄（尚未壓縮的部分）
CREATE TABLE conversations (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT NOT NULL,               -- 'user' 或 'assistant'
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
);

-- 壓縮後的對話摘要（只保留最新一筆）
CREATE TABLE summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL,
    covers_up_to_id INTEGER,
    created_at      TEXT NOT NULL
);

-- 主觀感受暫存（手錶尚未同步時使用）
CREATE TABLE pending_subjective (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    perceived_effort INTEGER,
    subjective_notes TEXT,
    created_at       TEXT NOT NULL
);
```

`training_load` 欄位新增時，會從既有紀錄的 `raw_json` 回填一次。

舊版的 `strava_tokens` table 已不再建立；既有 DB 中若還留著，沒有任何程式會使用它。

### 4.2 選手資料欄位（`athlete_profile`）

沿用 key-value 結構，新增欄位不需改 schema。

| 類別 | key | 說明 |
|------|-----|------|
| 核心 | `goal_long_term` | 長期方向性目標，自由格式，可寫多個 |
| 核心 | `weekly_km_target`、`injuries` | 每週目標里程、傷病注意事項 |
| PB | `pb_5k`、`pb_10k`、`pb_half`、`pb_full` | 個人最佳成績 |
| 生理 | `gender`、`birth_year`、`height_cm`、`weight_kg`、`body_fat_pct` | 年齡由 `birth_year` 推算 |
| 心率 | `max_hr`、`resting_hr` | 最大心率實測值、靜息心率 |
| 偏好 | `pref_long_run_day`、`pref_rest_days`、`pref_train_time` | 以 `pref_` 前綴區分 |

填寫方式：`/profile key value` 指令，或直接告訴教練（模型呼叫 `update_athlete_profile`）。`scripts/init_profile.py` 只會詢問核心與 PB 共 7 個欄位。

### 4.3 目標資料的兩層設計

| 類型 | 存放位置 | 範例 | 進入 context 的方式 |
|------|----------|------|------|
| 長期方向性目標 | `athlete_profile.goal_long_term` | 「2026年底前半馬破二」 | 固定文字 |
| 具體賽事目標 | `races` table | 2026-11-15 萬金石半馬，目標 1:58 | 動態查詢 90 天內未取消的賽事 |

### 4.4 訓練摘要格式（`workout_summaries`）

每筆訓練一段 150 字以內的摘要：一行數據摘要＋AI 評估。有主觀資料時做客觀數據與體感的對比分析；沒有（`/sync` 補入）時只給客觀評估。

間歇跑的分組分析版格式尚未實作（階段四）。

### 4.5 資料保留策略

| Table | 保留策略 |
|-------|---------|
| athlete_profile | 永久，更新時覆寫 |
| races | 永久；取消以 `cancelled=1` 標記，不刪除 |
| workouts、workout_summaries | 永久，不刪除 |
| training_plans | 永久；新計畫新增，`is_active` 標記當前 |
| conversations | 滾動；超過閾值後，舊的被壓縮並刪除 |
| summaries | 只保留最新一筆 |
| pending_subjective | 配對成功後刪除；超過 7 天未配對於 `/sync` 時清除 |

### 4.6 時間與時區

- 使用者可見的日期（`workouts.date`、`races.date`）是當地日期字串
- 容器設定 `TZ=Asia/Taipei`，程式中的 `date.today()` 即台灣日期
- `created_at`、`synced_at` 等 metadata 時間戳記以 UTC 儲存 [KI-005]

---

## 5. 檔案結構

```
running-coach/
├── .github/workflows/deploy.yml  # push 到 main 時自動部署
├── docker-compose.yml
├── Dockerfile
├── requirements.txt
├── .env                          # 環境變數（不進 git，只存在 VM）
├── .env.example
├── data/coach.db                 # SQLite（volume mount，不進 git）
├── src/
│   ├── main.py                   # 進入點：初始化 DB、啟動 Bot
│   ├── config.py                 # 環境變數集中管理
│   ├── llm.py                    # LLM 呼叫層（唯一使用 anthropic SDK）
│   ├── bot/discord_bot.py        # Discord 事件、斜線指令、用量頁尾
│   ├── agent/
│   │   ├── loop.py               # 組 context、tool 定義與執行
│   │   └── sync.py               # /sync 同步流程
│   ├── memory/
│   │   ├── db.py                 # SQLite schema、migration、查詢
│   │   ├── context_manager.py    # 五層 context 組合
│   │   └── summarizer.py         # 對話壓縮
│   └── tools/
│       ├── intervals_tool.py     # Intervals.icu API
│       └── training_plan_tool.py # 僅說明用（訓練計畫邏輯分散在 db / loop / bot）
├── scripts/
│   ├── init_profile.py           # 互動式初始化選手資料
│   └── test_intervals.py         # 測試 Intervals.icu 連線
└── doc/                          # 規格書（各版本）、已知問題、部署指南、專案回顧
```

---

## 6. 元件規格

### 6.1 Discord Bot（`bot/discord_bot.py`）

- 只處理 `DISCORD_ALLOWED_CHANNEL_ID` 頻道的訊息，忽略其他 bot
- 處理中顯示 typing 狀態；回應超過 2000 字時依換行切段送出，用量頁尾附在最後一段
- 處理失敗時回覆「目前無法回應，請稍後再試。」，不暴露技術細節

| 指令 | 行為 |
|------|------|
| `/sync` | 執行 3.6 的同步流程 |
| `/plan <content>` | 以今天所在的 ISO 週為 `week_label` 儲存訓練計畫（不經模型） |
| `/profile <key> <value>` | 更新選手資料欄位（不經模型） |
| `/status` | 顯示三種用途使用的模型與思考強度，以及各記憶層狀態；標示每層是每次帶入還是按需載入 [KI-022] |

一般文字訊息交給 Agent Loop。賽事管理、資料更新、跑後回報都以自然語言進行。

### 6.2 Agent Loop（`agent/loop.py`）

`run(user_message)` 的流程：

1. 使用者訊息存入 `conversations`
2. 對話數超過閾值時啟動非同步壓縮
3. 向 Context Manager 取得 system prompt 與 messages
4. 交給 `llm.run_with_tools()`，並提供 tool 定義與執行函式
5. 模型拒絕回答時改回「這個問題我沒辦法回覆，換個方式問問看？」；沒有產生文字時回提示訊息
6. 回覆存入 `conversations`，連同用量統計回傳給 Bot

Tool 執行函式回傳純文字；執行出錯時回傳「執行失敗：…」，讓模型自行向使用者說明。tool call 的中間過程不存入對話紀錄，只保留最終回覆。

**Tools（共 13 個）**：

| Tool | 用途 |
|------|------|
| `fetch_latest_activity` | 從 Intervals.icu 取最新一筆跑步活動，暫存並標示是否為今天 |
| `save_workout` | 合併暫存的活動與主觀感受存檔，生成分析摘要 |
| `save_pending_subjective` | 活動尚未同步時，暫存主觀感受 |
| `get_recent_workouts` | 最近 N 天（預設 14）的訓練紀錄與 AI 摘要（層2） |
| `get_training_plan` | 目前啟用中的訓練計畫（層3） |
| `get_pace_trend` | 過去 N 週（預設 4）的週平均配速，以 ISO 週分組 |
| `save_training_plan` | 儲存訓練計畫（舊計畫停用） |
| `add_race` | 新增目標賽事 |
| `get_upcoming_races` | 查詢今天起 N 天內未取消的賽事，並附上最近 14 天已結束、尚未記錄成績的賽事 |
| `update_race` | 修改賽事名稱、日期、距離、目標時間、報名狀態、備註 |
| `cancel_race` | 標記賽事為已取消 |
| `update_race_result` | 記錄實際完賽時間 |
| `update_athlete_profile` | 更新選手資料欄位 |

賽事相關 tool 的 `race_id` 直接取自 system prompt 的賽事清單（近期目標賽事、待記錄成績的賽事），清單中沒有時才呼叫 `get_upcoming_races` 查詢。

### 6.3 LLM 呼叫層（`llm.py`）

專案中唯一 `import anthropic` 的模組 [KI-018]。對外介面與供應商無關：

| 介面 | 說明 |
|------|------|
| `complete(purpose, prompt, max_tokens)` | 單次生成，用於跑後摘要（`summary`）與對話壓縮（`compress`） |
| `run_with_tools(system, messages, tools, execute_tool)` | 主對話：模型要求呼叫 tool 時執行並回傳結果，直到產生最終文字 |
| `Result` | `text`、`usage`、`finish`（`ok` / `refused` / `truncated`） |
| `Usage` | 逐輪累加：第一輪輸入、未快取輸入、快取讀寫、輸出、呼叫次數、tool 輪數 |
| `LLMError` | `complete()` 遇到模型拒絕回答或沒有產生文字時拋出，避免把空內容存檔 |
| `describe_models()` | 各用途實際使用的模型與思考強度，供 `/status` 顯示 |

行為：

- **模型選擇**：依用途讀取 `CLAUDE_MODEL`（主對話）、`CLAUDE_MODEL_SUMMARY`、`CLAUDE_MODEL_COMPRESS`；後兩者未設定時沿用 `CLAUDE_MODEL`
- **思考強度**：以 `output_config.effort` 控制。主對話讀 `CLAUDE_CHAT_EFFORT`（預設 `medium`），摘要與壓縮固定 `low`。不支援此參數的模型（Sonnet 4.5、Haiku 4.5）自動略過 [KI-019]
- **輸出上限**：含思考 token。主對話為 `MAX_RESPONSE_TOKENS`（16000），摘要與壓縮為 2000；內容長度由 prompt 的字數要求控制
- **Tool call 迴圈**：最多 `TOOL_CALL_MAX_ROUNDS`（5）輪。模型回應（含思考區塊）原封不動加回對話。超過上限時保留 tools 並設 `tool_choice: none`，取得最終回應
- **回應讀取**：依區塊類型取文字，不依位置（回應可能以思考區塊開頭）

目前採用的分層設定 [KI-020]：

| 用途 | 模型 | 思考強度 | 理由 |
|------|------|------|------|
| 主對話（教練對話、排課表、tool use） | `claude-opus-5-5` | `medium` | 需要判斷力的部分用最強的模型 |
| 跑後分析摘要 | `claude-haiku-5-5` | `low` | 輸入是結構化數據、輸出 150 字，簡單且量多 |
| 對話壓縮 | `claude-sonnet-5-5` | `low` | 摘要是唯一的長期記憶，寫錯會持續累積，不用最小的模型 |

快取、思考等 Claude 特有功能是本模組的實作細節。換供應商時只需改寫這個檔案；tool 定義是 JSON Schema，屆時在此轉換欄位名稱即可。

### 6.4 Context Manager（`memory/context_manager.py`）

`get_context_for_api()` 回傳：

```python
{
    "system": str,          # 層1
    "messages": [...],      # 層4（user/assistant 一組，有摘要時）+ 層5
    "layer_chars": {...},   # 各層字元數，供頁尾估算
}
```

另提供 `should_compress()`、`get_conversations_to_compress()`、`apply_compression()` 與 `/status` 用的 `get_status_summary()`。

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `CONVERSATION_MAX` | 20 | 對話數超過此值觸發壓縮；也是層5 視窗的上限 |
| `CONVERSATION_KEEP` | 10 | 壓縮後保留的對話數 |
| `CONVERSATION_MSG_MAX_CHARS` | 600 | 單則訊息送出前的截斷長度 |
| `RACE_LOOKAHEAD_DAYS` | 90 | 注入 system prompt 的賽事前瞻天數 |
| `RACE_LOOKBACK_DAYS` | 14 | 已結束、尚未記錄成績的賽事保留在清單中的天數 |

### 6.5 Intervals Tool（`tools/intervals_tool.py`）

- **認證**：HTTP Basic Auth，使用者名稱固定為 `API_KEY`，密碼為 `INTERVALS_API_KEY`。靜態金鑰，沒有 token 更新流程
- **選手 ID**：`INTERVALS_ATHLETE_ID`，預設 `0`（代表金鑰所屬的選手）
- **活動查詢**：`GET /api/v1/athlete/{id}/activities?oldest=&newest=`（日期區間）

| 方法 | 說明 |
|------|------|
| `fetch_latest_activity()` | 查最近 7 天，回傳最新一筆跑步活動 |
| `fetch_activities(days=14)` | 回傳指定天數內的跑步活動，由新到舊 |
| `fetch_activity_laps(id)` | 階段四預留：`/activity/{id}/intervals` |
| `fetch_activity_streams(id)` | 階段四預留：`/activity/{id}/streams.json`，每 10 秒取樣 |

活動類型名稱含 `run` 即視為跑步。正規化後的欄位：`intervals_id`、`date`、`distance_km`、`duration_min`（移動時間）、`avg_hr`、`max_hr`、`avg_pace`、`elevation_m`、`calories`、`training_load`、`raw_json`。

手錶資料需直接由 Garmin Connect 同步到 Intervals.icu（本專案即為此設定，不經 Strava）。

### 6.6 Scripts

- `scripts/init_profile.py`：互動式輸入選手資料。需在容器環境執行：`docker compose run --rm coach-bot python scripts/init_profile.py`
- `scripts/test_intervals.py`：測試 Intervals.icu 連線與資料解析，可讀 `.env` 或命令列參數

---

## 7. 容器化與部署

### 7.1 Dockerfile

```dockerfile
FROM python:3.12-slim

ENV PYTHONUTF8=1          # 避免中文輸入的編碼錯誤
ENV TZ="Asia/Taipei"

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/
COPY scripts/ ./scripts/
RUN mkdir -p /app/data

CMD ["python", "src/main.py"]
```

套件安裝層會被 Docker 快取：只有 `requirements.txt` 變動時才重新安裝，因此 VM 上的套件版本停在上次變動當時。

### 7.2 docker-compose.yml

```yaml
services:
  coach-bot:
    build: .
    container_name: running-coach
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

`./data` 在 VM 本地，容器重建不影響資料。容器異常結束或 VM 重開機後由 `restart: unless-stopped` 自動啟動。

### 7.3 自動部署（GitHub Actions self-hosted runner）

VM 上常駐一個 GitHub Actions runner（註冊為系統服務）。任何 push 到 `main` 都會在 VM 上執行：

```bash
git pull origin main
docker compose up --build -d
```

- VM 由內向外連線到 GitHub，不需對外開放 SSH，也不需在 GitHub 存放主機金鑰
- `.env` 不在 git 中，部署不會覆蓋它
- 只改 `.env` 時不需重新部署，執行 `docker compose restart` 即可

詳細設定步驟見 [deployment-guide.md](deployment-guide.md)。

---

## 8. 環境變數

```bash
# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Discord
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_CHANNEL_ID=123456789012345678

# Intervals.icu（從 intervals.icu/settings 的 Developer settings 取得）
INTERVALS_API_KEY=your_api_key_here
INTERVALS_ATHLETE_ID=0

# Agent 參數（可選，有預設值）
CLAUDE_MODEL=claude-opus-5-5              # 主對話
CLAUDE_CHAT_EFFORT=medium                 # 主對話思考強度：low / medium / high
CLAUDE_MODEL_SUMMARY=claude-haiku-5-5     # 跑後分析摘要；未設定則沿用 CLAUDE_MODEL
CLAUDE_MODEL_COMPRESS=claude-sonnet-5-5   # 對話壓縮；未設定則沿用 CLAUDE_MODEL
CONVERSATION_MAX=20
CONVERSATION_KEEP=10
CONVERSATION_MSG_MAX_CHARS=600
RACE_LOOKAHEAD_DAYS=90
RACE_LOOKBACK_DAYS=14               # 賽後可補登成績的天數
MAX_RESPONSE_TOKENS=16000        # 含思考 token
```

另有 `TOOL_CALL_MAX_ROUNDS`（預設 5）與 `DB_PATH`（預設 `/app/data/coach.db`）可覆寫。

思考強度的變數刻意不命名為 `CLAUDE_EFFORT`：該名稱與 Claude Code 自身的環境變數相同，在其終端機中執行 bot 時會被覆寫。

### 8.1 安全注意事項

- `.env` 列入 `.gitignore`，只存在 VM
- `./data/` 目錄設定適當權限（`chmod 700 data/`）
- Discord Bot Token 洩漏時到 Developer Portal 重新產生
- Intervals.icu API Key 洩漏時到 Intervals.icu 設定頁重新產生

---

## 9. 費用

### 9.1 Anthropic API

目前單價（2026-10-09 查詢，每百萬 token）：

| 模型 | 用途 | 輸入 | 輸出 | 快取讀取 |
|------|------|------|------|------|
| Claude Opus 5.5 | 主對話 | $4 | $20 | $0.20 |
| Claude Sonnet 5.5 | 對話壓縮 | $2 | $10 | $0.10 |
| Claude Haiku 5.5 | 跑後分析摘要 | $0.10 | $0.50 | $0.01 |

Haiku 5.5 的價格適用於 prompt 不超過 10 萬 token 的請求（超過則為 5 倍）；摘要的 prompt 遠低於此。
主對話用 Opus 5.5 的單價是 Sonnet 5.5 的兩倍，是刻意以成本換取品質的選擇 [KI-020]。

v1.3 估算每次呼叫約 1,800 輸入 token、每月約 $1.5，實際會更高，原因：

- 13 個 tool 定義每次都會送出，當時未計入
- 每一輪 tool call 都重送整段 context，一次跑後回報通常有 3–4 輪
- 5.5 世代模型的 tokenizer 對同樣文字會多出約 30% token，且有思考 token

實際用量以 Discord 頁尾的「累計輸入」與 log 為準，**尚未以實際紀錄重新估算每月費用**。

已採取的成本控制：層2、層3 按需載入、長訊息截斷、摘要與壓縮改用較便宜的模型並固定最低思考強度。尚未實作：輸入快取（prompt caching）——主對話改用 Opus 5.5 後，這一項的效益更大。

### 9.2 其他

- Intervals.icu API：免費
- GCP VM：使用既有 VM，無額外費用
- GitHub Actions：self-hosted runner 不消耗免費額度

---

## 10. 開發階段

### 階段一：基礎對話 ✅

Discord Bot、SQLite、基本 Agent Loop、層1 + 層5、容器化、選手資料初始化。

### 階段二：完整記憶與賽事管理 ✅

對話壓縮、五層 context、賽事注入、賽事與選手資料 tools、`/plan` `/profile` `/status`。

### 階段三：活動資料整合與跑後回報 ✅

原以 Strava 實作，2026-09 改為 Intervals.icu [KI-016]。跑後回報、主觀感受暫存、`/sync`、訓練歷史與配速趨勢 tools。

### 階段三之後的調整 ✅

| 項目 | 出處 |
|------|------|
| 賽事修改與取消 | KI-002 |
| 選手生理資料、心率區間、訓練偏好 | KI-003、KI-008 |
| 回應長度上限放寬 | KI-004、KI-019 |
| Token 用量頁尾與累計統計 | KI-013、KI-018 |
| 長訊息截斷；層2、層3 改為按需載入 | KI-014、KI-015 |
| 對話摘要結構化、延續更新 | KI-011 |
| 資料來源改為 Intervals.icu；GitHub Actions 自動部署 | KI-016 |
| 層5 視窗空窗修正 | KI-017 |
| LLM 呼叫層、分用途模型 | KI-018 |
| 模型遷移至 5.5 世代（Sonnet 4.5 退役） | KI-019 |
| 模型依用途分層（Opus / Sonnet / Haiku 5.5） | KI-020 |
| 賽後 14 天內可補登成績 | KI-021 |
| `/status` 顯示模型設定與實際載入方式 | KI-022 |
| 一週起始日統一為週一 | KI-006 |

### 階段四：進階分析（間歇跑與心率曲線）⬜ 未實作

- [ ] `/sync` 時拉取並儲存 `laps_json`、`streams_json`（API 方法已預留）
- [ ] `get_workout_laps`、`get_hr_stream` 兩個 tool
- [ ] 間歇跑的分組分析摘要格式
- [ ] 跑步子類型（LSD、節奏跑、間歇等）與同類型比較 [KI-009][KI-010]

### 後續規劃

- 輸入快取（prompt caching），並修正頁尾的分層估算
- 獨立行動 App 的評估見 [project-review-and-roadmap.md](project-review-and-roadmap.md)

---

## 11. 相依套件

```
anthropic>=0.40.0
discord.py>=2.3.0
requests>=2.31.0          # Intervals.icu API
tzdata>=2024.1            # zoneinfo 所需的時區資料
```

Python 版本：3.12。`llm.py` 已在 anthropic SDK 0.88 與 1.11 上驗證過 request 形狀與回應處理。

---

## 12. 已知風險與限制

| 風險或限制 | 對應方式 |
|------|---------|
| 跑後立即回報時，手錶資料尚未同步到 Intervals.icu | 日期驗證後告知；主觀感受暫存，`/sync` 後合併 |
| 模型退役（Sonnet 4.5 於 2026-11-30 退役） | 已遷移至 5.5 世代模型；模型以 `.env` 設定，換模型的程式改動集中在 `llm.py`。定期查看官方的 model deprecations 頁面 |
| 模型拒絕回答或輸出被截斷 | 主對話回提示訊息；摘要與壓縮不存檔並於下輪重試 [KI-019] |
| 連續快速送訊息可能重複壓縮 | 個人使用情境下極少發生，尚未處理 [KI-001] |
| 同一筆活動重複回報會多存一份摘要 | 訓練紀錄查詢可能出現重複列；尚未處理 |
| 日期計算（相差天數、星期幾）可能出錯 | 今天日期與距賽事天數由程式計算後注入；其餘尚未處理 [KI-007] |
| 頁尾的分層 token 為估算值 | 見 3.7；以「輸入」「累計輸入」與快取欄位為準 |
| Discord Bot Token 或 API Key 洩漏 | 立即重新產生 |
| SQLite 資料損毀 | 定期備份 `data/coach.db` |

其餘未解決事項見 [known-issues.md](known-issues.md)。
