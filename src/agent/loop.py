"""Agent Loop — 組合 context、呼叫 Claude API、執行 tool call 迴圈、回傳回應."""
import asyncio
import logging
from dataclasses import dataclass
from datetime import date

import anthropic

import config
import memory.db as db
import memory.context_manager as ctx
import memory.summarizer as summarizer
from tools.intervals_tool import intervals

logger = logging.getLogger(__name__)

_client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY)

# 跑後回報流程中，暫存最近一次取回的跑步活動（per-process singleton）
_activity_cache: dict | None = None


@dataclass
class UsageStats:
    """單次對話的 Token 用量統計（主對話 loop，不含非同步壓縮）."""
    layer_chars: dict        # 各層字元數，用於比例估算
    user_msg_chars: int      # 使用者訊息字元數
    initial_input_tokens: int   # 第一輪 API call 的 input tokens（代表 context 大小）
    total_output_tokens: int    # 所有輪次 output tokens 加總
    tool_rounds: int            # 觸發 tool call 的輪次數
    tool_input_overhead: int    # tool call 累積增加的額外 input tokens


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
            "更新選手固定資料（目標、PB、傷病、生理數據、訓練偏好等）。"
            "使用者提供或更新個人資料、PB 有新紀錄、或提到生理數據與訓練偏好時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": (
                        "資料欄位名稱，可用值：\n"
                        "・核心：goal_long_term、weekly_km_target、injuries\n"
                        "・PB：pb_5k、pb_10k、pb_half、pb_full\n"
                        "・生理：gender、birth_year、height_cm、weight_kg、"
                        "body_fat_pct、max_hr、resting_hr\n"
                        "・訓練偏好：pref_long_run_day、pref_rest_days、pref_train_time"
                    ),
                },
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
    # ── Phase 3 tools ──────────────────────────────────────────────────────────
    {
        "name": "fetch_latest_activity",
        "description": (
            "從 Intervals.icu 拉取最新一筆跑步活動（基本資料，不含 laps/streams）。"
            "偵測到跑後回報意圖時呼叫，用於驗證日期是否為今天。"
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "save_workout",
        "description": (
            "合併客觀活動資料（來自 fetch_latest_activity 的快取）"
            "與使用者輸入的主觀感受，存入 workouts table 並生成 AI 分析摘要。"
            "須在 fetch_latest_activity 確認日期為今天後才呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "perceived_effort": {
                    "type": "integer",
                    "description": "體感強度 1-10",
                },
                "subjective_notes": {
                    "type": "string",
                    "description": "主觀感受，例：腿有點重，呼吸順，右膝無異狀",
                },
            },
            "required": ["perceived_effort"],
        },
    },
    {
        "name": "save_pending_subjective",
        "description": (
            "將主觀感受暫存至 pending_subjective table。"
            "當手錶活動尚未同步至 Intervals.icu 時呼叫，使用者之後執行 /sync 時自動合併。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "date": {
                    "type": "string",
                    "description": "跑步日期 YYYY-MM-DD，通常是今天",
                },
                "perceived_effort": {"type": "integer", "description": "體感強度 1-10"},
                "subjective_notes": {"type": "string", "description": "主觀感受"},
            },
            "required": ["date", "perceived_effort"],
        },
    },
    {
        "name": "get_recent_workouts",
        "description": (
            "取得最近 N 天的訓練紀錄，包含客觀數據、主觀感受與 AI 分析摘要。"
            "以下情況應主動呼叫：進行跑後分析（save_workout 後）、討論訓練狀態或疲勞、"
            "制定或調整訓練計畫、使用者詢問過去訓練表現。"
            "賽事管理、個人資料更新、一般閒聊等不需要呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "days": {"type": "integer", "description": "查詢天數，預設 14"},
            },
            "required": [],
        },
    },
    {
        "name": "get_pace_trend",
        "description": (
            "計算過去 N 週的週平均配速，用於趨勢分析。"
            "使用者詢問「配速有沒有進步」時呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "weeks": {"type": "integer", "description": "查詢週數，預設 4"},
            },
            "required": [],
        },
    },
    {
        "name": "get_training_plan",
        "description": (
            "取得目前啟用中的訓練計畫內容。"
            "以下情況應主動呼叫：制定、調整或審視訓練計畫；確認本週訓練安排；"
            "將跑後表現與計畫目標對比時。賽事管理、閒聊等不需要呼叫。"
        ),
        "input_schema": {
            "type": "object",
            "properties": {},
            "required": [],
        },
    },
    # ── Phase 2 tools (races & profile) ────────────────────────────────────────
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

def generate_workout_summary(workout_data: dict) -> str:
    """生成 AI 跑步分析摘要（可供 /sync 流程呼叫）."""
    has_subjective = workout_data.get("perceived_effort") is not None
    effort_line = (
        f"體感強度：{workout_data['perceived_effort']}/10\n"
        f"主觀感受：{workout_data.get('subjective_notes') or '未記錄'}"
        if has_subjective else "體感資料：未記錄"
    )
    prompt = (
        f"請為以下跑步訓練生成一段簡潔分析摘要（150字以內，繁體中文）：\n\n"
        f"日期：{workout_data['date']}\n"
        f"距離：{workout_data.get('distance_km')}km\n"
        f"時長：{workout_data.get('duration_min')}分鐘\n"
        f"配速：{workout_data.get('avg_pace') or '未知'}\n"
        f"平均心率：{workout_data.get('avg_hr') or '未記錄'}bpm\n"
        f"最高心率：{workout_data.get('max_hr') or '未記錄'}bpm\n"
        f"爬升：{workout_data.get('elevation_m') or 0}m\n"
        f"{effort_line}\n\n"
        f"格式：一行數據摘要 ＋ AI評估。"
        f"{'客觀數據與體感對比分析。' if has_subjective else '僅客觀數據，給出客觀評估。'}"
    )
    response = _client.messages.create(
        model=config.CLAUDE_MODEL,
        max_tokens=300,
        messages=[{"role": "user", "content": prompt}],
    )
    logger.info(
        "workout_summary tokens — input: %d, output: %d",
        response.usage.input_tokens, response.usage.output_tokens,
    )
    return response.content[0].text


def _execute_tool(name: str, inputs: dict) -> str:
    global _activity_cache
    try:
        # ── Phase 3 tools ────────────────────────────────────────────────────
        if name in ("fetch_latest_activity", "fetch_latest_strava_activity"):
            activity = intervals.fetch_latest_activity()
            if activity is None:
                return "Intervals.icu 上找不到跑步活動，請確認手錶已同步且 API Key 設定正確。"
            _activity_cache = activity
            today = date.today().isoformat()
            is_today = activity["date"] == today
            date_note = "✅ 是今天的活動" if is_today else f"⚠️ 活動日期為 {activity['date']}，非今天，手錶資料可能尚未同步至 Intervals.icu"
            load_note = f"｜負荷(Load)：{activity['training_load']}" if activity.get("training_load") is not None else ""
            return (
                f"最新跑步活動：\n"
                f"日期：{activity['date']}　{date_note}\n"
                f"距離：{activity['distance_km']}km｜時長：{activity['duration_min']}分鐘\n"
                f"配速：{activity.get('avg_pace') or '未知'}｜"
                f"心率：{activity.get('avg_hr') or '未記錄'}/{activity.get('max_hr') or '未記錄'}bpm\n"
                f"爬升：{activity.get('elevation_m') or 0}m｜卡路里：{activity.get('calories') or '未記錄'}{load_note}"
            )

        elif name == "save_workout":
            if not _activity_cache:
                return "錯誤：請先呼叫 fetch_latest_activity 取得活動資料。"
            perceived_effort = inputs.get("perceived_effort")
            subjective_notes = inputs.get("subjective_notes", "")
            workout_data = {**_activity_cache,
                            "perceived_effort": perceived_effort,
                            "subjective_notes": subjective_notes}
            workout_id = db.save_workout(
                activity_data=_activity_cache,
                perceived_effort=perceived_effort,
                subjective_notes=subjective_notes or None,
            )
            summary = generate_workout_summary(workout_data)
            db.save_workout_summary(workout_id, summary)
            _activity_cache = None  # 清除快取
            return f"訓練紀錄已儲存（id={workout_id}）。\n\n{summary}"

        elif name == "save_pending_subjective":
            db.save_pending_subjective(
                date=inputs["date"],
                perceived_effort=int(inputs["perceived_effort"]),
                subjective_notes=inputs.get("subjective_notes", ""),
            )
            return f"主觀感受已暫存（{inputs['date']}）。手錶同步至 Intervals.icu 後請執行 /sync 完成合併。"

        elif name == "get_recent_workouts":
            days = int(inputs.get("days", 14))
            workouts = db.get_recent_workouts_raw(days)
            if not workouts:
                return f"最近 {days} 天無訓練紀錄。"
            summaries = db.get_recent_workout_summaries(len(workouts) + 2)
            summary_by_date = {s["date"]: s["summary"] for s in summaries}
            lines = [f"最近 {days} 天的訓練紀錄（共 {len(workouts)} 筆）："]
            for w in workouts:
                subj = f"｜體感 {w['perceived_effort']}/10" if w.get("perceived_effort") else ""
                lines.append(
                    f"\n【{w['date']}】{w['distance_km']}km｜{w.get('avg_pace','?')}｜"
                    f"心率 {w.get('avg_hr','?')}/{w.get('max_hr','?')}bpm{subj}"
                )
                if ai_summary := summary_by_date.get(w["date"]):
                    lines.append(f"  AI摘要：{ai_summary}")
            return "\n".join(lines)

        elif name == "get_pace_trend":
            weeks = int(inputs.get("weeks", 4))
            records = db.get_workouts_for_pace_trend(weeks)
            if not records:
                return f"最近 {weeks} 週無配速資料。"
            # 依 ISO week 分組計算平均配速
            from datetime import datetime
            weekly: dict[str, list[int]] = {}
            for r in records:
                try:
                    dt = datetime.strptime(r["date"], "%Y-%m-%d")
                    week_key = dt.strftime("%G-W%V")
                    pace_str = r["avg_pace"].split("/")[0]
                    mins, secs = pace_str.split(":")
                    secs_total = int(mins) * 60 + int(secs)
                    weekly.setdefault(week_key, []).append(secs_total)
                except Exception:
                    continue
            lines = [f"過去 {weeks} 週週平均配速："]
            for week in sorted(weekly):
                avg = sum(weekly[week]) // len(weekly[week])
                lines.append(f"  {week}：{avg // 60}:{avg % 60:02d}/km（{len(weekly[week])} 筆）")
            return "\n".join(lines)

        elif name == "get_training_plan":
            plan = db.get_active_training_plan()
            if not plan:
                return "目前沒有啟用中的訓練計畫。"
            return f"當前訓練計畫（{plan['week_label']}）：\n\n{plan['content']}"

        # ── Phase 2 tools ────────────────────────────────────────────────────
        elif name == "add_race":
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

def _call_claude_with_tools(context: dict) -> tuple[str, UsageStats]:
    messages = list(context["messages"])
    layer_chars = context.get("layer_chars", {})
    user_msg_chars = context.get("user_msg_chars", 0)

    initial_input_tokens = 0
    total_output_tokens = 0
    last_input_tokens = 0
    tool_rounds = 0

    for round_num in range(config.TOOL_CALL_MAX_ROUNDS):
        response = _client.messages.create(
            model=config.CLAUDE_MODEL,
            max_tokens=config.MAX_RESPONSE_TOKENS,
            system=context["system"],
            messages=messages,
            tools=_TOOLS,
        )

        if round_num == 0:
            initial_input_tokens = response.usage.input_tokens
        last_input_tokens = response.usage.input_tokens
        total_output_tokens += response.usage.output_tokens

        # 沒有 tool call，直接回傳文字
        if response.stop_reason != "tool_use":
            stats = UsageStats(
                layer_chars=layer_chars,
                user_msg_chars=user_msg_chars,
                initial_input_tokens=initial_input_tokens,
                total_output_tokens=total_output_tokens,
                tool_rounds=tool_rounds,
                tool_input_overhead=last_input_tokens - initial_input_tokens,
            )
            logger.info(
                "chat tokens — input: %d, output: %d, tool_rounds: %d",
                initial_input_tokens, total_output_tokens, tool_rounds,
            )
            return _extract_text(response), stats

        # 執行所有 tool call
        tool_rounds += 1
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
        max_tokens=config.MAX_RESPONSE_TOKENS,
        system=context["system"],
        messages=messages,
    )
    total_output_tokens += final.usage.output_tokens
    stats = UsageStats(
        layer_chars=layer_chars,
        user_msg_chars=user_msg_chars,
        initial_input_tokens=initial_input_tokens,
        total_output_tokens=total_output_tokens,
        tool_rounds=tool_rounds,
        tool_input_overhead=final.usage.input_tokens - initial_input_tokens,
    )
    logger.info(
        "chat tokens — input: %d, output: %d, tool_rounds: %d (max reached)",
        initial_input_tokens, total_output_tokens, tool_rounds,
    )
    return _extract_text(final), stats


def _extract_text(response) -> str:
    parts = [block.text for block in response.content if hasattr(block, "text")]
    return "\n".join(parts) if parts else ""


# ---------------------------------------------------------------------------
# 公開介面
# ---------------------------------------------------------------------------

async def run(user_message: str) -> tuple[str, UsageStats]:
    """接收使用者訊息，回傳 Claude 的文字回應與 token 用量統計。"""
    db.append_conversation("user", user_message)

    # 非同步觸發壓縮（不阻塞主流程）
    if ctx.should_compress():
        asyncio.create_task(summarizer.compress_async(_client))

    context = ctx.get_context_for_api()
    context["user_msg_chars"] = len(user_message)

    event_loop = asyncio.get_event_loop()
    try:
        response_text, stats = await event_loop.run_in_executor(
            None, _call_claude_with_tools, context
        )
    except Exception as e:
        logger.error("Claude API error: %s", e)
        raise

    db.append_conversation("assistant", response_text)
    return response_text, stats
