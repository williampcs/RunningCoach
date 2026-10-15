/**
 * 對話壓縮 — 將超出 rolling window 的舊對話壓縮成摘要，保留重要訓練決策與選手狀態.
 * 由 Coach 在背景觸發，不阻塞主回應流程。
 */
import type { ContextManager } from "./context";
import type { Db } from "./db";
import type { Llm } from "./llm";
import type { Logger } from "./types";

const OUTPUT_FORMAT = `輸出格式（每區塊 1-3 點，總計 300 字以內，繁體中文）：
【訓練狀態】近期訓練概況、體能水平
【重要決策】調整了什麼、原因為何
【待追蹤】傷病、目標、未完成事項`;

// 第一次壓縮（無前次摘要）
const initialPrompt = (conversationText: string) => `你是跑步教練的助手，負責維護選手的訓練記錄。
請將以下對話整理成結構化的選手狀態摘要，用自己的話重新表達，不要保留對話原文。

${OUTPUT_FORMAT}

對話紀錄：
${conversationText}`;

// 後續壓縮（有前次摘要，融入更新）
const updatePrompt = (previousSummary: string, conversationText: string) => `你是跑步教練的助手，負責維護選手的訓練記錄。
請將【新增對話】的重要資訊融入【現有摘要】，輸出更新後的完整摘要。
若新舊資訊有衝突，以新資訊為準；已過時或不再相關的舊資訊可刪除。

【現有摘要】
${previousSummary}

【新增對話】
${conversationText}

${OUTPUT_FORMAT}`;

/** 壓縮舊對話；失敗時僅記錄 warning（原對話保留，下一輪重試） */
export async function compressConversations(deps: {
  db: Db;
  context: ContextManager;
  llm: Llm;
  logger: Logger;
}): Promise<void> {
  const { db, context, llm, logger } = deps;
  try {
    const toCompress = await context.getConversationsToCompress();
    const last = toCompress.at(-1);
    if (!last) return;

    const conversationText = toCompress.map((r) => `${r.role.toUpperCase()}: ${r.content}`).join("\n");
    const previous = await db.getLatestSummary();
    const prompt = previous
      ? updatePrompt(previous.content, conversationText)
      : initialPrompt(conversationText);

    const summary = (await llm.complete("compress", prompt, 2000)).text;
    await db.applyCompression(summary, last.id);
    logger.info(`Compressed ${toCompress.length} conversations (up to id=${last.id})`);
  } catch (e) {
    logger.warn(`Compression failed, will retry next round: ${e instanceof Error ? e.message : String(e)}`);
  }
}
