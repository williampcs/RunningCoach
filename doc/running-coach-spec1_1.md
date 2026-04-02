# Running Coach Agent — 系統規格文件

**版本**：1.1  
**最後更新**：2026-03-31  
**狀態**：待實作

### 版本異動紀錄

| 版本 | 日期 | 變動內容 |
|------|------|---------|
| 1.0 | 2026-03-30 | 初版 |
| 1.1 | 2026-03-31 | 資料來源改為 Strava 官方 API；workouts table 新增體感強度與主觀感受欄位；新增跑後回報自動觸發流程；移除 Garmin 帳密，改用 OAuth2 token |

---

## 1. 專案概述

### 1.1 目標

建立一個部署在 GCP VM 容器中的跑步教練 AI Agent，透過 Discord 作為使用者介面，解決長對話後 AI 輸出品質下降的問題。核心解法是主動管理送進 LLM 的 context 內容，而非依賴模型自身的記憶能力。

### 1.2 使用情境

- 訓練前：在 Discord 詢問今天的訓練目標與建議
- 訓練後：輸入體感強度與主觀感受，系統自動從 Strava 拉取客觀數據合併分析
- 隨時：詢問配速、飲食、裝備等跑步相關問題
- 定期：手動執行 `/sync` 補同步近期資料

### 1.3 核心設計原則

- **Context Engineering 優先**：所有進入 Claude 的內容都經過主動管理，確保品質不隨時間下降
- **主客觀資料合併**：客觀數據來自 Strava API，主觀體感由使用者輸入，兩者合併才是完整的訓練紀錄
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
│ 固定選手資料：目標、PB、傷病注意事項             │
│ 來源：athlete_profile table                     │
│ 更新頻率：使用者明確更新時                      │
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

### 3.3 對話壓縮邏輯

當 `conversations` table 的輪數超過閾值（預設 20 輪），自動觸發：

1. 取出最舊的（總輪數 - 保留輪數）筆對話
2. 呼叫 Claude 壓縮成重點摘要，保留：
   - 訓練決策（調整了什麼、為什麼）
   - 重要發現（狀態異常、突破、傷病跡象）
   - 選手當時的狀態描述
3. 新摘要存入 `summaries`，舊摘要與原始對話刪除

### 3.4 跑後回報流程（主客觀資料合併）

這是系統最重要的資料進入點。使用者只需輸入主觀感受，客觀數據由系統自動補入。

```
使用者在 Discord 輸入跑後感受，例如：
「剛跑完，體感 7/10，腿有點重，呼吸順，右膝無異狀」

Agent 偵測到跑後回報意圖
        ↓
自動呼叫 Strava Tool，拉取今天最新的跑步活動
        ↓
解析使用者輸入，萃取：
  - 體感強度（perceived_effort）：7
  - 主觀感受（subjective_notes）：「腿有點重，呼吸順，右膝無異狀」
        ↓
合併客觀數據（Strava）+ 主觀資料（使用者輸入）
存入 workouts table
        ↓
呼叫 Claude 生成完整訓練分析摘要
存入 workout_summaries table
        ↓
Claude 回應分析結果給使用者
```

**跑後回報意圖偵測**：

Agent 的 system prompt 中定義，當訊息包含以下特徵時視為跑後回報：
- 出現「跑完」、「剛跑」、「今天跑」等關鍵詞
- 出現體感數字（如「7/10」、「體感7」）
- 出現身體感受描述（「腿重」、「呼吸」、「心率」、膝蓋等部位）

若偵測失誤（如 Strava 尚未同步），告知使用者「尚未在 Strava 找到今天的跑步活動，請稍後再試或使用 `/sync` 手動同步」。

### 3.5 手動同步流程

```
使用者在 Discord 輸入 /sync
        ↓
Strava Tool 拉取最近 14 天的跑步活動
        ↓
以 strava_id 去重，只處理新資料
        ↓
新資料存入 workouts（subjective_notes 欄位留空）
        ↓
對每筆新資料生成僅含客觀數據的摘要
存入 workout_summaries
        ↓
回傳「已同步 N 筆新資料」
```

手動 `/sync` 主要用於補同步過去資料，或跑後回報失敗時的備案。透過跑後回報流程進來的資料才包含完整的主觀資訊。

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
-- 初始資料：goal, pb, injuries, weekly_km_target

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
    raw_json          TEXT,               -- Strava 原始回應
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
```

### 4.2 workout_summaries 摘要格式

**完整版**（跑後回報流程，含主觀資料）：
```
2026-03-30｜輕鬆跑 8.2km｜配速 5:45/km｜平均心率 142bpm
體感強度：7/10｜感受：腿有點重，呼吸順，右膝無異狀
AI 評估：心率正常但體感偏高，可能為累積疲勞，建議明日降強度。
```

**客觀版**（手動 `/sync`，無主觀資料）：
```
2026-03-28｜輕鬆跑 6.5km｜配速 5:52/km｜平均心率 138bpm
體感資料：未記錄
AI 評估：數據正常，無異常跡象。
```

### 4.3 資料保留策略

| Table | 保留策略 |
|-------|---------|
| athlete_profile | 永久，使用者更新時覆寫 |
| workouts | 永久，不刪除 |
| workout_summaries | 永久，不刪除 |
| training_plans | 永久，新計畫新增，is_active 標記當前 |
| conversations | 滾動，超過閾值後舊的被壓縮刪除 |
| summaries | 保留最新一筆，舊的在新摘要生成後刪除 |
| strava_tokens | 永久，access token 過期時自動 refresh |

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
  - `/sync`：手動觸發 Strava 資料同步（補同步用）
  - `/plan [內容]`：更新本週訓練計畫
  - `/profile [key] [value]`：更新選手資料
  - `/status`：顯示目前記憶層摘要（debug 用）
- 一般文字訊息直接送給 Agent 處理（包含跑後回報）

**錯誤處理**：
- API 呼叫失敗時回傳「目前無法回應，請稍後再試」
- Strava 拉不到資料時明確告知，不靜默失敗
- 不對使用者暴露技術錯誤細節

### 6.2 Agent Loop（`agent/loop.py`）

**職責**：組合 context、呼叫 Claude API、處理 tool call 迴圈

**行為規格**：
- 每次收到訊息，從 Context Manager 取得完整 context
- 呼叫 Claude API（模型：`claude-sonnet-4-5-20251001`）
- 若回應包含 tool call，執行對應工具後繼續迴圈
- 最多執行 5 輪 tool call，避免無限迴圈
- 最終文字回應存入 conversations，回傳給 Bot

**Tool 定義**（供 Claude 呼叫）：

```
fetch_latest_strava_activity()
  → 拉取 Strava 上最新一筆跑步活動
  → 用途：跑後回報時自動補入客觀數據

save_workout(strava_data: dict, perceived_effort: int, subjective_notes: str)
  → 合併客觀與主觀資料，存入 workouts table，生成摘要
  → 用途：跑後回報流程的最終儲存步驟

get_recent_workouts(days: int)
  → 從 DB 取最近 N 天的跑步資料（含主觀感受）
  → 用途：使用者問具體訓練細節時

get_pace_trend(weeks: int)
  → 計算過去 N 週的週平均配速
  → 用途：趨勢分析

save_training_plan(week_label: str, content: str)
  → 儲存訓練計畫到 DB
  → 用途：Coach 制定或更新計畫時

update_athlete_profile(key: str, value: str)
  → 更新選手固定資料
  → 用途：目標、PB、傷病更新
```

### 6.3 Context Manager（`memory/context_manager.py`）

**職責**：組合五層 context，管理對話壓縮觸發

**`get_context_for_api()` 回傳格式**：

```python
{
    "system": str,       # 層1：選手資料 system prompt
    "messages": [
        # 層2：最近 N 筆 workout_summaries（user/assistant pair）
        # 層3：當前 training_plan（user/assistant pair）
        # 層4：最新 summary（user/assistant pair，若有）
        # 層5：conversations 最近 N 輪
    ]
}
```

**壓縮觸發條件**：`conversations` table 超過 20 筆時，保留最新 10 筆，其餘壓縮

**可調整參數**（`config.py`）：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `CONVERSATION_MAX` | 20 | 超過此數觸發壓縮 |
| `CONVERSATION_KEEP` | 10 | 壓縮後保留的輪數 |
| `WORKOUT_SUMMARY_COUNT` | 7 | 注入 context 的跑步摘要筆數 |

### 6.4 Strava Tool（`tools/strava_tool.py`）

**職責**：與 Strava 官方 API 溝通，處理 token 管理與資料拉取

**認證方式**：OAuth2。Access token 存在 `strava_tokens` table，過期前自動用 refresh token 換新，不需要儲存帳號密碼。

**初始授權流程**（一次性，部署時執行）：

```bash
python scripts/strava_auth.py
# 輸出一個 URL，在瀏覽器開啟並授權
# 授權完成後自動將 token 存入 DB
```

**主要方法**：

```
fetch_latest_activity() → dict
  呼叫 GET /athlete/activities?per_page=1
  回傳最新一筆跑步活動的完整資料

fetch_activities(days: int) → list[dict]
  呼叫 GET /athlete/activities
  回傳指定天數內的跑步活動列表

_refresh_token_if_needed()
  檢查 expires_at，過期前 5 分鐘自動換新 token
  新 token 更新回 strava_tokens table
```

**Strava API 限制**：每 15 分鐘 200 次、每天 2000 次。本系統每天最多呼叫數次，不會觸及限制。

### 6.5 `scripts/strava_auth.py`（一次性授權腳本）

部署到 VM 後執行一次，完成 OAuth 授權並將 token 存入 DB。之後系統自動維護 token 更新，不需要再手動操作。Strava refresh token 有效期限長（數月至數年），正常使用下不需要重新授權。

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
CLAUDE_MODEL=claude-sonnet-4-5-20251001
CONVERSATION_MAX=20
CONVERSATION_KEEP=10
WORKOUT_SUMMARY_COUNT=7
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
| 每次 call input token | ~1,700（system + 摘要 + window + 訊息） |
| 每次 call output token | ~400 |
| 每次費用（Sonnet） | ~$0.011 |
| 每天費用（4 次） | ~$0.044 |
| **每月費用** | **約 $1.3 USD** |

壓縮摘要與 Strava 分析的 call 每幾天才觸發，費用可忽略不計。

### 9.2 Strava API

免費，無費用。

### 9.3 GCP VM

已有閒置 VM，無額外費用。

---

## 10. 開發階段規劃

### 階段一：基礎對話（可用狀態）

目標：從手機 Discord 能跟 Claude 對話，資料基本存入 DB

- [ ] `db.py`：SQLite 初始化，建立所有 table（含 v1.1 新欄位）
- [ ] `discord_bot.py`：Bot 上線，接收/回傳訊息，支援斜線指令
- [ ] `loop.py`：基本 Agent Loop，無 tool call
- [ ] `context_manager.py`：只實作層1（system prompt）+ 層5（rolling window）
- [ ] `Dockerfile` + `docker-compose.yml`：容器可跑起來
- [ ] `scripts/init_profile.py`：初始化選手資料

**驗收標準**：在手機 Discord 發訊息，Claude 能回應，對話存入 DB

### 階段二：完整記憶（核心功能）

目標：實作完整五層 context，解決原始問題

- [ ] `summarizer.py`：對話壓縮邏輯
- [ ] `context_manager.py`：補完層2（workout summaries）、層3（training plan）、層4（對話摘要）
- [ ] 壓縮自動觸發機制
- [ ] `/plan` 指令：更新訓練計畫
- [ ] `/profile` 指令：更新選手資料
- [ ] `/status` 指令：顯示目前記憶狀態

**驗收標準**：對話超過 20 輪後，品質不下降；重開機後記憶完整保留

### 階段三：Strava 整合與跑後回報

目標：串接 Strava 資料，實現主客觀資料合併的跑後回報流程

- [ ] `scripts/strava_auth.py`：一次性 OAuth 授權腳本
- [ ] `strava_tool.py`：OAuth token 管理、活動拉取、去重
- [ ] 跑後回報意圖偵測邏輯（在 loop.py 的 system prompt 中定義）
- [ ] `save_workout` tool：合併主客觀資料，生成完整摘要
- [ ] `/sync` 指令：手動補同步
- [ ] Tool call 接線：`fetch_latest_strava_activity`、`get_recent_workouts`、`get_pace_trend`

**驗收標準**：
- 輸入「剛跑完，體感 7/10，腿有點重」，Claude 自動補入 Strava 數據並回傳完整分析
- `/sync` 後，過去跑步資料正確匯入 DB
- Token 過期後自動 refresh，不需要人工介入

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
| Strava 尚未同步 Garmin 資料（跑後立即回報） | 中 | 告知使用者等幾分鐘後再試，或手動輸入資料 |
| Strava OAuth token 失效（refresh token 過期） | 低 | 重新執行 `strava_auth.py`，約每數月一次 |
| 跑後回報意圖偵測誤判 | 低 | Claude 確認後再執行，使用者可更正 |
| Discord Bot Token 洩漏 | 低 | 立即到 Developer Portal 重新生成 |
| VM 重開機服務未啟動 | 低 | systemd `restart=always` 自動處理 |
| SQLite 資料損毀 | 極低 | 定期 `cp coach.db coach.db.bak` |
| Claude API 費用超出預期 | 極低 | 每月約 $1-2，有大幅緩衝空間 |
