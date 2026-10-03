"""LLM 呼叫層 — 專案中唯一直接使用 anthropic SDK 的模組.

對外介面與供應商無關：
- complete(purpose, prompt, max_tokens)：單次生成（跑後摘要、對話壓縮）
- run_with_tools(system, messages, tools, execute_tool)：帶工具的多輪對話（主對話）
- Usage / Result：用量統計（逐輪累加）與回傳結果

呼叫端只提供 system 字串、純文字對話歷史（role/content）、JSON Schema 格式的工具定義
（name / description / input_schema），以及執行工具的 callback。
快取、思考強度（effort）、拒絕回答等 Claude 特有行為由本模組處理，
呼叫端只會看到 Result.finish（ok / refused / truncated）或 LLMError。
"""
import logging
from dataclasses import dataclass
from typing import Callable

import anthropic

import config

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

# 用途 → 模型
_MODELS: dict[str, str] = {
    "chat":     config.CLAUDE_MODEL,
    "summary":  config.CLAUDE_MODEL_SUMMARY,
    "compress": config.CLAUDE_MODEL_COMPRESS,
}

# 不支援 output_config.effort 的模型（送出會回 400）
_NO_EFFORT_PREFIXES = ("claude-sonnet-4-5", "claude-haiku-4-5")

# 單次生成（摘要、壓縮）屬於簡單的內容生成，固定用最低強度
_COMPLETE_EFFORT = "low"


class LLMError(RuntimeError):
    """模型未產生可用內容（拒絕回答，或輸出在產生文字前就被截斷）."""


@dataclass
class Usage:
    """單次任務的 token 用量（含多輪 API 呼叫，逐輪累加）."""
    first_input_tokens: int = 0   # 第一輪完整輸入（代表 context 大小，供分層估算）
    input_tokens: int = 0         # 累計未快取輸入
    cache_read_tokens: int = 0    # 累計快取讀取
    cache_write_tokens: int = 0   # 累計快取寫入
    output_tokens: int = 0        # 累計輸出
    api_calls: int = 0
    tool_rounds: int = 0

    @property
    def total_input_tokens(self) -> int:
        """實際計費的輸入總量（未快取 + 快取讀取 + 快取寫入）."""
        return self.input_tokens + self.cache_read_tokens + self.cache_write_tokens

    def add(self, api_usage) -> None:
        # 舊版 SDK 可能沒有快取欄位，或值為 None
        cache_read = getattr(api_usage, "cache_read_input_tokens", None) or 0
        cache_write = getattr(api_usage, "cache_creation_input_tokens", None) or 0
        if self.api_calls == 0:
            self.first_input_tokens = api_usage.input_tokens + cache_read + cache_write
        self.input_tokens += api_usage.input_tokens
        self.cache_read_tokens += cache_read
        self.cache_write_tokens += cache_write
        self.output_tokens += api_usage.output_tokens
        self.api_calls += 1


@dataclass
class Result:
    text: str
    usage: Usage
    finish: str = "ok"   # ok / refused（模型拒絕回答）/ truncated（達輸出上限被截斷）


def _model_options(model: str, effort: str) -> dict:
    """依模型組出額外的 request 參數.

    Sonnet 5.5 等新模型預設開啟思考，思考深度以 effort 控制；
    Sonnet 4.5 / Haiku 4.5 沒有 effort 參數，送出會被拒絕，因此略過。
    """
    if model.startswith(_NO_EFFORT_PREFIXES):
        return {}
    return {"output_config": {"effort": effort}}


def _extract_text(response) -> str:
    # 回應可能以 thinking 區塊開頭，依 type 取文字而非依位置
    parts = [block.text for block in response.content if block.type == "text"]
    return "\n".join(parts)


def _finish(response, purpose: str) -> str:
    if response.stop_reason == "refusal":
        details = getattr(response, "stop_details", None)
        logger.warning("%s refused — category: %s", purpose, getattr(details, "category", None))
        return "refused"
    if response.stop_reason == "max_tokens":
        logger.warning("%s hit max_tokens — output truncated", purpose)
        return "truncated"
    return "ok"


def _log_usage(purpose: str, usage: Usage) -> None:
    logger.info(
        "%s tokens — input: %d (cache read %d, write %d), output: %d, calls: %d, tool_rounds: %d",
        purpose, usage.total_input_tokens, usage.cache_read_tokens, usage.cache_write_tokens,
        usage.output_tokens, usage.api_calls, usage.tool_rounds,
    )


# ---------------------------------------------------------------------------
# 公開介面
# ---------------------------------------------------------------------------

def complete(purpose: str, prompt: str, max_tokens: int) -> Result:
    """單次生成（無工具、無 system prompt）.

    max_tokens 是含思考的總輸出上限，內容長度應由 prompt 控制。
    模型拒絕回答或沒有產生任何文字時 raise LLMError，避免呼叫端把空字串當成結果存檔。
    """
    model = _MODELS[purpose]
    usage = Usage()
    response = _client.messages.create(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
        **_model_options(model, _COMPLETE_EFFORT),
    )
    usage.add(response.usage)
    _log_usage(purpose, usage)

    finish = _finish(response, purpose)
    text = _extract_text(response)
    if finish == "refused" or not text.strip():
        raise LLMError(f"{purpose}: 模型未產生內容（stop_reason={response.stop_reason}）")
    return Result(text, usage, finish)


def run_with_tools(
    system: str,
    messages: list[dict],
    tools: list[dict],
    execute_tool: Callable[[str, dict], str],
) -> Result:
    """帶工具的多輪對話：模型要求呼叫工具時以 execute_tool 執行，直到產生最終文字回應.

    最多 TOOL_CALL_MAX_ROUNDS 輪；超過時保留 tools 但禁止再呼叫（tool_choice none），
    取得最終回應。保留 tools 是因為對話中已有工具呼叫紀錄，且移除 tools 會讓快取失效。
    """
    model = _MODELS["chat"]
    options = _model_options(model, config.CLAUDE_CHAT_EFFORT)
    messages = list(messages)
    usage = Usage()

    for _ in range(config.TOOL_CALL_MAX_ROUNDS):
        response = _client.messages.create(
            model=model,
            max_tokens=config.MAX_RESPONSE_TOKENS,
            system=system,
            messages=messages,
            tools=tools,
            **options,
        )
        usage.add(response.usage)

        if response.stop_reason != "tool_use":
            _log_usage("chat", usage)
            return Result(_extract_text(response), usage, _finish(response, "chat"))

        # 執行所有 tool call
        usage.tool_rounds += 1
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = execute_tool(block.name, block.input)
                logger.info("Tool [%s] input=%s → %s", block.name, block.input, result[:120])
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

        # 本輪 assistant 訊息原封不動加回（含 thinking、tool_use 區塊），接著附上 tool results
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    logger.warning("Max tool call rounds (%d) reached", config.TOOL_CALL_MAX_ROUNDS)
    final = _client.messages.create(
        model=model,
        max_tokens=config.MAX_RESPONSE_TOKENS,
        system=system,
        messages=messages,
        tools=tools,
        tool_choice={"type": "none"},
        **options,
    )
    usage.add(final.usage)
    _log_usage("chat", usage)
    return Result(_extract_text(final), usage, _finish(final, "chat"))
