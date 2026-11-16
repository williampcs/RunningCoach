# 回報安全問題 / Security policy

## 怎麼回報

發現 Zone2Mate 的安全問題時，**請不要開公開的 Issue、PR 或討論**，改用 GitHub 的私下回報：

1. 到這個 repo 的 **Security** 分頁。
2. 按 **Report a vulnerability**，填寫內容。

只有維護者看得到。請盡量寫：影響哪個部分、怎麼重現、可能的影響。

## 範圍

- 網頁版（`app.zone2mate.com`）與 staging（`staging.zone2mate.com`）
- 多裝置同步服務、免費試用的代理（Cloudflare Workers）
- 自建的 Discord bot
- 這個 repo 的程式與 GitHub Actions 的 workflow

不在範圍內：第三方服務本身（Intervals.icu、AI 服務、Cloudflare、Discord）的問題，請直接回報給它們；阻斷服務與大量自動掃描的結果。

## 之後會怎樣

這是個人開發的專案，沒有固定的回覆時間，會盡快確認並回覆。修好之前不會公開細節；修好之後會在發版的說明中提到，回報者願意的話會註明感謝。請在修好之前不要公開。

---

## Reporting a vulnerability (English)

Please **do not open a public issue, pull request or discussion** for security problems. Use GitHub's private reporting instead: go to the **Security** tab of this repository and click **Report a vulnerability**. Only the maintainer can see the report.

In scope: the web app (`app.zone2mate.com`, `staging.zone2mate.com`), the sync service and the trial proxy (Cloudflare Workers), the self-hosted Discord bot, and the code and GitHub Actions workflows in this repository. Out of scope: issues in third-party services (Intervals.icu, AI providers, Cloudflare, Discord), denial of service, and raw automated scan output.

This is a personal project with no guaranteed response time; reports will be acknowledged as soon as possible. Please keep details private until a fix is released.
