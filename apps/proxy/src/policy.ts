/** 代理的使用政策：可用模型、單次上限、每天的次數、每月預算與計費權重（免費試用的內測，規格 12.39）. */

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

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
  /** 單次請求的 max_tokens 上限；超過時改成這個數字（不拒絕） */
  maxOutputTokens: number;
  /** 帳號未個別設定時的每月預算（美元） */
  defaultMonthlyBudgetUsd: number;
  /**
   * 所有帳號這個月合計的上限（美元）；超過時全部暫停到下個月（規格 12.39 的「總預算」）. null 表示不限
   */
  totalMonthlyBudgetUsd: number | null;
  /** 一律改用這個模型（免費試用用便宜的模型，選手不能改）；null 表示照請求的模型（要在白名單內） */
  forceModel: string | null;
  /** 關掉思考：拿掉 output_config 的思考強度、送 thinking disabled（不能和 forceEffort 同時開） */
  disableThinking: boolean;
  /**
   * 固定思考強度：請求的 output_config.effort 一律改成這個、不送 thinking（照模型預設的 adaptive）；null 表示照請求的.
   * 對話、自動的分析與壓縮都一樣（規格 12.43：免費試用用 Haiku low）
   */
  forceEffort: Effort | null;
  /** 每個帳號每天幾則對話（選手送出的一則算一則，工具迴圈不重複算） */
  dailyMessages: number;
  /** 每天幾次自動的分析（跑後摘要、騎車分析），不扣對話的則數 */
  dailyAuto: number;
  /** 每天幾次對話壓縮（跟著對話自動發生，畫面上不顯示）；防止被拿來繞過對話的則數 */
  dailyCompress: number;
  /** 每天從這個時區的午夜算起（分鐘，台灣 +480）；每月的週期也照這個時區 */
  timeZoneOffsetMinutes: number;
  /** 每天的次數留幾天、每月的用量留幾個月，到期自動刪除 */
  dailyRetentionDays: number;
  monthlyRetentionMonths: number;
  /** 每個來源 IP 每分鐘最多兌換幾次邀請碼或連結碼（盡力而為） */
  redeemsPerMinute: number;
  /** 連結碼（在另一台裝置使用）幾分鐘內有效 */
  linkCodeMinutes: number;
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
  // 內測（規格 12.39，2026-11-10 的決定）：每人每月 10 美元、合計 60 美元、每天 15 則、自動的分析 2 次；
  // 模型 Haiku、思考強度 low（2026-11-11 從不思考改成 low，規格 12.43 的模型對照）
  defaultMonthlyBudgetUsd: 10,
  totalMonthlyBudgetUsd: 60,
  forceModel: "claude-haiku-5-5",
  disableThinking: false,
  forceEffort: "low",
  dailyMessages: 15,
  dailyAuto: 2,
  dailyCompress: 10,
  timeZoneOffsetMinutes: 480,
  dailyRetentionDays: 90,
  monthlyRetentionMonths: 13,
  redeemsPerMinute: 10,
  linkCodeMinutes: 10,
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
  if (policy.forceModel !== null && !(policy.forceModel in policy.models)) {
    throw new Error(`PROXY_POLICY：forceModel ${policy.forceModel} 不在 models 裡（要有價格才能算用量）`);
  }
  if (policy.forceEffort !== null && !EFFORTS.includes(policy.forceEffort)) {
    throw new Error(`PROXY_POLICY：forceEffort 要是 ${EFFORTS.join("、")} 或 null`);
  }
  if (policy.forceEffort !== null && policy.disableThinking) {
    throw new Error("PROXY_POLICY：forceEffort 和 disableThinking 不能同時開（要不思考時把 forceEffort 設成 null）");
  }
  if (policy.disableThinking && policy.forceModel !== null && !policy.forceModel.startsWith("claude-haiku")) {
    // Opus 5.5、Sonnet 5.5 送 thinking disabled 會回 400
    throw new Error(`PROXY_POLICY：${policy.forceModel} 不能關掉思考（disableThinking 只給 Haiku）`);
  }
  for (const key of ["dailyMessages", "dailyAuto", "dailyCompress", "defaultMonthlyBudgetUsd", "maxOutputTokens"] as const) {
    if (typeof policy[key] !== "number" || !(policy[key] >= 0)) throw new Error(`PROXY_POLICY：${key} 要是不小於 0 的數字`);
  }
  return policy;
}
