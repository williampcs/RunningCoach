"""LLM 呼叫層 — 專案中唯一直接使用 anthropic SDK 的模組.

對外介面與供應商無關：
- complete(purpose, prompt, max_tokens)：單次生成（跑後摘要、對話壓縮）
- run_with_tools(system, messages, tools, execute_tool)：帶工具的多輪對話（主對話）
- Usage / Result：用量統計（逐輪累加）與回傳結果

呼叫端只提供 system 字串、純文字對話歷史（role/content）、JSON Schema 格式的工具定義
（name / description / input_schema），以及執行工具的 callback。
快取、思考等 Claude 特有設定屬於本模組的實作細節。
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


def _extract_text(response) -> str:
    parts = [block.text for block in response.content if block.type == "text"]
    return "\n".join(parts)


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
    """單次生成（無工具、無 system prompt）."""
    usage = Usage()
    response = _client.messages.create(
        model=_MODELS[purpose],
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": prompt}],
    )
    usage.add(response.usage)
    _log_usage(purpose, usage)
    return Result(_extract_text(response), usage)


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
    messages = list(messages)
    usage = Usage()

    for _ in range(config.TOOL_CALL_MAX_ROUNDS):
        response = _client.messages.create(
            model=model,
            max_tokens=config.MAX_RESPONSE_TOKENS,
            system=system,
            messages=messages,
            tools=tools,
        )
        usage.add(response.usage)

        if response.stop_reason != "tool_use":
            _log_usage("chat", usage)
            return Result(_extract_text(response), usage)

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

        # 本輪 assistant 訊息原封不動加回（含 tool_use 區塊），接著附上 tool results
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
    )
    usage.add(final.usage)
    _log_usage("chat", usage)
    return Result(_extract_text(final), usage)
