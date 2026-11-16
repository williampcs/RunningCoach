# 每天用代理掃 bug 與漏洞（試行四週）

背景與決定見規格 `doc/running-coach-spec2_0.md` 的 12.45，工作單在 9.4「每天用代理掃 bug 與漏洞：試行四週」。

## 這是什麼

兩個放在 Claude Platform（Managed Agents）上、照排程自己跑的代理：

| 代理 | 什麼時候 | 模型 | 每次最多花 | 做什麼 |
|---|---|---|---|---|
| `security-daily` | 每天 04:23（台北） | Sonnet 5.5（effort medium） | 1 美元 | 審 `v2` 從上次審到的 commit 之後的程式改動；判斷 GitHub 的新警示（Dependabot、CodeQL、secret scanning）。沒有新東西就安靜結束。 |
| `security-deep` | 每週六 05:23（台北） | Opus 5.5（effort high） | 5 美元 | 照 `slices.yaml` 的順序挑一片（proxy、sync 先），讀完那片的每個檔案。那片沒變就換下一片。每次都發一行通知（當作「還活著」）。 |

發現的問題只放兩個地方：GitHub 的 **Security 分頁**（code scanning，工具名稱 `security-scan-agent`）與你**私人的 Discord 頻道**。不進 repo、不開 Issue。代理不改程式、不推送（repo 是公開的，clone 不用 token，所以它也推不了）、不開 PR。

### 檔案

```
tools/security-scan/
  agents/security-daily.md        每日的代理：上面是設定，下面是系統提示
  agents/security-deep.md         每週深掃的代理
  environments/security-scan.yaml 沙盒：網路只開 github.com、api.github.com、discord.com，允許套件庫
  memory_stores/security-scan-state.yaml  狀態與發現（放在 Anthropic，不放 repo）
  vaults/security-scan.yaml       放兩個 token 的保險箱（檔案只建立空的保險箱，token 你自己加）
  deployments/security-daily.md   每日的排程（最下面那行是每次開始時給代理的訊息）
  deployments/security-deep.md    每週的排程
  slices.yaml                     7 片的範圍與每片在意什麼
  scripts/scan.mjs、lib.mjs       代理用的小工具：去重、fingerprint、SARIF、上傳、通知、狀態（有測試，在 npm test 裡）
  claude-lock.json                第一次 ant apply 之後才會出現：資源的 id，要 commit
```

memory store 裡有三個檔案：`state.json`（上次審到哪、每片上次深掃的日期）、`findings.json`（每個發現與狀態）、`config.json`（你放的：repo 與 Discord 頻道的 id）。

---

## 步驟 0：先在網頁上設定（約 20 分鐘）

### 0-1. GitHub 的安全功能（免費）

到 repo 的 **Settings → Advanced Security**（舊版的畫面叫 Code security）：

- **Dependabot alerts**：開。
- **Dependabot security updates**：**不要開**。它會自動開修補的 PR 到 `main`，繞過 `v2` → staging 的流程；要修的照常由協調 session 寫工作單。
- **Secret scanning**：開；裡面的 **Push protection** 也開。
- **Code scanning → CodeQL analysis**：選 **Default**，語言用它偵測的（JavaScript/TypeScript、Actions），按 Enable。
- **Private vulnerability reporting**：開（別人發現漏洞時可以私下告訴你）。

再到 **Settings → Actions → General → Fork pull request workflows from outside collaborators**：選 **Require approval for all external contributors**（VM 上有 self-hosted runner，外人的 PR 不能直接跑 workflow）。

### 0-2. Anthropic Console：專用的工作區與 key

1. 到 [Console](https://platform.claude.com/) → **Settings → Workspaces**，新增一個工作區，例如 `security-scan`。
2. 在這個工作區的 **Limits** 設**每月花費上限 50 美元**（到了就停，不會多扣）。
3. 在這個工作區建一把新的 API key（名稱例 `security-scan`），只用在這裡。不要用網頁版、教練或其他工具的 key。

key 只放在你的電腦上（下面的步驟會在終端機裡用到），不要貼到任何地方。

### 0-3. GitHub：fine-grained 的 personal access token

到 GitHub 右上角頭像 → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**：

- **Token name**：`security-scan`
- **Expiration**：90 天（到期前會收到 email；到期後照下面的「換 token」換一把）
- **Repository access**：**Only select repositories** → 只選 `RunningCoach`
- **Repository permissions**（其他全部保持 No access）：
  - **Metadata**：Read-only（會自動選）
  - **Contents**：Read-only
  - **Code scanning alerts**：Read and write（上傳結果用）
  - **Dependabot alerts**：Read-only
  - **Secret scanning alerts**：Read-only
- 不要給 Issues、Pull requests、Actions、Administration、Workflows 或任何寫入程式的權限。

產生之後先複製下來，等一下在終端機裡貼（只會顯示這一次）。

### 0-4. Discord：通知用的 bot 與私人頻道

教練的 bot 的 token 不要拿來用；另建一個只負責發通知的 bot：

1. 到 [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**，名稱例 `security-scan`。
2. 左邊 **Bot** → **Reset Token** → 複製 token（等一下在終端機裡貼）。下面的 Privileged Gateway Intents 全部**不要**開。
3. 左邊 **OAuth2 → URL Generator**：Scopes 勾 **bot**；Bot Permissions 只勾 **View Channels** 與 **Send Messages**。打開最下面產生的網址，把 bot 邀進你自己的伺服器。
4. 在你的伺服器開一個新頻道（例 `#security`），**Edit Channel → Permissions**：把 `@everyone` 的 View Channel 關掉，加上你自己與這個 bot（View Channel、Send Messages 打開）。
5. Discord 的 **使用者設定 → 進階 → 開發者模式** 打開，在那個頻道上按右鍵 → **複製頻道 ID**，記下來。

---

## 步驟 2：在你的電腦上建立代理（約 30 分鐘）

需要：`ant`（Anthropic 的命令列工具）1.40 以上、`jq`、`git`。

```sh
# macOS
brew install anthropics/tap/ant jq
ant --version    # 要 1.40 以上
```

以下的指令都在 repo 的 `tools/security-scan/` 目錄裡跑（`claude-lock.json` 會寫在這裡）：

```sh
cd RunningCoach && git checkout v2 && git pull
cd tools/security-scan
```

### 2-1. 用專用的 key 登入

```sh
read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY   # 貼上 0-2 的 key（畫面上不會顯示），按 Enter
ant auth status                                           # 確認用的是這把 key、工作區是 security-scan
```

這個終端機視窗做完下面的步驟前不要關；做完執行 `unset ANTHROPIC_API_KEY`。

### 2-2. 先建立代理、沙盒、memory store、保險箱（排程等一下）

先看計畫（不會改任何東西）：

```sh
ant apply --dry-run -v \
  agents/security-daily.md agents/security-deep.md \
  environments/security-scan.yaml memory_stores/security-scan-state.yaml vaults/security-scan.yaml
```

確認：最上面的 **organization 與 workspace** 是 0-2 的那個工作區；要建立的剛好是 2 個 agent、1 個 environment、1 個 memory store、1 個 vault，沒有別的。看起來對就真的建立（會問 y/n）：

```sh
ant apply \
  agents/security-daily.md agents/security-deep.md \
  environments/security-scan.yaml memory_stores/security-scan-state.yaml vaults/security-scan.yaml
```

如果 dry-run 報錯（例如某個欄位不認得），把錯誤訊息貼給協調 session，不要自己改大方向。

### 2-3. 把兩個 token 放進保險箱

**一次貼一段**：貼上、按 Enter、在看不到字的提示貼 token、按 Enter，等它印出建立好的憑證，再貼下一段。

GitHub 的 token（只會送到 `api.github.com`；代理的沙盒裡只看得到佔位字串）：

```sh
VAULT_ID=$(jq -r '.resources["./vaults/security-scan.yaml"].id' claude-lock.json)
read -rs CMA_GITHUB_PAT && export CMA_GITHUB_PAT
jq -n -f /dev/stdin <<'JQ' | ant beta:vaults:credentials create --vault-id "$VAULT_ID"
{
  display_name: "GitHub (security scan)",
  auth: {
    type: "environment_variable",
    secret_name: "GITHUB_TOKEN",
    secret_value: (env.CMA_GITHUB_PAT // error("CMA_GITHUB_PAT is not set")),
    networking: {type: "limited", allowed_hosts: ["api.github.com"]},
    injection_location: {header: true, body: false}
  }
}
JQ
```

Discord bot 的 token（只會送到 `discord.com`）：

```sh
read -rs CMA_DISCORD_TOKEN && export CMA_DISCORD_TOKEN
jq -n -f /dev/stdin <<'JQ' | ant beta:vaults:credentials create --vault-id "$VAULT_ID"
{
  display_name: "Discord notify bot (security scan)",
  auth: {
    type: "environment_variable",
    secret_name: "DISCORD_BOT_TOKEN",
    secret_value: (env.CMA_DISCORD_TOKEN // error("CMA_DISCORD_TOKEN is not set")),
    networking: {type: "limited", allowed_hosts: ["discord.com"]},
    injection_location: {header: true, body: false}
  }
}
JQ
```

在同一個視窗確認兩個 token 是對的（第一個只連 `api.github.com`，第二個只連 `discord.com`）：

```sh
# 要印出 200：這個 token 讀得到 Dependabot 的警示
curl -sS -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $CMA_GITHUB_PAT" \
  "https://api.github.com/repos/williampcs/RunningCoach/dependabot/alerts?per_page=1"

read -r DISCORD_CHANNEL_ID   # 貼上 0-4 記下的頻道 ID
# 要印出你的頻道名稱：bot 看得到那個頻道
curl -sS -H "Authorization: Bot $CMA_DISCORD_TOKEN" \
  "https://discord.com/api/v10/channels/$DISCORD_CHANNEL_ID" | jq -r .name
```

不是 200 或沒印出頻道名稱：回頭檢查 0-3 的權限或 0-4 的頻道權限（剛改完的設定有時要等一分鐘）。檢查完（不管對不對）都把 token 從這個視窗清掉：

```sh
unset CMA_GITHUB_PAT CMA_DISCORD_TOKEN
ant beta:vaults:credentials list --vault-id "$VAULT_ID"   # 要看到 2 個（只有名稱，不會顯示 token）
```

### 2-4. 把設定放進 memory store

```sh
STORE_ID=$(jq -r '.resources["./memory_stores/security-scan-state.yaml"].id' claude-lock.json)
jq -n --arg ch "$DISCORD_CHANNEL_ID" \
  '{path: "/config.json", content: ({repo: "williampcs/RunningCoach", discord_channel_id: $ch} | tojson)}' \
  | ant beta:memory-stores:memories create --memory-store-id "$STORE_ID"
ant beta:memory-stores:memories list --memory-store-id "$STORE_ID" --view full   # 要看到 config.json 與裡面的頻道 ID
```

### 2-5. 建立兩個排程（建好馬上暫停）

排程的檔案要寫保險箱的 id（只是 id，不是秘密）：

```sh
sed -i.bak "s/YOUR_VAULT_ID/$VAULT_ID/" deployments/security-daily.md deployments/security-deep.md && rm deployments/*.bak
grep -n "vlt_" deployments/*.md     # 兩個檔案都要有
ant apply --dry-run -v deployments/security-daily.md deployments/security-deep.md   # 代理、沙盒顯示 unchanged，排程是 create
```

排程一建立就會開始算時間，所以建立和暫停要在同一行：

```sh
ant apply deployments/security-daily.md deployments/security-deep.md &&
  DAILY_ID=$(jq -r '.resources["./deployments/security-daily.md"].id' claude-lock.json) &&
  DEEP_ID=$(jq -r '.resources["./deployments/security-deep.md"].id' claude-lock.json) &&
  ant beta:deployments pause --deployment-id "$DAILY_ID" &&
  ant beta:deployments pause --deployment-id "$DEEP_ID"
```

把 `claude-lock.json` 與兩個排程的檔案 commit 並推到 `v2`（裡面只有 id，沒有秘密）：

```sh
git add claude-lock.json deployments/security-daily.md deployments/security-deep.md
git commit -m "security-scan: claude-lock.json and vault id" && git push origin v2
```

### 2-6. 第一次試跑：深掃兩次（proxy、sync）當作基準審查

```sh
ant beta:deployments run --deployment-id "$DEEP_ID"    # 暫停中也可以手動跑；第一次會挑 proxy
ant beta:deployment-runs list --deployment-id "$DEEP_ID" --max-items 1   # 看到 session_id
ant beta:sessions connect <session_id>                 # 在終端機看它在做什麼（Ctrl+C 離開，它會繼續跑）
```

也可以在 Console 的 **Managed Agents → Sessions** 看。跑完（大約 10–40 分鐘）再跑第二次，會挑 sync。

每次跑完確認：

- **Discord**：私人頻道收到一行「每週深掃 …：proxy，新發現 N 個」。
- **Security 分頁**：repo 的 **Security → Code scanning**，篩選 `tool:security-scan-agent branch:v2`，看得到發現（沒有發現就是空的，也正常）。
- **別人看不到**：用瀏覽器的無痕視窗（沒登入）打開 repo 的 Security 分頁，**不能**看到這些發現。看得到的話先暫停（下面的「暫停」），告訴協調 session。
- **費用**：`ant beta:sessions retrieve --session-id <session_id> --transform usage`（`list_cost` 是這次照定價算的花費），或 Console 的 **Usage / Cost**（選 security-scan 工作區）。一次不應該超過 5 美元；到了上限 session 會停在 `budget_reached`。

把「花了多少、幾個發現、看起來對不對」告訴協調 session（**不要貼漏洞的細節**）。沒問題再手動跑剩下的 5 片（sync-client、web、coach、discord、deploy；可以分幾天），完成基準。

### 2-7. 打開排程

```sh
ant beta:deployments unpause --deployment-id "$DAILY_ID"
ant beta:deployments unpause --deployment-id "$DEEP_ID"
unset ANTHROPIC_API_KEY
```

之後每天 04:23 與每週六 05:23 會自己跑（實際時間可能晚幾分鐘）。

---

## 平常會用到的

之後開新的終端機要先登入（2-1），在 `tools/security-scan/` 裡：

```sh
DAILY_ID=$(jq -r '.resources["./deployments/security-daily.md"].id' claude-lock.json)
DEEP_ID=$(jq -r '.resources["./deployments/security-deep.md"].id' claude-lock.json)
```

- **手動跑一次**：`ant beta:deployments run --deployment-id "$DAILY_ID"`（或 `$DEEP_ID`）。暫停中也可以。
- **看最近幾次**：`ant beta:deployment-runs list --deployment-id "$DAILY_ID" --max-items 5`；只看失敗的：加 `--has-error`。
- **暫停**（不會刪任何東西，隨時可以再打開）：`ant beta:deployments pause --deployment-id "$DAILY_ID"`，`$DEEP_ID` 也一樣。打開：`unpause`。
- **完全停掉**：兩個都暫停，再到 GitHub 撤銷 0-3 的 token、到 Console 停用 0-2 的 key。
- **看費用**：Console → **Usage / Cost**，選 security-scan 工作區；每月上限在那個工作區的 Limits。
- **處理發現**：在 Security 分頁看。要修的告訴協調 session（它會寫工作單，工作單只寫「要改什麼」）。不修的按 **Dismiss alert** 選 **Won't fix**，誤報選 **False positive**：代理下次跑會照著改自己的紀錄，不再回報。修好推上 `v2` 之後，代理確認問題不在了，那個警示會自動關掉。
- **換 GitHub 的 token**（到期前）：在 GitHub 產生新的一把（同樣的權限），然後：
  ```sh
  VAULT_ID=$(jq -r '.resources["./vaults/security-scan.yaml"].id' claude-lock.json)
  ant beta:vaults:credentials list --vault-id "$VAULT_ID"   # 找到 GitHub 那個的 id（vcrd_ 開頭）
  read -rs CMA_GITHUB_PAT && export CMA_GITHUB_PAT
  jq -n '{auth: {type: "environment_variable", secret_value: env.CMA_GITHUB_PAT}}' \
    | ant beta:vaults:credentials update --vault-id "$VAULT_ID" --credential-id <vcrd_...>
  unset CMA_GITHUB_PAT
  ```
- **改代理的提示、片或排程**：改這個目錄的檔案，推上 `v2`，再在本機跑 `ant apply --dry-run -v <改的檔案>` → `ant apply <改的檔案>`，把更新的 `claude-lock.json` commit。**不要**用 `ant apply .`（會把 repo 裡長得像設定檔的東西也套用），也不要自己加 `--force` 或 `--prune`。`scripts/` 與 `slices.yaml` 不用 apply：代理每次都從 `v2` 讀最新的。

## 給開發者

- `npm test` 會跑 `tools/test/security-scan.test.ts`：fingerprint 不受行號與縮排影響、去重與狀態的轉換、SARIF 的格式、片的定義（每個路徑都對得到 repo 裡的檔案）。改了 `slices.yaml` 的路徑而對不到檔案，測試會失敗。
- 腳本只用 Node 內建的模組（沙盒預設是 Node 22），不需要 `npm install`。在本機試：`node tools/security-scan/scripts/scan.mjs help`，加 `--dir <暫存的目錄>` 就不會碰 `/mnt/memory`。
- 去重：fingerprint ＝ 檔案路徑＋CWE＋正規化後的程式片段（去掉縮排與空行）的 SHA-256，不含行號。程式搬家時 `refresh` 會更新行號；找不到原來那幾行時，代理要再讀程式確認修好了才標 fixed。
- 上傳：每次上傳**全部還沒關閉的**發現（同一個類別 `security-scan-agent/` 每次會取代上一次；不在這次裡的，GitHub 當作已修好）。ref 是 `refs/heads/v2`。
- 這個 repo 是公開的：這裡只能放設定與提示。任何 token、發現的內容、漏洞的細節都不要寫進 repo。
