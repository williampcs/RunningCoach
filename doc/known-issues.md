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

## [KI-003] 選手資料欄位不足，影響個人化訓練建議 ✅ 已解決

**發現時機**：Phase 3 驗收後檢視
**解決時機**：Phase 3 修補
**狀態**：已實作

**實作內容**：
沿用 key-value 結構，不需改 DB schema，新增以下欄位：

| key | 說明 |
|-----|------|
| `gender` | 性別 |
| `birth_year` | 出生年份（用於自動推算年齡） |
| `height_cm` | 身高（cm） |
| `weight_kg` | 體重（kg） |
| `body_fat_pct` | 體脂率（%） |
| `max_hr` | 最大心率實測值（bpm） |
| `resting_hr` | 靜息心率（bpm） |

`_build_system_prompt()` 新增渲染邏輯：
- 年齡由 `birth_year` 自動推算（Python 計算，非 LLM）
- 最大心率：有實測值用實測；否則用 `220 - 年齡` 推算並標注
- 心率區間 Zone 1–5 由 Python 直接計算注入（% of MaxHR），Claude 無需自行運算
- 格式範例：`Z1 <109  Z2 109–127  Z3 127–145  Z4 145–163  Z5 >163`

**填寫方式**：
- `/profile key value` 指令
- 直接告知 Claude（如「我的體重是 68kg」），Claude 會呼叫 `update_athlete_profile` tool 自動儲存

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

## [KI-008] 無訓練偏好欄位，模型無法據此規劃 ✅ 已解決

**發現時機**：Phase 3 驗收後檢視
**解決時機**：Phase 3 修補
**狀態**：已實作

**實作內容**：
沿用 key-value 結構，以 `pref_` 前綴區分偏好欄位與核心資料：

| key | 說明 | 範例值 |
|-----|------|--------|
| `pref_long_run_day` | 長跑日 | 週日 |
| `pref_rest_days` | 固定休息日（逗號分隔） | 週二,週五 |
| `pref_train_time` | 偏好訓練時段 | 早晨 / 傍晚 / 彈性 |

`_build_system_prompt()` 注入「訓練偏好」區塊，讓 Claude 在制定週計畫時自動考量。

**填寫方式**：同 KI-003，透過 `/profile` 指令或直接告知 Claude。

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

### 11-B 摘要品質差，缺乏精煉 ✅ 已解決

**實作內容**：
- 新增兩個 prompt template：`_INITIAL_PROMPT`（初次壓縮）與 `_UPDATE_PROMPT`（後續更新）
- 明確要求「用自己的話重新表達，不要保留對話原文」
- 固定三區塊結構：【訓練狀態】【重要決策】【待追蹤】，確保輸出格式一致
- 字數上限由 200 調整為 300，避免強制截斷重要資訊

### 11-C 壓縮時未帶入前次摘要，導致歷史重點流失 ✅ 已解決

**實作內容**：
- `compress_async()` 壓縮前先 fetch `db.get_latest_summary()`
- 若前次摘要存在，改用 `_UPDATE_PROMPT`：「將新對話融入現有摘要，更新成最新狀態」
- 若新舊資訊衝突，以新資訊為準；已過時的舊資訊可刪除
- 此設計讓摘要像一份「持續維護的選手狀態文件」，而非每次重頭生成

---

## [KI-014] 層5對話視窗中的長文本被重複帶入，造成 token 暴增 ✅ 已解決

**發現時機**：Phase 3 token 用量監控後
**解決時機**：Phase 3 修補
**狀態**：已實作（方案 A）
**優先度**：高

**問題描述**：
層5 rolling window 每次都帶入最近 N 筆完整對話內容。若其中某則訊息是長文本
（例如 Claude 輸出的完整訓練計畫、詳細跑後分析、長篇建議等），
該文本在後續每次請求中都會被重複帶入，直到被滾出視窗為止。

**影響**：
- 一則 2,000 字的訓練計畫保留在視窗 10 輪 → 額外消耗 20,000 字 × 10 次
- token footer 的「層5對話」數值異常高時即為此問題

**實作內容（方案 A）**：
- 新增 `config.CONVERSATION_MSG_MAX_CHARS`（預設 600，可透過 `.env` 調整）
- `context_manager._truncate_msg()` 在帶入 API 前截斷超長訊息，DB 保留完整內容
- 截斷時附加 `…（訊息過長，已截短至 N 字）` 標記，讓 Claude 知道有資訊被省略

**未來可改進**：
- 方案 B（字元預算取代筆數上限）：更精確但需改查詢邏輯
- 方案 C（懶載入 + tool 取回）：根本解法但架構成本較高

---

## [KI-015] 層2、層3每次請求都帶入，即使對話不需要 ✅ 已解決

**發現時機**：Phase 3 token 用量監控後
**解決時機**：Phase 3 修補
**狀態**：已實作（方案 B）
**優先度**：高

**問題描述**：
層2訓練摘要（最近 7 筆 workout summaries）在每次 API 請求都會帶入，
即使對話內容與訓練無關（如聊天、查詢賽事、更新個人資料等）。

**影響**：
- 訓練摘要字數通常較多（7 筆 × 每筆約 150 字 = ~1,000 字固定消耗）
- 非訓練類對話完全不需要這些資料，純屬浪費

**實作內容（方案 B）**：
- `context_manager.get_context_for_api()` 移除層2注入，不再每次帶入訓練摘要
- `get_recent_workouts` tool 回應強化：除原始訓練數據外，同步回傳 AI 分析摘要（合併自 `workout_summaries` table）
- `get_recent_workouts` tool description 明確列出應呼叫的場景（訓練分析、制定計畫等）
- system prompt 新增「訓練歷史載入時機」段落，引導 Claude 在適當時機主動呼叫
- token footer 的層標籤同步移除「層2訓練」

**效果**：
- 賽事管理、閒聊、個人資料更新等對話：層2、層3成本歸零
- 需要訓練背景的對話：Claude 同一輪可同時呼叫 `get_recent_workouts` + `get_training_plan`，不額外增加輪次
- `/status` 的訓練計畫狀態顯示維持不變（`get_active_training_plan()` 仍直接查詢 DB）

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

## [KI-013] 無 Token 用量監控，難以掌握 API 費用 ✅ 已解決

**發現時機**：Phase 3 驗收後
**解決時機**：Phase 3 修補
**狀態**：已實作

**實作內容**：

| 來源 | 做法 | 可見位置 |
|------|------|---------|
| 主對話（含 tool calls） | Discord 每則回覆附加 token footer | Discord 頻道 |
| 對話壓縮（非同步） | `logger.info` 記錄 input/output | `docker compose logs` |
| workout_summary 生成 | `logger.info` 記錄 input/output | `docker compose logs` |

**Discord footer 格式**（顯示於每則回覆末端）：
```
📊 輸入 1,847（層1系統~312  層2訓練~578  層3計畫~218  層4摘要~91  層5對話~415  訊息~233） | 輸出 412 | 工具 2 輪 +553
```

**設計說明**：
- 輸入各層 token 數為**比例估算**（依字元數佔比換算），非 API 精確值
- `initial_input_tokens`（第一輪）代表 context 大小；後續 tool call 輪次的額外 input 顯示為 overhead
- 非同步壓縮不顯示在 footer（timing 對不上），改以 log 記錄
- 若需長期追蹤費用趨勢，可未來新增 `token_usage` DB table（方案 C，目前未實作）