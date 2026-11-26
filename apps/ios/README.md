# iOS App（試做，規格 12.49）

用 Capacitor 把網頁版（`apps/web`）包成 iOS App。畫面與核心和網頁版是同一份；這個資料夾只有原生的殼、試做用的 Apple 健康外掛（只回傳統計）與 App 內的測試頁。

- `ios/`：Xcode 專案（Capacitor 產生，套件用 Swift Package Manager，不用 CocoaPods）。
- `ios/App/App/HealthProbePlugin.swift`：試做用，讀 Apple 健康只回傳統計（有沒有、筆數、每分鐘幾筆、欄位名稱、來源的種類），不回傳實際數值。
- `ios/App/App/AppViewController.swift`：註冊上面的外掛；**搖一搖**打開測試頁。
- `probe/`：App 內的測試頁（`ios-probe.html`），不在網頁版裡。
- `scripts/`：建置網頁、寫簽章設定、裝到 iPhone。

## 第一次（在你的 Mac）

需要：Xcode（App Store）、Node 22 以上、免費的 Apple ID。不用 CocoaPods。

1. Xcode → 設定（⌘,）→ **Accounts** → 左下「+」→ 用 Apple ID 登入。
2. iPhone 用線接上 Mac，解鎖，選「信任這部電腦」；iPhone 的 設定 → 隱私權與安全性 → **開發者模式** 打開（會重新開機）。
3. 在 repo 根目錄：
   ```bash
   npm install
   npm run setup-signing -w @running-coach/ios   # 寫 ios/signing.local.xcconfig（不進版控）
   ```
4. （要連 staging 的同步與試用時）在 `apps/ios/` 建 `app.env.local`（不進版控），格式同 `.env`：
   ```
   VITE_SYNC_URL=https://…（staging 的同步服務）
   VITE_PROXY_URL=https://…（staging 的試用代理）
   ```
   沒有這個檔也能建置：資料只在手機上，不連同步。預設是 staging 的建置（`VITE_STAGING=1`：功能全開、有 passkey 測試頁）。
5. 建置並裝到 iPhone：
   ```bash
   npm run sync -w @running-coach/ios            # 建置網頁版、複製進 App
   npm run install-device -w @running-coach/ios  # 建置 App、裝到接著的 iPhone
   ```
6. 第一次裝好後，iPhone 的 設定 → 一般 → **VPN 與裝置管理** → 你的 Apple ID → 信任。

## 7 天到期時重裝

免費的 Apple ID 簽的 App 7 天後打不開。iPhone 接上 Mac，在 repo 根目錄：

```bash
git pull
npm install
npm run sync -w @running-coach/ios
npm run install-device -w @running-coach/ios
```

重裝不會清掉 App 裡的資料（同一個 bundle id 覆蓋安裝）。**刪掉 App 會清掉資料**。

## 注意

- 簽章（Team、bundle id）只放在 `ios/signing.local.xcconfig`。不要在 Xcode 的 Signing & Capabilities 分頁改 Team：那會寫進 `project.pbxproj`（進版控）。
- 免費的 Apple ID：只能裝在自己的裝置、7 天到期、不能用 Associated Domains（passkey 要綁網域時需要）。
- 要用 Xcode 看 log 或除錯：`npm run open -w @running-coach/ios`，選自己的 iPhone、按執行。
