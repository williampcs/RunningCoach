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
