---
# 排程：每週六 05:23（台北），每次最多 5 美元（規格 12.45、9.4）。
# vault_ids 只能寫 id（不能寫路徑）：第一次 ant apply 建好 vault 之後，照 README 把 vlt_ 開頭的 id 填進來。
# repo 是公開的，所以 clone 不用 token（也因此代理推不了任何東西）；GitHub 的 API 用 vault 裡的 GITHUB_TOKEN。
name: security-deep
agent: ../agents/security-deep.md
environment_id: ../environments/security-scan.yaml
vault_ids:
  - YOUR_VAULT_ID
resources:
  - type: github_repository
    url: https://github.com/williampcs/RunningCoach
    mount_path: /workspace/RunningCoach
    checkout:
      type: branch
      name: v2
  - path: ../memory_stores/security-scan-state.yaml
    access: read_write
    instructions: 安全掃描的狀態與發現。只用 tools/security-scan/scripts/scan.mjs 讀寫，不要手改，不要寫入任何秘密。
schedule:
  type: cron
  expression: "23 5 * * 6"
  timezone: Asia/Taipei
budget:
  type: limit
  max_list_cost:
    amount: "500"
    currency: USD
---

照系統提示的步驟，做這週的深掃（照順序挑下一片）。
