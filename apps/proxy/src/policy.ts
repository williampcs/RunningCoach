/** 代理的使用政策：可用模型、單次上限、每月預算與計費權重. */

/** 每百萬 token 的美元價格 */
export interface ModelPrice {
  input: number;
  output: number;
  /** 未設定時以輸入價的 0.1 倍計 */
  cacheRead?: number;
  /** 未設定時以輸入價的 1.25 倍計 */
  cacheWrite?: number;
}

export interface Policy {
  /** 模型白名單與其價格；不在名單內的模型一律拒絕 */
  models: Record<string, ModelPrice>;
  /** 單次請求的 max_tokens 上限 */
  maxOutputTokens: number;
  /** 帳號未個別設定時的每月預算（美元） */
  defaultMonthlyBudgetUsd: number;
  /** 每個帳號每分鐘的請求數上限 */
  requestsPerMinute: number;
  /** 請求內容的大小上限（bytes） */
  maxBodyBytes: number;
}

/**
 * 預設政策。價格為撰寫時（2026-10）Anthropic 的公開定價，
 * 部署前請對照現行價目並以 PROXY_POLICY 環境變數覆寫。
 */
export const DEFAULT_POLICY: Policy = {
  models: {
    "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
    "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
    "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  },
  maxOutputTokens: 16000,
  defaultMonthlyBudgetUsd: 3,
  requestsPerMinute: 20,
  maxBodyBytes: 512 * 1024,
};

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const usdToMicro = (usd: number) => Math.round(usd * 1_000_000);

/** 一次請求的成本（百萬分之一美元）。token 數 × 每百萬 token 美元價 = 百萬分之一美元 */
export function costMicroUsd(price: ModelPrice, usage: TokenUsage): number {
  return Math.ceil(
    usage.input * price.input +
      usage.output * price.output +
      usage.cacheRead * (price.cacheRead ?? price.input * 0.1) +
      usage.cacheWrite * (price.cacheWrite ?? price.input * 1.25),
  );
}

/** 以環境變數中的 JSON 覆寫部分政策 */
export function loadPolicy(json: string | undefined): Policy {
  if (!json?.trim()) return DEFAULT_POLICY;
  const override = JSON.parse(json) as Partial<Policy>;
  const policy = { ...DEFAULT_POLICY, ...override };
  if (!Object.keys(policy.models).length) throw new Error("PROXY_POLICY：models 不可為空");
  return policy;
}
