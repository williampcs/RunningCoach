# 網頁實測（E2E）

用 Playwright 開網頁版、接模擬上游（`tools/mock-upstream.ts`），照使用者的操作點一遍並檢查結果。不需要任何金鑰。

## 準備

```bash
npm install
# 1. 模擬上游（LLM、Intervals.icu、同步服務、Open-Meteo），埠 8788
npm run dev:mock
# 2. 建置網頁版，Intervals.icu、同步服務與天氣都指向模擬上游
cd apps/web && VITE_INTERVALS_BASE_URL=http://127.0.0.1:8788/intervals \
  VITE_SYNC_URL=http://127.0.0.1:8788/sync \
  VITE_WEATHER_BASE_URL=http://127.0.0.1:8788/weather npx vite build && cd ../..
# 3. 開建置好的網頁版，埠 4173
npx vite preview --port 4173 --strictPort -c apps/web/vite.config.ts apps/web
```

模擬上游與 preview 要在背景一直開著。改了網頁的程式要重新建置（第 2 步）；改了 `tools/mock-upstream.ts` 要重開模擬上游。

## 執行

```bash
node tools/e2e/verify-races.cjs      # 一個
for f in tools/e2e/verify-*.cjs; do echo "$f: $(node $f 2>&1 | tail -1)"; done   # 全部
```

最後一行印出 `ALL OK` 或 `SOME CHECKS FAILED`，上面是每一項檢查的結果。截圖放在 `$E2E_OUT`（預設是系統暫存目錄下的 `running-coach-e2e`），不進版控；改了畫面時看截圖確認版面。

環境變數（都有預設值）：`E2E_URL`（preview 的網址）、`E2E_MOCK`（模擬上游）、`E2E_OUT`（截圖）。Playwright 先找專案的，找不到時用雲端開發環境預先裝好的。

## 腳本

| 腳本 | 驗證 |
|---|---|
| `verify-onboarding.cjs` | 新手引導、設定頁的下一步、跑後回報的摘要 |
| `verify-firstsync.cjs` | 第一次抓紀錄：同步最近 14 天或匯入全部的紀錄（11 #24） |
| `verify-history.cjs` | 紀錄頁、跑後回報的結果、補填體感（12.9） |
| `verify-plan.cjs` | 結構化課表的顯示與調整、先排好的下週課表（12.8、12.15） |
| `verify-races.cjs` | 賽事的生命週期：重複、編輯、不參加了、成績、收起的其他紀錄、教練看得到（12.15） |
| `verify-memory.cjs` | 記住的事、對話紀錄、摘要、回覆（12.11） |
| `verify-help.cjs` | 使用說明與教練的說明連結（12.12） |
| `verify-weather.cjs` | 天氣的城市、送出的座標、模型看不到地點、提醒（12.14） |
| `verify-devicesync.cjs` | 多裝置同步：配對、復原碼、還原後存設定（12.10、KI-042） |
| `verify-ui-round1.cjs` | 介面調整第一輪：教練動態的看板（展開即全部、看板內捲動）、輸入框一行高與自動長高、各欄位的 Enter、訊息的時間戳；手機與電腦、淺色與深色的截圖（12.16） |
| `verify-panels.cjs` | 說明與設定的面板：同一個按鈕開關、✕、Esc、上一頁、說明與設定互換、關閉後打到一半的字與捲動位置還在、「前往設定」與說明連結打開面板、電腦上點側邊的分頁；手機與電腦、淺色與深色的截圖（12.17） |
| `verify-update.cjs` | 有新版本的提示：版本相同不提示、回到前景時出現、不自動重新載入、關掉後同一版本不再出現、更新的版本再出現、點了才重新載入、讀不到時不提示；設定頁資料保護的三種狀態；標題列只顯示 Beta、設定頁最下面是完整的版號（12.19）；手機與電腦、淺色與深色的截圖（12.18） |

注意：

- 模擬上游的「今天」是台北時間；跨日前後（UTC 16:00 左右）需要日期對得上的腳本會先把時區設成 `Asia/Taipei`。
- 每個腳本用新的瀏覽器 context，等同第一次使用；不會互相影響，但同時跑多個會共用模擬上游的同步資料。
- 切換分頁、打開設定或說明用 `env.cjs` 的 `go(page, 名稱)`：設定與說明是蓋在分頁上的面板（12.17），手機上會蓋住底部的分頁。
- 新功能請加一個腳本或在既有的腳本加檢查，並更新上表。
