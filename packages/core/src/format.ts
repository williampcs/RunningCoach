/** 各外殼共用的文字格式：token 用量頁尾與系統狀態. */
import type { UsageStats } from "./coach";
import { RECENT_WORKOUT_DAYS, type StatusSummary } from "./context";
import type { Purpose } from "./llm";
import type { CoachSettings } from "./types";

const LAYER_LABELS = [
  ["layer1", "層1系統"],
  ["layer4", "層4摘要"],
  ["layer5", "層5對話"],
] as const;

const fmt = (n: number) => n.toLocaleString("en-US");

/** token 用量摘要，例：📊 輸入 1,847（層1系統~312  訊息~233） | 輸出 412 */
export function formatTokenFooter(stats: UsageStats): string {
  const u = stats.usage;
  const totalChars = Object.values(stats.layerChars).reduce((a, b) => a + b, 0) + stats.userMsgChars;
  if (totalChars === 0 || u.firstInputTokens === 0) return "";

  const est = (chars: number) => fmt(Math.round((u.firstInputTokens * chars) / totalChars));
  const details: string[] = [];
  for (const [key, label] of LAYER_LABELS) {
    const chars = stats.layerChars[key];
    if (chars > 0) details.push(`${label}~${est(chars)}`);
  }
  details.push(`訊息~${est(stats.userMsgChars)}`);

  // 有 tool call 時每輪都會重送整段 context，累計輸入才是實際計費量
  let extra = "";
  if (u.toolRounds > 0) extra += ` | 工具 ${u.toolRounds} 輪，累計輸入 ${fmt(u.totalInputTokens)}`;
  if (u.cacheReadTokens || u.cacheWriteTokens) {
    extra += ` | 快取 讀 ${fmt(u.cacheReadTokens)} 寫 ${fmt(u.cacheWriteTokens)}`;
  }

  return `📊 輸入 ${fmt(u.firstInputTokens)}（${details.join("  ")}） | 輸出 ${fmt(u.outputTokens)}${extra}`;
}

/** 系統狀態（模型設定與五層記憶），Markdown 格式 */
export function formatStatus(s: StatusSummary, models: Record<Purpose, string>, settings: CoachSettings): string {
  const convBar = s.conversationCount >= s.conversationMax * 0.8 ? "🟡" : "🟢";
  const plan = s.trainingPlanLabel ? `有（${s.trainingPlanLabel}）` : "尚未設定";
  const summary = s.convSummaryChars ? `有（${s.convSummaryChars} 字）` : "無（尚未觸發壓縮）";

  return [
    "**📊 系統狀態**",
    "",
    "**模型**",
    `　主對話：${models.chat}`,
    `　跑後摘要：${models.summary}`,
    `　對話壓縮：${models.compress}`,
    "",
    "**層1 — System Prompt（每次帶入）**",
    `　選手資料：${s.profileKeys} 筆`,
    `　近期賽事（${settings.raceLookaheadDays} 天內）：${s.upcomingRaces} 筆`,
    `　待記錄成績的賽事（${settings.raceLookbackDays} 天內）：${s.unrecordedRaces} 筆`,
    "",
    "**層2 — 訓練歷史（需要時由 tool 載入）**",
    `　最近 ${RECENT_WORKOUT_DAYS} 天：${s.recentWorkouts} 筆｜累計：${s.totalWorkouts} 筆`,
    `　待合併的主觀感受：${s.pendingSubjective} 筆`,
    "",
    "**層3 — 訓練計畫（需要時由 tool 載入）**",
    `　${plan}`,
    "",
    "**層4 — 對話摘要（每次帶入）**",
    `　${summary}`,
    "",
    "**層5 — 對話視窗（每次帶入）**",
    `　${convBar} ${s.conversationCount} 筆（超過 ${s.conversationMax} 筆時壓縮）`,
  ].join("\n");
}
