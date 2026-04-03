"""Agent Loop — 組合 context、呼叫 Claude API、執行 tool call 迴圈、回傳回應."""
import asyncio
import logging

import anthropic

import config
import memory.db as db
import memory.context_manager as ctx
import memory.summarizer as summarizer

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)


# ---------------------------------------------------------------------------
# Tool 定義（供 Claude API 呼叫）
# ---------------------------------------------------------------------------

_TOOLS: list[dict] = [
    {
        "name": "add_race",
        "description": (
            "新增目標賽事至 races table。"
            "使用者說「我報名了 OOO 比賽」或「幫我記下 OOO 賽事」時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name":        {"type": "string", "description": "賽事名稱，例：2026 萬金石馬拉松"},
                "date":        {"type": "string", "description": "比賽日期，ISO 格式 YYYY-MM-DD"},
                "distance_km": {"type": "number", "description": "距離（公里），例：21.1"},
                "target_time": {"type": "string", "description": "目標完賽時間，例：1:58:00。無具體目標時留空"},
                "confirmed":   {"type": "integer", "description": "1=已確認報名（預設），0=考慮中"},
                "notes":       {"type": "string", "description": "其他備注，例：山路賽，需練習爬坡"},
            },
            "required": ["name", "date", "distance_km"],
        },
    },
    {
        "name": "get_upcoming_races",
        "description": (
            "查詢距今 N 天內的賽事清單。"
            "使用者詢問「我最近有什麼比賽」或需要列出賽事時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": f"查詢範圍天數，預設 {config.RACE_LOOKAHEAD_DAYS}"},
            },
            "required": [],
        },
    },
    {
        "name": "update_race_result",
        "description": (
            "更新賽事實際完賽時間與備注。"
            "賽後使用者回報成績時呼叫，需先用 get_upcoming_races 確認 race_id。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "race_id":     {"type": "integer", "description": "races table 的 id"},
                "result_time": {"type": "string",  "description": "實際完賽時間，例：1:55:30"},
                "notes":       {"type": "string",  "description": "賽後備注，例：後半段配速不錯"},
            },
            "required": ["race_id", "result_time"],
        },
    },
    {
        "name": "update_athlete_profile",
        "description": (
            "更新選手固定資料（長期目標、PB、傷病等）。"
            "使用者明確說要更新個人資料，或 PB 有新紀錄時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key":   {"type": "string", "description": "資料欄位，例：goal_long_term、pb_half、injuries、weekly_km_target"},
                "value": {"type": "string", "description": "欄位值"},
            },
            "required": ["key", "value"],
        },
    },
    {
        "name": "save_training_plan",
        "description": (
            "儲存訓練計畫到 DB（會停用舊計畫）。"
            "制定或更新訓練計畫時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "week_label": {"type": "string", "description": "週標籤，例：2026-W14"},
                "content":    {"type": "string", "description": "訓練計畫完整內容"},
            },
            "required": ["week_label", "content"],
        },
    },
    {
        "name": "update_race",
        "description": (
            "修改已存在賽事的內容（名稱、日期、距離、目標時間、報名狀態、備注）。"
            "使用者說「把 OOO 目標改成 XXX」或「OOO 改期了」時呼叫。"
            "需先用 get_upcoming_races 確認 race_id。只需傳入要更新的欄位。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "race_id":     {"type": "integer", "description": "races table 的 id"},
                "name":        {"type": "string",  "description": "賽事名稱"},
                "date":        {"type": "string",  "description": "比賽日期 YYYY-MM-DD"},
                "distance_km": {"type": "number",  "description": "距離（公里）"},
                "target_time": {"type": "string",  "description": "目標完賽時間，例：1:55:00"},
                "confirmed":   {"type": "integer", "description": "1=已確認報名，0=考慮中"},
                "notes":       {"type": "string",  "description": "備注"},
            },
            "required": ["race_id"],
        },
    },
    {
        "name": "cancel_race",
        "description": (
            "將賽事標記為已取消（設定 cancelled=1，保留歷史紀錄，不刪除）。"
            "使用者說「我退出 OOO」或「取消報名 OOO」時呼叫。"
            "需先用 get_upcoming_races 確認 race_id。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "race_id": {"type": "integer", "description": "races table 的 id"},
                "notes":   {"type": "string",  "description": "取消原因（選填），例：傷病、時間衝突"},
            },
            "required": ["race_id"],
        },
    },
]


# ---------------------------------------------------------------------------
# Tool 執行器
# ---------------------------------------------------------------------------

def _execute_tool(name: str, inputs: dict) -> str:
    try:
        if name == "add_race":
            race_id = db.add_race(
                name=inputs["name"],
                date=inputs["date"],
                distance_km=float(inputs["distance_km"]),
                target_time=inputs.get("target_time", ""),
                confirmed=int(inputs.get("confirmed", 1)),
                notes=inputs.get("notes", ""),
            )
            return f"賽事已新增（id={race_id}）：{inputs['date']} {inputs['name']}"

        elif name == "get_upcoming_races":
            days = int(inputs.get("days", config.RACE_LOOKAHEAD_DAYS))
            races = db.get_upcoming_races(days)
            if not races:
                return f"未來 {days} 天內無已記錄賽事。"
            lines = [f"未來 {days} 天內的賽事（共 {len(races)} 筆）："]
            for r in races:
                target = r.get("target_time") or "完賽即可"
                result = f"｜實際成績：{r['result_time']}" if r.get("result_time") else ""
                lines.append(
                    f"- [id={r['id']}] {r['date']} {r['name']} "
                    f"{r['distance_km']}km 目標：{target}{result}"
                )
            return "\n".join(lines)

        elif name == "update_race_result":
            db.update_race_result(
                race_id=int(inputs["race_id"]),
                result_time=inputs["result_time"],
                notes=inputs.get("notes", ""),
            )
            return f"賽事 id={inputs['race_id']} 成績已更新：{inputs['result_time']}"

        elif name == "update_athlete_profile":
            db.set_profile_key(inputs["key"], inputs["value"])
            return f"選手資料已更新：{inputs['key']} = {inputs['value']}"

        elif name == "save_training_plan":
            db.save_training_plan(inputs["week_label"], inputs["content"])
            return f"訓練計畫已儲存（{inputs['week_label']}）"

        elif name == "update_race":
            race_id = int(inputs["race_id"])
            fields = {k: inputs[k] for k in
                      ("name", "date", "distance_km", "target_time", "confirmed", "notes")
                      if k in inputs}
            db.update_race(race_id, **fields)
            changed = "、".join(f"{k}={v}" for k, v in fields.items())
            return f"賽事 id={race_id} 已更新：{changed}"

        elif name == "cancel_race":
            race_id = int(inputs["race_id"])
            db.cancel_race(race_id, notes=inputs.get("notes", ""))
            return f"賽事 id={race_id} 已標記為取消，紀錄保留於 DB。"

        else:
            return f"未知的 tool：{name}"

    except Exception as e:
        logger.error("Tool execution error [%s]: %s", name, e)
        return f"執行失敗：{e}"


# ---------------------------------------------------------------------------
# Claude API 呼叫（含 tool call 迴圈）
# ---------------------------------------------------------------------------

def _call_claude_with_tools(context: dict) -> str:
    messages = list(context["messages"])

    for round_num in range(config.TOOL_CALL_MAX_ROUNDS):
        response = _client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=1024,
            system=context["system"],
            messages=messages,
            tools=_TOOLS,
        )

        # 沒有 tool call，直接回傳文字
        if response.stop_reason != "tool_use":
            return _extract_text(response)

        # 執行所有 tool call
        tool_results = []
        for block in response.content:
            if block.type == "tool_use":
                result = _execute_tool(block.name, block.input)
                logger.info("Tool [%s] input=%s → %s", block.name, block.input, result[:120])
                tool_results.append({
                    "type": "tool_result",
                    "tool_use_id": block.id,
                    "content": result,
                })

        # 把本輪 assistant 訊息與 tool results 加入 messages，繼續迴圈
        messages.append({"role": "assistant", "content": response.content})
        messages.append({"role": "user", "content": tool_results})

    # 超過最大輪數，不帶 tools 再問一次取最終回應
    logger.warning("Max tool call rounds (%d) reached", config.TOOL_CALL_MAX_ROUNDS)
    final = _client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=1024,
        system=context["system"],
        messages=messages,
    )
    return _extract_text(final)


def _extract_text(response) -> str:
    parts = [block.text for block in response.content if hasattr(block, "text")]
    return "\n".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# 公開介面
# ---------------------------------------------------------------------------

async def run(user_message: str) -> str:
    """接收使用者訊息，回傳 Claude 的文字回應."""
    db.append_conversation("user", user_message)

    # 非同步觸發壓縮（不阻塞主流程）
    if ctx.should_compress():
        asyncio.create_task(summarizer.compress_async(_client))

    context = ctx.get_context_for_api()

    loop = asyncio.get_event_loop()
    try:
        response_text = await loop.run_in_executor(None, _call_claude_with_tools, context)
    except Exception as e:
        logger.error("Claude API error: %s", e)
        raise

    db.append_conversation("assistant", response_text)
    return response_text
