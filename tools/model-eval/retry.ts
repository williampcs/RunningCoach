/**
 * 送出的錯誤怎麼處理（使用者擔心大量送高風險的請求會出事，2026-11-10）：
 * - 忙碌或超過速率（429、529、overloaded）：等一下再試（指數退避），最多再試 3 次；還是失敗就記成「送出失敗」，不算模型沒過
 * - key 無效或沒有權限（401、403）：整個停下來，不重試
 */
import type { RunRecord } from "./types";

export type ErrorKind = "busy" | "fatal" | "other";

export function errorKind(r: Pick<RunRecord, "finish" | "error" | "errorStatus">): ErrorKind | null {
  if (r.finish !== "error") return null;
  const status = r.errorStatus;
  const text = (r.error ?? "").toLowerCase();
  if (status === 401 || status === 403 || /authentication|permission|invalid x-api-key|invalid api key/.test(text)) return "fatal";
  if (status === 429 || status === 529 || /overloaded|rate.?limit/.test(text)) return "busy";
  return "other";
}

/** key 無效或沒有權限：停止整個執行 */
export class FatalApiError extends Error {
  override name = "FatalApiError";
}

export interface RetryOptions {
  /** 最多再試幾次 */
  retries?: number;
  /** 第一次等多久（毫秒），之後每次加倍 */
  baseMs?: number;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (attempt: number, waitMs: number, record: RunRecord) => void;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 跑一格；忙碌時退避重試，最後還是忙碌就標「送出失敗」；key 的問題丟出 FatalApiError */
export async function runWithRetry(run: () => Promise<RunRecord>, options: RetryOptions = {}): Promise<RunRecord> {
  const retries = options.retries ?? 3;
  const baseMs = options.baseMs ?? 15_000;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    const record = await run();
    const kind = errorKind(record);
    if (kind === "fatal") throw new FatalApiError(`API 拒絕了這把 key（${record.errorStatus ?? ""} ${record.error ?? ""}）`.trim());
    if (kind !== "busy") return record;
    if (attempt >= retries) return { ...record, finish: "send-failed" };
    const waitMs = baseMs * 2 ** attempt;
    options.onRetry?.(attempt + 1, waitMs, record);
    await sleep(waitMs);
  }
}
