"""Agent Loop — 組合 context、呼叫 Claude API、回傳回應.

Phase 1：無 tool call，純對話。
Phase 2+ 補充 tool call 迴圈。
"""
import asyncio
import logging

import anthropic

import config
import memory.db as db
import memory.context_manager as ctx

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


async def run(user_message: str) -> str:
    """接收使用者訊息，回傳 Claude 的文字回應."""
    # 儲存使用者訊息
    db.append_conversation("user", user_message)

    # 非同步觸發壓縮（不阻塞主流程）
    if ctx.should_compress():
        asyncio.create_task(_compress())

    # 取得完整 context
    context = ctx.get_context_for_api()

    # 呼叫 Claude API（同步 SDK 在 executor 中執行，避免阻塞 event loop）
    loop = asyncio.get_event_loop()
    response_text = await loop.run_in_executor(None, _call_claude, context)

    # 儲存 assistant 回應
    db.append_conversation("assistant", response_text)

    return response_text


def _call_claude(context: dict) -> str:
    try:
        response = _client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1024,
            system=context["system"],
            messages=context["messages"],
        )
        return response.content[0].text
    except Exception as e:
        logger.error("Claude API error: %s", e)
        raise


async def _compress() -> None:
    """對話壓縮：將超出保留數的舊對話壓縮成摘要."""
    try:
        to_compress = ctx.get_conversations_to_compress()
        if not to_compress:
            return

        conversation_text = "\n".join(
            f"{r['role'].upper()}: {r['content']}" for r in to_compress
        )
        prompt = (
            "以下是一段跑步教練與選手的對話紀錄，請壓縮成重點摘要，保留：\n"
            "1. 訓練決策（調整了什麼、為什麼）\n"
            "2. 重要發現（狀態異常、突破、傷病跡象）\n"
            "3. 選手當時的狀態描述\n\n"
            "請用繁體中文，條列式輸出，精簡為 200 字以內。\n\n"
            f"對話紀錄：\n{conversation_text}"
        )

        loop = asyncio.get_event_loop()
        summary = await loop.run_in_executor(None, _summarize, prompt)

        max_id = to_compress[-1]["id"]
        ctx.apply_compression(summary, max_id)
        logger.info("Compressed %d conversations up to id=%d", len(to_compress), max_id)
    except Exception as e:
        logger.warning("Compression failed (will retry next round): %s", e)


def _summarize(prompt: str) -> str:
    response = _client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=512,
        messages=[{"role": "user", "content": prompt}],
    )
    return response.content[0].text
