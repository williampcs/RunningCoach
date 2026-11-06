/**
 * 設定精靈的「貼上 key 就檢查」（規格 12.35 的 A）：打一次最便宜的請求（一句話、最多 16 個 token），
 * 把錯誤換成一般人看得懂的話. 只送「ping」，不送選手的任何資料.
 */
import { LlmError, type LlmProvider } from "./types";

export type KeyProblem =
  /** key 打錯、被撤銷 */
  | "key"
  /** 帳號沒有額度（還沒儲值、用完了） */
  | "credit"
  /** 模型的名稱不對，或這把 key 用不了這個模型 */
  | "model"
  /** 請求太多（多半是免費層的次數上限） */
  | "rate"
  /** 連不上（網路、被擋） */
  | "network"
  | "other";

export type KeyCheck = { ok: true } | { ok: false; problem: KeyProblem; message: string };

const MESSAGES: Record<KeyProblem, string> = {
  key: "key 不對：確認整串都有複製到（前後沒有空白），或回到供應商的網站重新產生一把。",
  credit: "這個帳號還沒有額度：到供應商網站的 Billing（帳單）頁儲值後再試一次。",
  model: "這把 key 用不了這個模型：確認模型的名稱，或帳號有沒有開通。",
  rate: "請求太多，供應商暫時擋下來了：等一分鐘再試；免費的 key 次數比較少。",
  network: "連不上供應商：確認網路，或稍後再試。",
  other: "供應商回了錯誤，請稍後再試。",
};

function statusOf(e: unknown): number | null {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : null;
}

/** 供應商的錯誤 → 哪一類問題（Anthropic SDK 與 OpenAI 相容轉接層的錯誤都有 status） */
export function classifyKeyError(e: unknown): KeyProblem {
  const status = statusOf(e);
  const text = (e instanceof Error ? e.message : String(e)).toLowerCase();
  if (/credit balance|insufficient_quota|billing|quota|payment|余额|額度/.test(text) || status === 402) return "credit";
  if (status === 401 || /invalid x-api-key|invalid api key|incorrect api key|api key not valid|authentication/.test(text)) return "key";
  if (status === 403) return /model|permission/.test(text) ? "model" : "key";
  if (status === 404 || /model.*(not found|does not exist)|not_found_error/.test(text)) return "model";
  if (status === 429 || /rate limit|too many requests|resource_exhausted/.test(text)) return "rate";
  if (status === null && /fetch|network|connection|timeout|timed out|enotfound|econnrefused|cors/.test(text)) return "network";
  return "other";
}

export function keyProblemText(problem: KeyProblem): string {
  return MESSAGES[problem];
}

/** 檢查 key 能不能用：成功、或模型沒產生文字（LlmError，代表 key 本身可以用）都算可以用 */
export async function checkLlmKey(provider: LlmProvider, model: string): Promise<KeyCheck> {
  try {
    await provider.startChat({ model, messages: [{ role: "user", content: "ping" }], maxTokens: 16, effort: "low" }).next();
    return { ok: true };
  } catch (e) {
    if (e instanceof LlmError) return { ok: true };
    const problem = classifyKeyError(e);
    return { ok: false, problem, message: MESSAGES[problem] };
  }
}
