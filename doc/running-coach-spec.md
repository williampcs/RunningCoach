# Running Coach Agent — 系統規格文件

**版本**：1.0  
**最後更新**：2026-03-30  
**狀態**：待實作

---

## 1. 專案概述

### 1.1 目標

建立一個部署在 GCP VM 容器中的跑步教練 AI Agent，透過 Discord 作為使用者介面，解決長對話後 AI 輸出品質下降的問題。核心解法是主動管理送進 LLM 的 context 內容，而非依賴模型自身的記憶能力。

### 1.2 使用情境

- 訓練前：在 Discord 詢問今天的訓練目標與建議
- 訓練後：回報本次跑步狀況，取得 AI 分析與調整建議
- 隨時：詢問配速、飲食、裝備等跑步相關問題
- 定期：同步 Garmin 跑步資料，更新訓練紀錄

### 1.3 核心設計原則

- **Context Engineering 優先**：所有進入 Claude 的內容都經過主動管理，確保品質不隨時間下降
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
│  │   ├─ Garmin Tool ←─────────────┼────┼── Garmin Connect
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
| 工具層 | Garmin Tool、Training Plan Tool | 提供 Agent 可呼叫的外部能力 |
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
│ System Prompt（層1）                            │
│ 固定選手資料：目標、PB、傷病注意事項             │
│ 來源：athlete_profile table                     │
│ 更新頻率：使用者明確更新時                      │
├─────────────────────────────────────────────────┤
│ 訓練歷史摘要（層2）                             │
│ 最近 N 筆 AI 生成的跑步分析                     │
│ 格式：日期／距離／配速／心率／AI 評語           │
│ 來源：workout_summaries table                   │
│ 更新頻率：每次 Garmin 同步後自動生成            │
├─────────────────────────────────────────────────┤
│ 當前訓練計畫（層3）                             │
│ 本週或當前週期的訓練計畫內容                    │
│ 來源：training_plans table（最新一筆）          │
│ 更新頻率：Coach 更新計畫時                      │
├─────────────────────────────────────────────────┤
│ 對話摘要（層4）                                 │
│ 歷史對話的壓縮版本（重要決策、狀態調整）        │
│ 來源：summaries table（最新一筆）               │
│ 更新頻率：對話輪數超過閾值時自動觸發            │
├─────────────────────────────────────────────────┤
│ Rolling Window（層5）                           │
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

### 3.4 Garmin 資料處理流程

```
使用者在 Discord 輸入 /sync
        ↓
Garmin Tool 呼叫 garminconnect API
        ↓
原始資料存入 workouts table（永久保留）
        ↓
自動呼叫 Claude 對每筆新資料生成分析摘要
        ↓
摘要存入 workout_summaries table
        ↓
之後所有對話的層2 context 自動包含最新摘要
```

原始跑步資料（`workouts` table）永久保留，供深度查詢使用（如：過去三個月配速趨勢）。進入日常 context 的是摘要版本，控制 token 用量。

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

-- Garmin 原始跑步資料（永久保留）
CREATE TABLE workouts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    garmin_id    TEXT UNIQUE,          -- 避免重複匯入
    date         TEXT NOT NULL,
    type         TEXT DEFAULT 'run',
    distance_km  REAL,
    duration_min REAL,
    avg_hr       INTEGER,
    max_hr       INTEGER,
    avg_pace     TEXT,                 -- 格式：'5:30/km'
    elevation_m  REAL,
    calories     INTEGER,
    raw_json     TEXT,                 -- 完整原始資料
    synced_at    TEXT NOT NULL
);

-- AI 生成的跑步分析摘要
CREATE TABLE workout_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    workout_id  INTEGER REFERENCES workouts(id),
    summary     TEXT NOT NULL,         -- AI 生成的分析文字
    created_at  TEXT NOT NULL
);

-- 訓練計畫
CREATE TABLE training_plans (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    week_label TEXT NOT NULL,          -- 例：'2026-W14'
    content    TEXT NOT NULL,          -- 計畫內容（純文字）
    created_at TEXT NOT NULL,
    is_active  INTEGER DEFAULT 1
);

-- 對話紀錄（rolling window 用）
CREATE TABLE conversations (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    role      TEXT NOT NULL,           -- 'user' 或 'assistant'
    content   TEXT NOT NULL,
    timestamp TEXT NOT NULL
);

-- 壓縮後的對話摘要
CREATE TABLE summaries (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    content         TEXT NOT NULL,
    covers_up_to_id INTEGER,           -- 壓縮到哪一輪對話為止
    created_at      TEXT NOT NULL
);
```

### 4.2 資料保留策略

| Table | 保留策略 |
|-------|---------|
| athlete_profile | 永久，使用者更新時覆寫 |
| workouts | 永久，不刪除 |
| workout_summaries | 永久，不刪除 |
| training_plans | 永久，新計畫新增，is_active 標記當前 |
| conversations | 滾動，超過閾值後舊的被壓縮刪除 |
| summaries | 保留最新一筆，舊的在新摘要生成後刪除 |

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
│       ├── garmin_tool.py        # Garmin 資料同步
│       └── training_plan_tool.py # 訓練計畫讀寫
└── scripts/
    └── init_profile.py           # 初始化選手資料用
```

---

## 6. 元件規格

### 6.1 Discord Bot（`bot/discord_bot.py`）

**職責**：接收 Discord 訊息，轉發給 Agent，回傳結果

**行為規格**：
- 監聽指定 channel ID 的訊息（環境變數設定）
- 收到訊息時顯示 typing 狀態
- 回應超過 2000 字時自動切割分段送出
- 支援以下指令：
  - `/sync`：觸發 Garmin 資料同步
  - `/plan [內容]`：更新本週訓練計畫
  - `/profile [key] [value]`：更新選手資料
  - `/status`：顯示目前記憶層摘要（debug 用）
- 一般文字訊息直接送給 Agent 處理

**錯誤處理**：
- API 呼叫失敗時回傳「目前無法回應，請稍後再試」
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
get_recent_workouts(days: int)
  → 從 DB 取最近 N 天的跑步原始資料
  → 用途：使用者問具體訓練細節時

get_pace_trend(weeks: int)
  → 計算過去 N 週的週平均配速
  → 用途：趨勢分析

save_training_plan(week_label: str, content: str)
  → 儲存訓練計畫到 DB
  → 用途：Coach 制定計畫時

update_athlete_profile(key: str, value: str)
  → 更新選手固定資料
  → 用途：目標、PB、傷病更新
```

### 6.3 Context Manager（`memory/context_manager.py`）

**職責**：組合五層 context，管理對話壓縮觸發

**`get_context_for_api()` 回傳格式**：

```python
{
    "system": str,           # 層1：選手資料
    "messages": [
        # 層2：workout_summaries（以 user/assistant pair 注入）
        # 層3：training_plans（以 user/assistant pair 注入）
        # 層4：summaries（以 user/assistant pair 注入）
        # 層5：conversations（最近 N 輪原始對話）
    ]
}
```

**壓縮觸發條件**：`conversations` table 超過 20 筆時，保留最新 10 筆，其餘壓縮

**參數（可在 config.py 調整）**：

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `CONVERSATION_MAX` | 20 | 超過此數觸發壓縮 |
| `CONVERSATION_KEEP` | 10 | 壓縮後保留的輪數 |
| `WORKOUT_SUMMARY_COUNT` | 7 | 注入 context 的跑步摘要筆數 |

### 6.4 Garmin Tool（`tools/garmin_tool.py`）

**職責**：從 Garmin Connect 拉取跑步資料，存入 DB，生成摘要

**觸發方式**：使用者在 Discord 輸入 `/sync`（手動觸發，不做定時自動同步）

**執行步驟**：
1. 用 `garminconnect` library 登入 Garmin Connect
2. 拉取最近 14 天的跑步活動
3. 以 `garmin_id` 去重，只處理新資料
4. 原始資料存入 `workouts` table
5. 對每筆新資料呼叫 Claude 生成分析摘要（約 50-80 字）
6. 摘要存入 `workout_summaries` table
7. 回傳「已同步 N 筆新資料」

**摘要格式範例**：
```
2026-03-28｜輕鬆跑 8.2km｜配速 5:45/km｜平均心率 142bpm
狀態評估：心率略高於預期，建議明日降強度或休息。
```

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
      - ./data:/app/data        # SQLite 持久化
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"
```

**重點**：`./data` 目錄在 VM 本地，容器重建或映像更新不影響資料。

### 7.3 VM 上的 systemd 設定

用 systemd 管理 docker-compose，確保 VM 重開機後自動啟動：

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

# Garmin
GARMIN_EMAIL=your@email.com
GARMIN_PASSWORD=yourpassword

# Agent 參數（可選，有預設值）
CLAUDE_MODEL=claude-sonnet-4-5-20251001
CONVERSATION_MAX=20
CONVERSATION_KEEP=10
WORKOUT_SUMMARY_COUNT=7
```

### 8.2 安全注意事項

- `.env` 加入 `.gitignore`，不進版本控制
- Garmin 密碼以明文存在 `.env`，確保 VM 的檔案權限設定正確（`chmod 600 .env`）
- Discord Bot Token 如洩漏請立即到 Discord Developer Portal 重新生成

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

壓縮摘要與 Garmin 分析的 call 每幾天才觸發，費用可忽略不計。

### 9.2 GCP VM

已有閒置 VM，無額外費用。

---

## 10. 開發階段規劃

### 階段一：基礎對話（可用狀態）

目標：從手機 Discord 能跟 Claude 對話，資料基本存入 DB

- [ ] `db.py`：SQLite 初始化，建立所有 table
- [ ] `discord_bot.py`：Bot 上線，接收/回傳訊息
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

### 階段三：Garmin 整合

目標：串接 Garmin 資料，讓 Coach 有實際數據

- [ ] `garmin_tool.py`：Garmin Connect 登入、拉取、去重
- [ ] 跑步資料存入 `workouts`
- [ ] AI 自動生成 `workout_summaries`
- [ ] `/sync` 指令接線
- [ ] Tool call 接線：`get_recent_workouts`、`get_pace_trend`

**驗收標準**：`/sync` 後，對話中 Claude 能主動引用最近的跑步數據

---

## 11. 相依套件

```
# requirements.txt
anthropic>=0.40.0
discord.py>=2.3.0
garminconnect>=0.2.19
```

Python 版本：3.12+

---

## 12. 已知風險與對應方式

| 風險 | 可能性 | 對應方式 |
|------|--------|---------|
| Garmin API 被封鎖（非官方 library） | 中 | 手動貼數據進 Discord 作為備案，系統其他功能不受影響 |
| Discord Bot Token 洩漏 | 低 | 立即到 Developer Portal 重新生成 |
| VM 重開機服務未啟動 | 低 | systemd `restart=always` 自動處理 |
| SQLite 資料損毀 | 極低 | 定期 `cp coach.db coach.db.bak` |
| Claude API 費用超出預期 | 極低 | 每月約 $1-2，有大幅緩衝空間 |
