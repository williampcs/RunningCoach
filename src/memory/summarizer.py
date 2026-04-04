"""對話壓縮模組.

負責將超出 rolling window 的舊對話壓縮成摘要，保留重要訓練決策與選手狀態。
由 agent/loop.py 非同步呼叫，不阻塞主回應流程。
"""
import asyncio
import logging

import anthropic

import config
import memory.db as db
import memory.context_manager as ctx

logger = logging.getLogger(__name__)

# 第一次壓縮（無前次摘要）
_INITIAL_PROMPT = """\
你是跑步教練的助手，負責維護選手的訓練記錄。
請將以下對話整理成結構化的選手狀態摘要，用自己的話重新表達，不要保留對話原文。

輸出格式（每區塊 1-3 點，總計 300 字以內，繁體中文）：
【訓練狀態】近期訓練概況、體能水平
【重要決策】調整了什麼、原因為何
【待追蹤】傷病、目標、未完成事項

對話紀錄：
{conversation_text}\
"""

# 後續壓縮（有前次摘要，融入更新）
_UPDATE_PROMPT = """\
你是跑步教練的助手，負責維護選手的訓練記錄。
請將【新增對話】的重要資訊融入【現有摘要】，輸出更新後的完整摘要。
若新舊資訊有衝突，以新資訊為準；已過時或不再相關的舊資訊可刪除。

【現有摘要】
{previous_summary}

【新增對話】
{conversation_text}

輸出格式（每區塊 1-3 點，總計 300 字以內，繁體中文）：
【訓練狀態】近期訓練概況、體能水平
【重要決策】調整了什麼、原因為何
【待追蹤】傷病、目標、未完成事項\
"""


def _do_summarize(
    client: anthropic.Anthropic,
    conversation_text: str,
    previous_summary: str | None,
) -> str:
    if previous_summary:
        prompt = _UPDATE_PROMPT.format(
            previous_summary=previous_summary,
            conversation_text=conversation_text,
        )
    else:
        prompt = _INITIAL_PROMPT.format(conversation_text=conversation_text)

    response = client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    logger.info(
        "compression tokens — input: %d, output: %d",
        response.usage.input_tokens, response.usage.output_tokens,
    )
    return response.content[0].text


async def compress_async(client: anthropic.Anthropic) -> None:
    """非同步壓縮舊對話，失敗時僅記錄 warning，不中斷主流程."""
    try:
        to_compress = ctx.get_conversations_to_compress()
        if not to_compress:
            return

        conversation_text = "\n".join(
            f"{r['role'].upper()}: {r['content']}" for r in to_compress
        )

        prev = db.get_latest_summary()
        previous_summary = prev["content"] if prev else None

        event_loop = asyncio.get_event_loop()
        summary_text = await event_loop.run_in_executor(
            None, _do_summarize, client, conversation_text, previous_summary
        )

        max_id = to_compress[-1]["id"]
        ctx.apply_compression(summary_text, max_id)
        logger.info(
            "Compressed %d conversations (up to id=%d)", len(to_compress), max_id
        )
    except Exception as e:
        logger.warning("Compression failed, will retry next round: %s", e)
