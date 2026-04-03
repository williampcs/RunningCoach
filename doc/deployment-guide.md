# Running Coach — 部署與測試指南

**最後更新**：2026-04-03
**適用版本**：Phase 1（spec v1.3）

---

## 一、部署架構說明

```
本機（開發）
  │  git push
  ▼
GCP VM（~/projs/RunningCoach/）
  │  docker compose up --build -d
  ▼
Docker Container: running-coach
  │  volume mount
  ▼
VM 本地 ./data/coach.db  ←→  容器內 /app/data/coach.db
```

**重要原則**：
- Code 與 image 在 VM 上 build
- DB 永遠存在 VM 的 `./data/` 目錄，透過 volume mount 讓容器存取
- `.env` 只放在 VM，不進 git
- `scripts/init_profile.py` 必須透過容器執行（`docker compose run`），不能直接在 VM 上跑 python

---

## 二、首次部署步驟

### Step 1：取得 code

```bash
git clone <your-repo> ~/projs/RunningCoach
cd ~/projs/RunningCoach
```

### Step 2：建立 .env

```bash
cp .env.example .env
nano .env
```

必填欄位：

```bash
ANTHROPIC_API_KEY=sk-ant-...
DISCORD_BOT_TOKEN=...
DISCORD_ALLOWED_CHANNEL_ID=你的頻道ID
CLAUDE_MODEL=claude-sonnet-4-5
```

Strava 相關欄位 Phase 3 再填，目前留空即可。

### Step 3：建立 data 目錄

```bash
mkdir -p data
chmod 700 data
```

### Step 4：Build 並啟動

```bash
docker compose up --build -d
```

確認啟動成功：

```bash
docker compose logs -f
# 預期看到：
# DB initialized at /app/data/coach.db
# Slash commands synced.
# Bot online: RunningCoach#XXXX (id=...)
```

> **正常 WARNING 可忽略**：`PyNaCl is not installed, voice will NOT be supported`
> 這是語音功能相關，本 Bot 不使用語音，無影響。

### Step 5：初始化選手資料（一次性）

```bash
docker compose run --rm coach-bot python scripts/init_profile.py
```

互動式輸入長期目標、PB、傷病注意事項等。之後若需要更新，使用 Discord 的 `/profile` 指令即可。

---

## 三、Discord Bot 設定（Developer Portal）

### 必要 Intent

**Bot → Privileged Gateway Intents**：

| Intent | 狀態 |
|--------|------|
| Message Content Intent | ✅ 開啟（必要，否則收不到訊息內容） |
| Presence Intent | 關閉 |
| Server Members Intent | 關閉 |

### 最小權限

**Bot Permissions（文字權限）**：

| 權限 | 狀態 |
|------|------|
| 傳送訊息（Send Messages） | ✅ |
| 讀取訊息歷史記錄（Read Message History） | ✅ |
| 使用斜線指令（Use Slash Commands） | ✅ |

其餘全部不需要勾選。

### 取得 Channel ID

1. Discord 設定 → 進階 → 開啟「開發者模式」
2. 右鍵點擊目標頻道 → 複製頻道 ID

### 邀請 Bot 進伺服器

OAuth2 → URL Generator：
- Scopes：`bot` + `applications.commands`
- Bot Permissions：勾選上述三項
- 複製 URL 到瀏覽器完成授權

---

## 四、日常維護指令

```bash
# 查看即時 log
docker compose logs -f

# 更新 code 後重新部署
git pull
docker compose up --build -d

# 重啟（修改 .env 後不需要 rebuild，restart 即可）
docker compose restart

# 停止
docker compose down

# 更新選手資料（互動式）
docker compose run --rm coach-bot python scripts/init_profile.py
```

**rebuild vs restart 的區別**：
- 改了 `src/` 程式碼或 `Dockerfile` → 需要 `--build`
- 只改了 `.env` 環境變數 → 只需要 `restart`

---

## 五、查詢 DB

DB 透過 volume mount 在 VM 本地，直接在 VM 上查詢（不需要進容器）：

```bash
# 在 VM 上安裝 sqlite3（若尚未安裝）
sudo apt install -y sqlite3

# 查看最近對話
sqlite3 ~/projs/RunningCoach/data/coach.db \
  "SELECT role, substr(content,1,80) FROM conversations ORDER BY id DESC LIMIT 10;"

# 查看選手資料
sqlite3 ~/projs/RunningCoach/data/coach.db "SELECT * FROM athlete_profile;"

# 查看近期賽事
sqlite3 ~/projs/RunningCoach/data/coach.db "SELECT * FROM races ORDER BY date;"

# 查看訓練計畫
sqlite3 ~/projs/RunningCoach/data/coach.db \
  "SELECT week_label, substr(content,1,80) FROM training_plans WHERE is_active=1;"
```

或用 Python 在容器內查詢（不需要在 VM 安裝 sqlite3）：

```bash
docker exec -it running-coach python3 -c "
import sqlite3
conn = sqlite3.connect('/app/data/coach.db')
rows = conn.execute('SELECT role, substr(content,1,60) FROM conversations ORDER BY id DESC LIMIT 5').fetchall()
for r in rows: print(r)
"
```

---

## 六、驗收測試項目（Phase 1）

### T1：Bot 上線確認

```bash
docker compose logs | grep "Bot online"
```

預期輸出：`Bot online: RunningCoach#XXXX (id=...)`

### T2：基本對話

在 Discord 指定 channel 傳送：
> 「今天想做輕鬆跑，有什麼建議？」

✅ Bot 顯示打字中狀態
✅ Claude 回應繁體中文建議
✅ 回應帶入選手資料（長期目標、PB 等）

### T3：斜線指令

| 指令 | 輸入範例 | 預期結果 |
|------|---------|---------|
| `/profile` | `/profile goal_long_term 2026年底半馬破二` | 回應「已更新 goal_long_term」 |
| `/plan` | `/plan 週一輕鬆跑8km，週三間歇6x400m` | 回應「訓練計畫已更新（XXXX-WXX）」 |
| `/status` | `/status` | 顯示選手資料筆數、對話筆數、近期賽事數、訓練計畫狀態 |
| `/sync` | `/sync` | 回應「Strava 同步功能將於 Phase 3 開放」 |

### T4：非指定 channel 隔離

在**其他 channel** 傳訊息，確認 Bot 完全不回應。

### T5：DB 資料確認

```bash
sqlite3 ~/projs/RunningCoach/data/coach.db \
  "SELECT role, substr(content,1,60) FROM conversations ORDER BY id DESC LIMIT 5;"
```

✅ 對話有正確寫入

### T6：容器重啟後資料保留

```bash
docker compose restart
```

重啟後再次對話，確認選手資料與對話記憶完整保留。

### T7：錯誤處理

暫時在 `.env` 填入錯誤的 `ANTHROPIC_API_KEY`，傳訊息後：

✅ Bot 回應「目前無法回應，請稍後再試。」
✅ 不對使用者暴露 stack trace 或技術細節

---

## 七、已遇問題與解法

### 問題 1：`init_profile.py` 直接在 VM 跑出現 `KeyError: ANTHROPIC_API_KEY`

**原因**：在容器外執行時，`.env` 不會自動載入，`config.py` import 時就要求所有環境變數。

**解法**：`init_profile.py` 必須透過容器執行：

```bash
docker compose run --rm coach-bot python scripts/init_profile.py
```

`docker compose run` 會自動套用 `env_file: .env` 與 volume mount，環境與容器完全一致。

---

### 問題 2：`init_profile.py` 輸入中文出現 `UnicodeEncodeError: surrogates not allowed`

**原因**：`python:3.12-slim` base image 未設定 locale，Python I/O 預設不使用 UTF-8，讀取中文 input() 時產生非法 surrogate 字元。

**解法**：在 `Dockerfile` 加入：

```dockerfile
ENV PYTHONUTF8=1
```

需重新 build：`docker compose up --build -d`

---

### 問題 3：Bot 回覆「目前無法回應」，log 顯示 `404 model: claude-sonnet-4-5-20251001`

**原因**：spec 中的 model 名稱 `claude-sonnet-4-5-20251001` 不存在於 Anthropic API。

**解法**：在 `.env` 指定正確的 model 名稱：

```bash
CLAUDE_MODEL=claude-sonnet-4-5
```

修改 `.env` 後只需要 restart，不需要 rebuild：

```bash
docker compose restart
```

---

### 問題 4：`docker exec sqlite3` 報 `executable file not found`

**原因**：`python:3.12-slim` 不包含 `sqlite3` CLI。

**解法**：DB 已 volume mount 到 VM 本地，直接在 VM 上查詢：

```bash
sudo apt install -y sqlite3
sqlite3 ~/projs/RunningCoach/data/coach.db "SELECT ..."
```

---

### 問題 5：LLM 認為現在是 2024 年（時間感知錯誤）

**原因**：Claude 本身不知道當前日期，會以 training cutoff 的時間印象作答，導致訓練計畫建議、距比賽天數等資訊錯誤。

**解法**：在 `context_manager.py` 的 `_build_system_prompt()` 最頂部動態注入當前日期與時區：

```
今天日期：2026-04-03（星期五）｜時區：Asia/Taipei（UTC+8）｜以星期日為一週的第一天
```

每次呼叫 API 前即時生成，不需要 rebuild，`docker compose restart` 即可生效。

---

### 設計補充：長期目標支援多個目標

`athlete_profile.goal_long_term` 為自由格式字串，可直接寫入多個目標：

```bash
/profile goal_long_term 半馬：2026年底破二；全馬：2027年底破430
```

不需要改 schema 或 code，LLM 能直接理解多目標格式。具體有日期的賽事目標應進 `races` table（透過自然語言告知 Claude 即可，Phase 2 實作 tool call 後生效）。
