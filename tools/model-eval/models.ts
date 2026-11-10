/** 模型設定與費用估算. */
import { priceOf } from "../../packages/core/src";

import type { ModelConfig, Scenario } from "./types";

/**
 * 可以比的模型設定（--models 用 id 選）.
 * - Opus 5.5 不能關思考（effort 是唯一的控制）；Sonnet 5.5 用核心平常的送法（思考強度）
 * - Haiku 5.5 不思考：thinking disabled、不送思考強度，和免費試用的代理一樣（規格 12.39）
 */
export const MODEL_CONFIGS: ModelConfig[] = [
  { id: "opus", label: "Opus 5.5（medium）", model: "claude-opus-5-5", effort: "medium" },
  { id: "sonnet", label: "Sonnet 5.5（medium）", model: "claude-sonnet-5-5", effort: "medium" },
  { id: "haiku-off", label: "Haiku 5.5 不思考（＝免費試用）", model: "claude-haiku-5-5", effort: "medium", disableThinking: true },
  { id: "haiku-low", label: "Haiku 5.5（low）", model: "claude-haiku-5-5", effort: "low" },
  { id: "haiku-medium", label: "Haiku 5.5（medium）", model: "claude-haiku-5-5", effort: "medium" },
];

/** 只有這些模型可以關思考（Opus 5.5、Sonnet 5.5 送 thinking disabled 會回 400） */
const CAN_DISABLE_THINKING = ["claude-haiku-5-5"];

export function checkModelConfig(m: ModelConfig): void {
  if (m.disableThinking && !CAN_DISABLE_THINKING.includes(m.model)) throw new Error(`${m.label}：這個模型不能關掉思考`);
  if (m.disableThinking && (m.effort === "xhigh" || m.effort === "max")) throw new Error(`${m.label}：關掉思考時思考強度要在 high 以下`);
}

/** 依 id 選模型設定；沒給時全部 */
export function pickModels(ids: string[] | undefined): ModelConfig[] {
  if (!ids?.length) return MODEL_CONFIGS;
  return ids.map((id) => {
    const found = MODEL_CONFIGS.find((m) => m.id === id);
    if (!found) throw new Error(`不認得的模型設定：${id}（可以用：${MODEL_CONFIGS.map((m) => m.id).join("、")}）`);
    return found;
  });
}

/** 依 id 選情境；沒給時全部 */
export function pickScenarios(all: Scenario[], ids: string[] | undefined): Scenario[] {
  if (!ids?.length) return all;
  const picked = ids.flatMap((id) => {
    // 「一般」「高風險」選一整組
    const group = all.filter((s) => s.group === id);
    if (group.length) return group;
    const found = all.find((s) => s.id === id);
    if (!found) throw new Error(`不認得的情境：${id}（可以用：${all.map((s) => s.id).join("、")}，或「一般」「高風險」）`);
    return [found];
  });
  return [...new Set(picked)];
}

/**
 * 估算時的假設（每次模型呼叫）：輸入是系統提示＋工具（約 PROMPT_TOKENS），第一次寫進快取、之後讀快取；
 * 輸出是回覆（約 REPLY_TOKENS）加思考（不思考時 0）. 實際的金額在報告裡（用 API 回的 token 算）
 */
export const ESTIMATE = {
  promptTokens: 14_000,
  replyTokens: 900,
  thinkingTokens: { off: 0, low: 600, medium: 1500, high: 3000, xhigh: 5000, max: 8000 } as Record<string, number>,
};

export function estimateCost(scenario: Scenario, model: ModelConfig): number {
  const price = priceOf(model.model, ESTIMATE.promptTokens);
  if (!price) return 0;
  const calls = scenario.expectedCalls * scenario.messages.length;
  const thinking = model.disableThinking ? 0 : (ESTIMATE.thinkingTokens[model.effort] ?? 0);
  // 第一次寫快取、之後讀快取；每一輪多送前一輪的輸出（約 REPLY_TOKENS）未快取
  const input = ESTIMATE.promptTokens * price.cacheWrite + (calls - 1) * (ESTIMATE.promptTokens * price.cacheRead + ESTIMATE.replyTokens * price.input);
  const output = calls * (ESTIMATE.replyTokens + thinking) * price.output;
  return (input + output) / 1_000_000;
}

export interface CostEstimate {
  perModel: { model: ModelConfig; usd: number }[];
  total: number;
}

export function estimateAll(scenarios: Scenario[], models: ModelConfig[]): CostEstimate {
  const perModel = models.map((model) => ({ model, usd: scenarios.reduce((sum, s) => sum + estimateCost(s, model), 0) }));
  return { perModel, total: perModel.reduce((sum, m) => sum + m.usd, 0) };
}
