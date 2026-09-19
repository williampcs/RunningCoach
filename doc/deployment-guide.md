# Running Coach — 部署與測試指南

**最後更新**：2026-09-19  
**適用版本**：Intervals.icu 整合版（支援 GitHub Actions CI/CD）

---

## 一、部署架構說明

```
本機（開發）
  │  git push origin main
  ▼
GitHub Repo
  │  Webhook / Event Trigger
  ▼
GCP VM (GitHub Actions Self-hosted Runner)
  │  git pull & docker compose up --build -d
  ▼
Docker Container: coach-bot
  │  volume mount
  ▼
VM 本地 ./data/coach.db  ←→  容器內 /app/data/coach.db
```

**重要原則**：
- Code 透過 GitHub Actions 觸發 VM 本地的 Self-hosted Runner 自動部署
- Image 在 VM 上 build，享受快取且速度快
- DB 永遠存在 VM 的 `./data/` 目錄，透過 volume mount 讓容器存取，不進 git
- `.env` 只放在 VM 本地，不進 git
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
INTERVALS_API_KEY=你的IntervalsAPIKey
INTERVALS_ATHLETE_ID=你的AthleteID（或填 0）
```

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

## 六、GitHub Actions CI/CD 自動化部署設定（Self-hosted Runner）

本專案支援 **100% 免費、零網路曝險** 的自動化部署機制。透過在 GCP VM 上常駐 GitHub Self-hosted Runner，只要本機執行 `git push origin main`，VM 便會自動拉取最新程式碼並重啟 Docker 容器。

### 1. 運作原理與優勢
- **免對外開放 Port 22**：Runner 主動透過 HTTPS 與 GitHub 長連線傾聽事件，GCP 防火牆無需對外開放 SSH 通訊埠。
- **免存主機 SSH 私鑰**：不需在 GitHub Secrets 存放任何主機登入金鑰，安全性更高。
- **不計額度限制**：Self-hosted Runner 不消耗 GitHub Actions 每月 2,000 分鐘的免費額度，完全免費且次數無上限。

### 2. 首次在 VM 上安裝 Runner（一次性設定）
1. 前往 GitHub Repo 網頁 → **Settings** → 左側 **Actions** → **Runners**。
2. 點擊右上角綠色按鈕 **New self-hosted runner**。
3. 選擇 **Linux**、**x64**，複製頁面上的指令並在 VM 上執行：
   ```bash
   # 建立目錄並下載 runner（使用 GitHub 頁面給你的專屬指令）
   mkdir actions-runner && cd actions-runner
   curl -o actions-runner-linux-x64-....tar.gz -L https://...
   tar xzf ./actions-runner-linux-x64-....tar.gz

   # 依照 GitHub 頁面執行配置（一路按 Enter 採用預設值即可）
   ./config.sh --url https://github.com/williampcs/RunningCoach --token <TOKEN>
   ```

### 3. 將 Runner 註冊為背景系統服務（開機自啟）
**重要**：請勿只在前台執行 `./run.sh`（終端機關閉後會中斷）。請執行內建的服務管理腳本，註冊為 Linux systemd 服務：
```bash
sudo ./svc.sh install
sudo ./svc.sh start
```
確認運行狀態：
```bash
sudo ./svc.sh status
```
看到 `Active: active (running)` 即代表 Runner 已常駐在背景，可以安全關閉 SSH 視窗。

### 4. Docker 執行權限確認
因為 GitHub Actions 部署時會執行 `docker compose`，確保執行 Runner 的使用者帳號具有 Docker 操作權限：
```bash
sudo usermod -aG docker $USER
# 重啟 Runner 服務以套用權限變更
sudo systemctl restart actions.runner.*
```

### 5. 自動部署工作流程檔說明
工作流程定義檔位於 `.github/workflows/deploy.yml`：
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
當任何提交 push 到 GitHub 的 `main` 分支時，GitHub Actions 會自動調度 VM 上的 Runner 自動拉取最新程式碼並重啟容器。可至 GitHub 的 **Actions** 頁籤即時查看部署日誌與歷程。

---

## 七、驗收測試項目

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
| `/status` | `/status` | 顯示五層記憶完整狀態（含 emoji 指示器） |
| `/sync` | `/sync` | 回應 Intervals.icu 同步結果（新增筆數、合併體感） |

### T4（Phase 2）：賽事管理 — 自然語言新增

在 Discord 傳送：
> 「我報名了五月十號萬金石半馬，目標 1:58」

✅ Claude 呼叫 `add_race` tool
✅ 回應確認賽事已新增
✅ 此後對話的 system prompt 自動出現該賽事（層1 注入）

### T5（Phase 2）：賽事管理 — 更新成績

傳送：
> 「剛跑完萬金石，成績 1:55:30，後半段發揮不錯」

✅ Claude 先呼叫 `get_upcoming_races` 確認 race_id
✅ 再呼叫 `update_race_result` 更新成績
✅ 回應包含分析與鼓勵

### T6（Phase 2）：對話壓縮

製造超過 20 輪對話後，確認：

```bash
sqlite3 ~/projs/RunningCoach/data/coach.db \
  "SELECT id, substr(content,1,50) FROM summaries ORDER BY id DESC LIMIT 1;"
```

✅ summaries table 有一筆壓縮摘要
✅ conversations table 筆數回到 10 筆以下
✅ 後續對話品質不下降（層4 有注入摘要）

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

## 八、已遇問題與解法

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
