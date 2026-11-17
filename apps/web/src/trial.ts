/**
 * 免費試用（邀請碼，規格 12.39）：經作者的代理（apps/proxy）用 Claude Haiku 對話，每天有則數上限.
 *
 * 代理的網址在建置時決定（VITE_PROXY_URL）；選手貼上邀請碼 → 代理建立帳號、回傳憑證（只回一次）→ 憑證存在這台
 * （settings 的 proxy.token，密碼鎖開著時加密），不跟著多裝置同步. 剩下幾則由代理的 /v1/usage 回答.
 * 一個帳號可以有多台裝置：已經用著的那台要一個連結碼，另一台輸入後拿到自己的憑證（同一個帳號、同一份額度）.
 * 開著多裝置同步時，帳號的復原密鑰放在加密的同步裡（規格 12.44 第 1 步，trial-sync.ts），新的裝置用它拿自己的憑證.
 */
import { defaultDeviceLabel } from "./device-identity";
import { featureEnabled } from "./environment";
import type { AppSettings } from "./settings";

/** 建置時設定的代理網址；沒有時是空字串 */
export const TRIAL_PROXY_URL = (import.meta.env.VITE_PROXY_URL ?? "").trim().replace(/\/+$/, "");

/** 這個版本有沒有提供免費試用（功能開關與代理的網址都要有） */
export const trialAvailable = () => featureEnabled("trial") && TRIAL_PROXY_URL !== "";

/** 免費試用固定用的模型（代理換掉請求的模型，這裡只是讓本機的設定與顯示一致） */
export const TRIAL_MODEL = "claude-haiku-5-5";

/** 模型 ID 給人看的名字 */
export const modelLabel = (model: string | null | undefined) =>
  model ? model.replace(/^claude-/, "Claude ").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/(haiku|sonnet|opus)/, (m) => m[0]!.toUpperCase() + m.slice(1)) : "—";

/** 免費試用的思考強度給人看的說法；還沒拿到用量時照代理的預設（low） */
export function trialThinkingLabel(usage: Pick<TrialUsage, "thinking" | "effort"> | null | undefined): string {
  if (!usage) return "少量思考";
  if (!usage.thinking) return "不思考";
  if (usage.effort === "low") return "少量思考";
  if (usage.effort === "medium") return "中等思考";
  if (usage.effort) return "深入思考";
  return "會思考";
}

export interface TrialUsage {
  /** 這台用的帳號；舊的代理沒有這一欄 */
  account: string | null;
  model: string | null;
  thinking: boolean;
  /** 代理固定的思考強度（2026-11-11 起 low，規格 12.43）；舊的代理沒有這一欄 */
  effort: string | null;
  today: { messagesUsed: number; messagesLimit: number; autoUsed: number; autoLimit: number; resetsAt: string };
  /** 這個月的額度用完了：beta_budget 是所有試用的人合計、account_budget 是你自己的 */
  paused: "beta_budget" | "account_budget" | null;
  pausedUntil: string | null;
}

export type TrialLimit = { type: "daily_limit" | "daily_auto_limit" | "account_budget" | "beta_budget"; resetsAt: string | null };

export class TrialError extends Error {
  override name = "TrialError";
}

const proxyUrlOf = (s: AppSettings) => (s.proxy.url.trim() || TRIAL_PROXY_URL).replace(/\/+$/, "");

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? fallback;
}

/** 貼上的是邀請碼（12 個字，可以有 RC- 字首）還是連結碼（8 個字）；都不像時是 null */
export function codeKind(input: string): "invite" | "link" | null {
  const compact = input.toUpperCase().replace(/[\s-]/g, "");
  if (compact.length === 8) return "link";
  if (compact.length === 12 || (compact.length === 14 && compact.startsWith("RC"))) return "invite";
  return null;
}

/** 這台的粗略名稱（例「iPhone · Safari」），給裝置清單分辨是哪一台 */
const deviceName = () => (typeof navigator === "undefined" ? null : defaultDeviceLabel().name);

/**
 * 兌換邀請碼或連結碼；成功時回傳這台的憑證（只有這一次拿得到）.
 * 邀請碼建立新的試用帳號，連結碼加入已經在另一台用著的帳號
 */
export async function redeemInvite(code: string, proxyUrl = TRIAL_PROXY_URL, fetchImpl: typeof fetch = fetch): Promise<Issued> {
  const kind = codeKind(code);
  if (!kind) throw new TrialError("格式不對：邀請碼像 RC-XXXX-XXXX-XXXX，連結碼像 XXXX-XXXX。");
  let response: Response;
  try {
    response = await fetchImpl(`${proxyUrl}/v1/${kind === "invite" ? "redeem" : "link"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, device_name: deviceName() }),
    });
  } catch {
    throw new TrialError("連不上免費試用的服務，請檢查網路後再試一次。");
  }
  if (!response.ok) throw new TrialError(await errorMessage(response, `兌換失敗（${response.status}）`));
  const body = (await response.json()) as { token: string; account_id?: string; model?: string | null };
  return { token: body.token, account: body.account_id ?? null, model: body.model ?? null };
}

/** 兌換、連結碼、取回成功時代理回的：這台的憑證與帳號 */
interface Issued {
  token: string;
  account: string | null;
  model: string | null;
}

/**
 * 帳號的復原密鑰（規格 12.44 第 1 步）：產生一把新的，舊的作廢；只有這一次拿得到.
 * 有這台的憑證時用憑證；沒有時（用自己的 API key 的那台換同步金鑰）用目前的那一把
 */
export async function createRecoverySecret(
  proxyUrl: string,
  auth: { token: string } | { account: string; secret: string },
  fetchImpl: typeof fetch = fetch,
): Promise<{ account: string; secret: string }> {
  const response = await fetchImpl(`${proxyUrl.replace(/\/+$/, "")}/v1/recovery-secret`, {
    method: "POST",
    headers: "token" in auth ? { "x-api-key": auth.token.trim() } : { "content-type": "application/json" },
    body: "token" in auth ? undefined : JSON.stringify(auth),
  });
  if (!response.ok) throw new TrialError(await errorMessage(response, `拿不到復原密鑰（${response.status}）`));
  const body = (await response.json()) as { account_id: string; secret: string };
  return { account: body.account_id, secret: body.secret };
}

/** 用同步裡的復原密鑰拿到這台自己的憑證（同一個帳號、同一份額度） */
export async function recoverTrial(proxyUrl: string, account: string, secret: string, fetchImpl: typeof fetch = fetch): Promise<Issued> {
  let response: Response;
  try {
    response = await fetchImpl(`${proxyUrl.replace(/\/+$/, "")}/v1/recover`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, secret, device_name: deviceName() }),
    });
  } catch {
    throw new TrialError("連不上免費試用的服務，請檢查網路後再試一次。");
  }
  if (!response.ok) throw new TrialError(await errorMessage(response, `取回失敗（${response.status}）`));
  const body = (await response.json()) as { token: string; account_id?: string; model?: string | null };
  return { token: body.token, account: body.account_id ?? null, model: body.model ?? null };
}

/** 在另一台裝置使用：要一個連結碼（10 分鐘內在另一台輸入，用一次） */
export async function createLinkCode(s: AppSettings, fetchImpl: typeof fetch = fetch): Promise<{ code: string; expiresAt: string }> {
  const response = await fetchImpl(`${proxyUrlOf(s)}/v1/link-codes`, { method: "POST", headers: { "x-api-key": s.proxy.token.trim() } });
  if (!response.ok) throw new TrialError(await errorMessage(response, `拿不到連結碼（${response.status}）`));
  const body = (await response.json()) as { code: string; expires_at: string };
  return { code: body.code, expiresAt: body.expires_at };
}

export interface TrialDevice {
  id: string;
  name: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  /** 就是這一台 */
  current: boolean;
}

export async function listTrialDevices(s: AppSettings, fetchImpl: typeof fetch = fetch): Promise<TrialDevice[]> {
  const response = await fetchImpl(`${proxyUrlOf(s)}/v1/devices`, { headers: { "x-api-key": s.proxy.token.trim() } });
  if (!response.ok) throw new TrialError(await errorMessage(response, `查不到裝置（${response.status}）`));
  const body = (await response.json()) as { devices: { id: string; name: string | null; created_at: string; last_used_at: string | null; current: boolean }[] };
  return body.devices.map((d) => ({ id: d.id, name: d.name, createdAt: d.created_at, lastUsedAt: d.last_used_at, current: d.current }));
}

/** 移除某一台（撤銷那台的憑證；那台之後要重新輸入邀請碼或連結碼） */
export async function removeTrialDevice(s: AppSettings, id: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${proxyUrlOf(s)}/v1/devices/${encodeURIComponent(id)}`, { method: "DELETE", headers: { "x-api-key": s.proxy.token.trim() } });
  if (!response.ok) throw new TrialError(await errorMessage(response, `移除失敗（${response.status}）`));
}

/** 今天還剩幾則；網路不通或憑證失效時丟出錯誤 */
export async function fetchTrialUsage(s: AppSettings, fetchImpl: typeof fetch = fetch): Promise<TrialUsage> {
  const response = await fetchImpl(`${proxyUrlOf(s)}/v1/usage`, { headers: { "x-api-key": s.proxy.token.trim() } });
  if (!response.ok) throw new TrialError(await errorMessage(response, `查不到剩下的次數（${response.status}）`));
  const body = (await response.json()) as any;
  return {
    account: typeof body.account_id === "string" ? body.account_id : null,
    model: body.model ?? null,
    thinking: !!body.thinking,
    effort: typeof body.effort === "string" ? body.effort : null,
    today: {
      messagesUsed: body.today?.messages_used ?? 0,
      messagesLimit: body.today?.messages_limit ?? 0,
      autoUsed: body.today?.auto_used ?? 0,
      autoLimit: body.today?.auto_limit ?? 0,
      resetsAt: body.today?.resets_at ?? "",
    },
    paused: body.paused ?? null,
    pausedUntil: body.paused_until ?? null,
  };
}

/** 刪除這個試用帳號（代理那邊的帳號、每天的次數、每月的用量） */
export async function deleteTrialAccount(s: AppSettings, fetchImpl: typeof fetch = fetch): Promise<void> {
  const response = await fetchImpl(`${proxyUrlOf(s)}/v1/account`, { method: "DELETE", headers: { "x-api-key": s.proxy.token.trim() } });
  // 帳號已經不在了（401）也算刪掉了
  if (!response.ok && response.status !== 401) throw new TrialError(await errorMessage(response, `刪除失敗（${response.status}）`));
}

const LIMIT_TYPES = new Set(["daily_limit", "daily_auto_limit", "account_budget", "beta_budget"]);

/** 代理回的「次數或額度用完了」（Anthropic SDK 的 APIError：error 是回應的內容） */
export function trialLimitOf(e: unknown): TrialLimit | null {
  const body = (e as { error?: { error?: { type?: string; resets_at?: string } } } | null)?.error;
  const type = body?.error?.type;
  if (!type || !LIMIT_TYPES.has(type)) return null;
  return { type: type as TrialLimit["type"], resetsAt: body?.error?.resets_at ?? null };
}

/** 恢復的時間給人看：明天 00:00、12 月 1 日 */
export function resetText(iso: string | null, now = new Date()): string {
  if (!iso) return "之後";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "之後";
  const local = (d: Date) => new Date(d.getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
  const tomorrow = local(new Date(now.getTime() + 86_400_000));
  if (local(at) === tomorrow) return "明天 00:00（台灣時間）";
  const [, m, d] = local(at).split("-").map(Number);
  return `${m} 月 ${d} 日`;
}

/** 用完時的說明（對話頁與錯誤訊息共用） */
export function limitText(limit: TrialLimit, dailyMessages?: number, now = new Date()): string {
  switch (limit.type) {
    case "daily_limit":
      return `今天的${dailyMessages ? ` ${dailyMessages} ` : ""}則用完了，${resetText(limit.resetsAt, now)}恢復。`;
    case "daily_auto_limit":
      return `今天自動分析的次數用完了，${resetText(limit.resetsAt, now)}恢復；你還是可以在對話裡請教練看這一趟。`;
    case "account_budget":
      return `你這個月的免費額度用完了，${resetText(limit.resetsAt, now)}恢復。`;
    case "beta_budget":
      return `這個月的免費額度用完了（所有試用的人合計），${resetText(limit.resetsAt, now)}恢復。`;
  }
}
