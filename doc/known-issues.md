# Running Coach — 已知問題與待處理事項

---

## [KI-001] 對話壓縮的 Race Condition（低優先）

**發現時機**：Phase 2 開發討論
**狀態**：待處理

**問題描述**：
若使用者連續快速送出兩則訊息，兩個 `run()` 可能同時通過 `should_compress()` 檢查，
對同一批對話觸發兩次壓縮，造成重複摘要或資料刪除異常。

**影響範圍**：
個人使用的 bot，使用者一次一則訊息，幾乎不會發生。

**可能解法**：
- 加一個 in-memory flag（`_compressing: bool`）防止重複觸發
- 或在 DB 層加 advisory lock

---

## [KI-002] 賽事管理功能不完整 ✅ 已解決

**發現時機**：Phase 2 驗收測試
**解決時機**：Phase 2 修補
**狀態**：已實作

**問題描述**：
1. 無法修改賽事內容（只有 `add_race`，沒有 `update_race`）
2. 無法取消報名（`races` table 無取消狀態）

**設計決策**：採用選項 B — 新增 `cancelled` 欄位

**實作內容**：

| 項目 | 說明 |
|------|------|
| `races.cancelled` 欄位 | `INTEGER DEFAULT 0`，1=已取消；透過 migration 安全加入現有 DB |
| `get_upcoming_races()` | 新增 `AND cancelled=0` 過濾，取消的賽事不出現在 context 與查詢結果 |
| `db.update_race()` | 更新指定欄位（只更新有傳入的欄位） |
| `db.cancel_race()` | 設定 `cancelled=1`，保留歷史紀錄 |
| `update_race` tool | Claude 可修改賽事名稱、日期、目標時間等 |
| `cancel_race` tool | Claude 可標記退賽，可附上取消原因 |

**Migration 說明**：
`init_db()` 會在啟動時自動檢查 `races` table 是否有 `cancelled` 欄位，若無則執行
`ALTER TABLE races ADD COLUMN cancelled INTEGER DEFAULT 0`，不需要手動操作。

---

## [KI-003] 選手資料欄位不足，影響個人化訓練建議

**發現時機**：Phase 3 驗收後檢視
**狀態**：待實作
**優先度**：高

**問題描述**：
`athlete_profile` 目前只記錄以下欄位：
`goal_long_term`, `pb_5k`, `pb_10k`, `pb_half`, `pb_full`, `injuries`, `weekly_km_target`

缺少許多影響訓練負荷、心率區間計算與補給建議的生理資料：

| 缺少欄位 | 用途 |
|---------|------|
| 性別 | 補給、生理週期考量 |
| 生日（年月） | 年齡、最大心率推算 |
| 身高 / 體重 | BMI、補給熱量估算 |
| 體脂率 | 更精確的功率體重比 |
| 最大心率（實測） | 心率區間 Zone 1–5 計算 |
| 靜息心率 | 心率儲備（HRR）計算 |

**可能解法**：
- `athlete_profile` 是 key-value 結構，技術上可直接新增欄位
- 需更新 `init_profile.py` 加入互動式輸入
- 需更新 `context_manager.py` 的 system prompt 注入邏輯，讓 Claude 能取得並運用這些資料
- 或提供 `update_athlete_profile` tool 讓 Claude 在對話中引導選手填寫

---

## [KI-004] 長回應被截斷（max_tokens=1024 過低）✅ 已解決

**發現時機**：Phase 3 驗收測試中
**解決時機**：Phase 3 修補
**狀態**：已實作

**問題描述**：
`agent/loop.py` 的 `_call_claude_with_tools()` 與 fallback final call 均設定 `max_tokens=1024`，
此值對於完整的訓練計劃、詳細跑後分析等長輸出場景明顯不足，導致回應被截斷。

**根本原因**：
```python
# loop.py（修改前）
max_tokens=1024  # ← 太低
```

**實作內容**：
- 新增 `config.MAX_RESPONSE_TOKENS`，預設值 `4096`（原本的 4 倍），可透過 `.env` 調整
- 主對話 loop 與 fallback final call 均改用 `config.MAX_RESPONSE_TOKENS`
- `generate_workout_summary()` 的 `max_tokens=300` **保留不動**（刻意精簡的一行摘要）
- `summarizer.py` 的 `max_tokens=512` **保留不動**（壓縮結果本來就要精簡）

**注意**：換模型（如 claude-sonnet-4-6）不會解決此問題，根本原因是 max_tokens 設定值。

---

## [KI-005] DB 時間戳記為 UTC，顯示差 8 小時

**發現時機**：Phase 3 驗收後檢視
**狀態**：已知行為，待確認是否需要修正
**優先度**：低

**問題描述**：
`db.py` 的 `now_iso()` 使用 `datetime.now(timezone.utc)`，所有 metadata 欄位
（`created_at`, `synced_at`, `updated_at`）均儲存 UTC 時間。

```python
# db.py 第 123 行
def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
```

**影響範圍**：
- **不影響**：`workouts.date`、`races.date` 等使用者可見的日期欄位（儲存為本地日期字串如 `2024-01-15`）
- **有影響**：直接查詢 DB 時顯示的 created_at 等會比台灣時間早 8 小時

**可能解法**：
- 改為 `datetime.now(ZoneInfo("Asia/Taipei"))` 統一儲存本地時間
- 或接受 UTC 儲存，僅在顯示層轉換（更符合工程慣例）

---

## [KI-006] 訓練規劃仍可能以週一為一週起點

**發現時機**：Phase 2 開發後使用者回報
**狀態**：部分處理，待進一步驗證
**優先度**：中

**問題描述**：
System prompt 已加入「以星期日為一週的第一天」的指示，但 Claude 在制定週期訓練計畫時，
受訓練資料影響，仍可能沿用 ISO 8601 慣例（週一 = 第一天）進行規劃。

**目前狀態**：
- System prompt 中有明確指示 ✅
- 無法保證每次 Claude 推理時都遵守 ⚠️

**建議**：
- 在訓練計畫相關的 tool description 與 prompt 中重複強調
- 驗收時明確測試：要求 Claude 規劃下週計畫，確認是否從週日開始

---

## [KI-007] 日期計算容易出錯（兩日期相差天數、判斷星期幾）

**發現時機**：Phase 2 使用過程中
**狀態**：待評估是否實作 tool
**優先度**：中

**問題描述**：
Claude 進行日期算術（計算距離比賽剩餘天數、判斷某日是星期幾、計算訓練週次）時，
純靠語言模型推理可能出錯，尤其跨月、跨年或問句較隱晦時。

**目前緩解措施**：
- System prompt 注入今天日期 + 星期 ✅
- 近期賽事注入「距今 N 天」 ✅（由 Python 計算，正確）

**可能解法**：
- 新增 `calculate_days_between(date1, date2)` tool，讓 Claude 遇到日期計算時可呼叫
- 新增 `get_week_schedule(start_date)` tool 直接輸出該週每天日期與星期

---

## [KI-008] 無訓練偏好欄位，模型無法據此規劃

**發現時機**：Phase 3 驗收後檢視
**狀態**：待實作
**優先度**：中

**問題描述**：
目前 `athlete_profile` 沒有結構化的訓練偏好欄位，Claude 無法得知：
- 習慣哪天進行長跑（如週日）
- 固定哪幾天無法訓練（工作/家庭因素）
- 偏好的訓練時段（早晨/傍晚）
- 對跑步路線的偏好（操場/路跑/越野）

**可能解法**：
- 在 `athlete_profile` key-value 中新增 `training_preferences` key（JSON 格式）
- 或新增獨立的 `training_preferences` table
- 更新 system prompt 注入邏輯，讓 Claude 在規劃訓練時自動參考

---

## [KI-009] 跑步子類型無自動推斷（LSD / 恢復跑 / 配速跑等）

**發現時機**：Phase 3 驗收後檢視
**狀態**：待設計
**優先度**：中

**問題描述**：
`workouts.type` 目前預設為 `'run'`，Strava 原始資料只區分大類型（Run / Ride 等），
不提供 LSD、恢復跑、配速跑、節奏跑等訓練子類型。

目前子類型資訊來源：
- 使用者在對話中手動說明 → 存入 `subjective_notes` 自由文字
- 無結構化欄位，Claude 後續無法依類型篩選查詢

**可能解法**：
- 新增 `workout_subtype` 欄位（LSD / easy / tempo / interval / race 等）
- 由 Claude 根據配速、心率、距離、使用者描述**自動推斷**並寫入（需更新 `save_workout` tool）
- 或由使用者在跑後回報時明確告知

---

## [KI-010] 無同類型訓練歷史比較功能

**發現時機**：Phase 3 驗收後檢視
**狀態**：待實作
**優先度**：中（Phase 4 相關）

**問題描述**：
目前 `get_recent_workouts` tool 回傳最近 N 筆訓練，但不支援依類型篩選。
Claude 無法直接取得「過去所有 LSD 跑的配速趨勢」或「上次節奏跑的心率」進行比較。

`get_pace_trend` 僅提供整體配速趨勢，無法依訓練類型分類。

**可能解法**：
- 在 `get_recent_workouts` 新增可選 `workout_type` 篩選參數
- 新增 `get_workouts_by_type(type, limit)` tool
- 依賴 [KI-009] 的子類型欄位實作

---

## [KI-011] 對話壓縮三個子問題

**發現時機**：Phase 3 驗收後使用者回報
**狀態**：待修正
**優先度**：中

### 11-A 壓縮閾值過低

**現況**：`CONVERSATION_MAX=20`，超過後壓縮最舊 10 筆（`CONVERSATION_KEEP=10`）
**問題**：個人教練對話通常較長，20 筆太快觸發壓縮

**建議修改**：
```python
# config.py
CONVERSATION_MAX: int = int(os.getenv("CONVERSATION_MAX", "30"))   # 20 → 30
CONVERSATION_KEEP: int = int(os.getenv("CONVERSATION_KEEP", "20")) # 10 → 20
```
（建議同步調整 KEEP，否則每次壓縮 20 筆太多）

### 11-B 摘要品質差，缺乏精煉

**現況**：
```python
# summarizer.py
"請壓縮成重點摘要...請用繁體中文，條列式輸出，精簡為 200 字以內。"
```

**問題**：200 字限制造成 prompt 與輸出之間的張力；實際輸出像拼接對話而非精煉摘要。

**建議修改**：
- 明確要求「不要逐句還原對話，只保留關鍵決策與資訊」
- 增加結構要求：訓練狀態 / 決策記錄 / 待追蹤事項 三個固定區塊
- 限制改為 300 字（允許略長以確保關鍵資訊不被砍掉）

### 11-C 壓縮時未帶入前次摘要，導致歷史重點流失

**現況**：`compress_async()` 只將「本次待壓縮的對話」送入 Claude，不包含前次 summary。

**問題**：若前次摘要記錄了「選手左膝不適」，但本次對話未提及，壓縮後此資訊消失。

**建議修改**：
```python
# summarizer.py — 在 prompt 前注入前次摘要
prev_summary = db.get_latest_summary()
if prev_summary:
    prompt = f"【前次對話摘要】\n{prev_summary['content']}\n\n【本次新增對話】\n" + prompt
```

---

## [KI-012] 訓練歷史送入量與參照範圍說明

**發現時機**：Phase 3 驗收後
**狀態**：設計說明（非 bug）
**優先度**：低

**現況**：

| Context 層 | 資料 | 數量 |
|-----------|------|------|
| 層2 — 訓練摘要 | `workout_summaries`（每筆訓練的 AI 分析文字） | 最近 7 筆（`WORKOUT_SUMMARY_COUNT=7`） |
| 層3 — 訓練計畫 | 當前 `training_plans` 最新一筆 | 1 筆 |

**問題**：
- 跑後評估時，Claude 只能參考最近 7 筆訓練摘要
- 制定訓練計畫時，同樣只有 7 筆歷史可參考
- `get_recent_workouts` tool 可讓 Claude 主動要求更多資料，但需 Claude 自行判斷呼叫

**可能優化**：
- `WORKOUT_SUMMARY_COUNT` 可透過 `.env` 調整（預設 7）
- 若訓練量大，建議提升至 14（兩週）
- 長期可考慮依訓練類型分類注入（依賴 [KI-009] 解決）

---

## [KI-013] 無 Token 用量監控，難以掌握 API 費用

**發現時機**：Phase 3 驗收後
**狀態**：待實作
**優先度**：高

**問題描述**：
目前 `agent/loop.py` 未記錄任何 token 用量資訊。每次呼叫 Claude API 實際消耗多少 input/output tokens 完全不可見，無法：
- 得知單次對話的 token 用量
- 追蹤累積費用趨勢
- 發現異常的高用量請求（例如 context 過大）

**現況**：
Anthropic API 的每個 response 物件已內含用量資訊，只是沒有被記錄：
```python
response.usage.input_tokens   # 本次送入的 token 數（含 system prompt、歷史對話）
response.usage.output_tokens  # 本次 Claude 回應的 token 數
```

**可能解法（由簡到完整）**：

**方案 A — 僅加 log（最簡單，5 分鐘）**：
在 `_call_claude_with_tools()` 每次 API 呼叫後加一行：
```python
logger.info("Tokens — input: %d, output: %d", response.usage.input_tokens, response.usage.output_tokens)
```
透過 `docker compose logs` 即可查看。

**方案 B — 累積計數 + /status 顯示（中等）**：
- 在 loop.py 維護 per-conversation token 累計
- `/status` 指令顯示本次對話用量與歷史總計

**方案 C — 寫入 DB 長期追蹤（完整）**：
- 新增 `token_usage` table，記錄每次 API call 的時間、input/output tokens、呼叫來源（主對話 / 壓縮 / workout summary）
- 可計算每日/每週費用估算（claude-sonnet-4-5 約 $3/MTok input, $15/MTok output）
- `/status` 顯示近 7 天用量摘要

**建議先實作方案 A**，確認用量規模後再決定是否需要方案 C。