import { formatTokenFooter, TERMS_SHORT, type UsageStats } from "@running-coach/core";

export const DISCORD_MSG_LIMIT = 2000;

/** 將長訊息切割為不超過上限的分段，盡量在換行處切開 */
export function splitMessage(text: string, limit = DISCORD_MSG_LIMIT): string[] {
  const parts: string[] = [];
  while (text.length > limit) {
    let splitAt = text.lastIndexOf("\n", limit - 1);
    if (splitAt <= 0) splitAt = limit;
    parts.push(text.slice(0, splitAt));
    text = text.slice(splitAt).replace(/^\n+/, "");
  }
  if (text) parts.push(text);
  return parts;
}

/**
 * 回覆分段；回覆的依據（「參考了：…」）與 token 用量頁尾以 Discord 的小字語法附在最後一段，放不下時另起一段
 */
export function replyParts(reply: string, stats: UsageStats | null, sources: string[] = []): string[] {
  const parts = splitMessage(reply);
  const footer = stats ? formatTokenFooter(stats) : "";
  const notes = [sources.length ? `參考了：${sources.join("、")}` : "", footer].filter(Boolean);
  if (!notes.length) return parts;

  const line = notes.map((n) => `-# ${n}`).join("\n");
  const last = parts.pop() ?? "";
  if (last.length + 1 + line.length <= DISCORD_MSG_LIMIT) return [...parts, last ? `${last}\n${line}` : line];
  return [...parts, last, line];
}

/** `/help`：bot 的自我介紹、指令，最後是使用須知的精簡版與完整版的連結（規格 12.32） */
export function helpText(termsUrl: string): string {
  return [
    "我是 Zone2Mate 的 AI 跑步教練。在這個頻道直接傳訊息就是和我聊訓練，跑完也可以直接說“剛跑完 8K，體感 7”。",
    "",
    "指令：`/sync` 同步 Intervals.icu、`/plan` 更新本週計畫、`/profile` 設定選手資料、`/status` 版本與記憶的狀態、`/help` 這段說明。",
    "",
    `${TERMS_SHORT}使用須知：${termsUrl}`,
  ].join("\n");
}
