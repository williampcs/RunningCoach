/**
 * 免費試用代理的管理工具（規格 12.39）：在你自己的電腦上執行，產生邀請碼、看用量、停用帳號.
 *
 *   npx tsx tools/proxy-admin.ts summary                         這個月的總花費、總預算、帳號數
 *   npx tsx tools/proxy-admin.ts invite --count 5 --expires 2026-12-31 [--budget 10] [--label 第一批]
 *                                                                產生邀請碼（只會顯示這一次，請自己記下來再給朋友）
 *   npx tsx tools/proxy-admin.ts invites                         列出邀請碼（沒用過／用過／停用／過期；不會再顯示碼本身）
 *   npx tsx tools/proxy-admin.ts revoke inv_xxxx                 停用一張還沒用的邀請碼
 *   npx tsx tools/proxy-admin.ts accounts                        列出帳號、這個月的花費、今天的則數
 *   npx tsx tools/proxy-admin.ts suspend acct_xxxx | resume acct_xxxx | delete acct_xxxx
 *
 * 加 --staging 時改用 staging 的代理.
 * 網址與管理憑證放在 repo 根目錄的 .env（不進版控）：
 *   PROXY_URL=https://running-coach-proxy.<子網域>.workers.dev
 *   PROXY_ADMIN_TOKEN=...（和 GitHub Secrets 的 PROXY_ADMIN_TOKEN 同一個）
 *   STAGING_PROXY_URL=...、STAGING_PROXY_ADMIN_TOKEN=...（--staging 用）
 * 管理憑證不印出。label 只是你自己分批用的名字，不要寫朋友的真名.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

type Json = Record<string, any>;

export interface AdminTarget {
  url: string;
  token: string;
}

export function targetFromEnv(env: NodeJS.ProcessEnv, staging: boolean): AdminTarget {
  const prefix = staging ? "STAGING_" : "";
  const url = env[`${prefix}PROXY_URL`]?.trim();
  const token = env[`${prefix}PROXY_ADMIN_TOKEN`]?.trim();
  if (!url || !token) throw new Error(`.env 裡要有 ${prefix}PROXY_URL 與 ${prefix}PROXY_ADMIN_TOKEN`);
  return { url: url.replace(/\/+$/, ""), token };
}

export async function call(target: AdminTarget, method: string, path: string, body?: object, fetchImpl: typeof fetch = fetch): Promise<Json> {
  const response = await fetchImpl(`${target.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) throw new Error(`${response.status} ${data?.error?.message ?? "代理回了錯誤"}`);
  return data;
}

const usd = (n: number | null | undefined) => (n === null || n === undefined ? "不限" : `US$${n.toFixed(4)}`);
const date = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "—");

/** 執行一個指令，回傳要印的文字（測試直接比對） */
export async function run(argv: string[], target: AdminTarget, fetchImpl: typeof fetch = fetch): Promise<string> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      count: { type: "string" },
      expires: { type: "string" },
      budget: { type: "string" },
      label: { type: "string" },
      staging: { type: "boolean" },
    },
  });
  const [command, id] = positionals;
  const api = (method: string, path: string, body?: object) => call(target, method, path, body, fetchImpl);

  switch (command) {
    case "summary": {
      const s = await api("GET", "/admin/summary");
      return [
        `${s.period}：花費 ${usd(s.cost_usd)}／總預算 ${usd(s.total_budget_usd)}${s.paused ? "（已暫停，下個月 1 日恢復）" : ""}，${s.requests} 次請求`,
        `帳號 ${s.accounts} 個（使用中 ${s.active_accounts}），沒用過的邀請碼 ${s.unused_invites} 張`,
        `政策：${s.policy.model ?? "照請求的模型"}${s.policy.thinking ? (s.policy.effort ? `、思考強度 ${s.policy.effort}` : "") : "、不思考"}、每天 ${s.policy.daily_messages} 則、自動分析 ${s.policy.daily_auto} 次、每人每月 ${usd(s.policy.monthly_budget_usd)}`,
      ].join("\n");
    }
    case "invite": {
      const body: Json = { count: values.count ? Number(values.count) : 1 };
      if (values.expires) body.expires_at = values.expires;
      if (values.budget) body.monthly_budget_usd = Number(values.budget);
      if (values.label) body.label = values.label;
      const { invites } = await api("POST", "/admin/invites", body);
      return [
        `產生了 ${invites.length} 張邀請碼（只會顯示這一次）：`,
        ...invites.map((i: Json) => `  ${i.code}   ${i.id}   到期：${date(i.expires_at)}`),
        "給朋友時說：打開 Zone2Mate → 設定 → AI 教練 →「免費試用（邀請碼）」貼上。一碼只能用一次。",
      ].join("\n");
    }
    case "invites": {
      const { invites } = await api("GET", "/admin/invites");
      if (!invites.length) return "還沒有邀請碼。";
      const label = { unused: "沒用過", used: "用過", revoked: "停用", expired: "過期" } as Record<string, string>;
      return invites
        .map((i: Json) => `${i.id}  ${label[i.status] ?? i.status}  ${i.label ?? ""}  產生 ${date(i.created_at)}  到期 ${date(i.expires_at)}  ${i.account_id ?? ""}`.trim())
        .join("\n");
    }
    case "revoke": {
      if (!id) throw new Error("要給邀請碼的 id（inv_…）");
      await api("PATCH", `/admin/invites/${id}`, { revoked: true });
      return `已停用 ${id}`;
    }
    case "accounts": {
      const { accounts } = await api("GET", "/admin/accounts");
      if (!accounts.length) return "還沒有帳號。";
      return accounts
        .map(
          (a: Json) =>
            `${a.id}  ${a.status === "active" ? "使用中" : "停用"}  本月 ${usd(a.usage.cost_usd)}／${usd(a.monthly_budget_usd)}  ` +
            `今天 ${a.today.messages} 則、自動 ${a.today.auto} 次  建立 ${date(a.created_at)}`,
        )
        .join("\n");
    }
    case "suspend":
    case "resume": {
      if (!id) throw new Error("要給帳號的 id（acct_…）");
      await api("PATCH", `/admin/accounts/${id}`, { status: command === "suspend" ? "suspended" : "active" });
      return `${id} 已${command === "suspend" ? "停用" : "恢復"}`;
    }
    case "delete": {
      if (!id) throw new Error("要給帳號的 id（acct_…）");
      await api("DELETE", `/admin/accounts/${id}`);
      return `已刪除 ${id}（帳號與它的用量）`;
    }
    default:
      throw new Error("指令：summary、invite、invites、revoke、accounts、suspend、resume、delete（說明在檔案開頭）");
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const envFile = fileURLToPath(new URL("../.env", import.meta.url));
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const argv = process.argv.slice(2);
  try {
    console.log(await run(argv, targetFromEnv(process.env, argv.includes("--staging"))));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
