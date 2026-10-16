/**
 * 模型單價與費用估算（美元）.
 *
 * 單價取自 Anthropic 官方價格表（https://platform.claude.com/docs/en/about-claude/pricing，2026-10-16 查證），
 * 每百萬 token 計。只收錄 Claude API 直連可用的模型；其他供應商的模型名稱由使用者自填，單價無從得知，不估算。
 * 改價或新增模型時更新這裡。
 */
import type { TurnUsage } from "./types";

export interface ModelPrice {
  input: number;
  /** 5 分鐘快取的寫入；1 小時快取的寫入是輸入價的 2 倍，目前沒有使用 */
  cacheWrite: number;
  cacheRead: number;
  /** 含思考 token */
  output: number;
}

const price = (input: number, cacheWrite: number, cacheRead: number, output: number): ModelPrice => ({
  input,
  cacheWrite,
  cacheRead,
  output,
});

// 模型 ID 要完全相同，或只多一段日期後綴
const CLAUDE_PRICES: [string, ModelPrice][] = [
  ["claude-fable-5-1", price(10, 12.5, 0.25, 50)],
  ["claude-fable-5", price(10, 12.5, 1, 50)],
  ["claude-opus-5-5", price(4, 5, 0.2, 20)],
  ["claude-opus-5", price(5, 6.25, 0.5, 25)],
  ["claude-opus-4-8", price(5, 6.25, 0.5, 25)],
  ["claude-opus-4-7", price(5, 6.25, 0.5, 25)],
  ["claude-opus-4-6", price(5, 6.25, 0.5, 25)],
  ["claude-opus-4-5", price(5, 6.25, 0.5, 25)],
  ["claude-sonnet-5-5", price(2, 2.5, 0.1, 10)],
  ["claude-sonnet-5", price(2, 2.5, 0.2, 10)],
  ["claude-sonnet-4-6", price(3, 3.75, 0.3, 15)],
  ["claude-sonnet-4-5", price(3, 3.75, 0.3, 15)],
  ["claude-haiku-5-5", price(0.1, 0.125, 0.01, 0.5)],
  ["claude-haiku-4-5", price(1, 1.25, 0.1, 5)],
];

/** Haiku 5.5 單次請求的提示（含快取讀寫）超過 10 萬 token 時改用較高的單價 */
const HAIKU_5_5_LONG_PROMPT = { threshold: 100_000, price: price(0.5, 0.625, 0.05, 2.5) };

/**
 * 模型 ID 可能帶日期後綴，例：claude-sonnet-4-5-20250929。
 * 其他後綴一律不認（例如未來的 claude-opus-5-6 不能套用 claude-opus-5 的價格），寧可不估算也不要估錯。
 */
function lookup(model: string): [string, ModelPrice] | null {
  const id = model.trim().toLowerCase();
  return CLAUDE_PRICES.find(([key]) => id === key || new RegExp(`^${key}-\\d{8}$`).test(id)) ?? null;
}

/** 單次 API 呼叫的單價；不在價格表的模型回傳 null */
export function priceOf(model: string, promptTokens = 0): ModelPrice | null {
  const found = lookup(model);
  if (!found) return null;
  const [key, base] = found;
  return key === "claude-haiku-5-5" && promptTokens > HAIKU_5_5_LONG_PROMPT.threshold ? HAIKU_5_5_LONG_PROMPT.price : base;
}

/** 單次 API 呼叫的費用（美元）；不在價格表的模型回傳 null */
export function turnCostUsd(model: string, usage: TurnUsage): number | null {
  const p = priceOf(model, usage.input + usage.cacheRead + usage.cacheWrite);
  if (!p) return null;
  return (
    (usage.input * p.input + usage.cacheWrite * p.cacheWrite + usage.cacheRead * p.cacheRead + usage.output * p.output) /
    1_000_000
  );
}
