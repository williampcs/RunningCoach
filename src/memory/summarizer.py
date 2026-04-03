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

_COMPRESS_PROMPT_TEMPLATE = (
    "以下是一段跑步教練與選手的對話紀錄，請壓縮成重點摘要，保留：\n"
    "1. 訓練決策（調整了什麼、為什麼）\n"
    "2. 重要發現（狀態異常、突破、傷病跡象）\n"
    "3. 選手當時的狀態描述\n\n"
    "請用繁體中文，條列式輸出，精簡為 200 字以內。\n\n"
    "對話紀錄：\n{conversation_text}"
)


def _do_summarize(client: anthropic.Anthropic, conversation_text: str) -> str:
    prompt = _COMPRESS_PROMPT_TEMPLATE.format(conversation_text=conversation_text)
    response = client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
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

        loop = asyncio.get_event_loop()
        summary_text = await loop.run_in_executor(
            None, _do_summarize, client, conversation_text
        )

        max_id = to_compress[-1]["id"]
        ctx.apply_compression(summary_text, max_id)
        logger.info(
            "Compressed %d conversations (up to id=%d)", len(to_compress), max_id
        )
    except Exception as e:
        logger.warning("Compression failed, will retry next round: %s", e)
