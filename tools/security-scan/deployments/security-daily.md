---
# 排程：每天 04:23（台北），每次最多 1 美元（規格 12.45、9.4）。
# vault_ids 只能寫 id（不能寫路徑）：第一次 ant apply 建好 vault 之後，照 README 把 vlt_ 開頭的 id 填進來。
# 不掛 github_repository 資源（它一定要附 token）：repo 是公開的，代理每次自己 clone `v2`，不用 token，也推不了任何東西。
# GitHub 的 API（警示、上傳結果）用 vault 裡的 GITHUB_TOKEN。
name: security-daily
agent: ../agents/security-daily.md
environment_id: ../environments/security-scan.yaml
vault_ids:
  - YOUR_VAULT_ID
resources:
  - path: ../memory_stores/security-scan-state.yaml
    access: read_write
    instructions: 安全掃描的狀態與發現。只用 tools/security-scan/scripts/scan.mjs 讀寫，不要手改，不要寫入任何秘密。
schedule:
  type: cron
  expression: "23 4 * * *"
  timezone: Asia/Taipei
budget:
  type: limit
  max_list_cost:
    amount: "100"
    currency: USD
---

照系統提示的步驟，做今天的每日掃描。
