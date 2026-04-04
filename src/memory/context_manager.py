"""Context Manager — 組合五層 Context 送入 Claude API.

層1 — System Prompt（日期時區 + 選手資料 + 動態注入近期賽事）
層2 — 訓練歷史摘要（最近 N 筆 workout_summaries）
層3 — 當前訓練計畫（training_plans 最新一筆）
層4 — 對話摘要（summaries 最新一筆，對話壓縮後產生）
層5 — Rolling Window（conversations 最近 N 輪）
"""
from datetime import date, datetime
from zoneinfo import ZoneInfo

import config
import memory.db as db

_TZ = ZoneInfo("Asia/Taipei")
_WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"]


# ---------------------------------------------------------------------------
# 層1：System Prompt
# ---------------------------------------------------------------------------

def _build_system_prompt() -> str:
    # 動態時間資訊
    now = datetime.now(_TZ)
    weekday_str = _WEEKDAYS[now.weekday()]  # Monday=0 … Sunday=6
    date_line = (
        f"今天日期：{now.strftime('%Y-%m-%d')}（{weekday_str}）"
        f"｜時區：Asia/Taipei（UTC+8）｜以星期日為一週的第一天"
    )

    profile = db.get_profile()
    lines = [date_line, "", "你是一位專業跑步教練，以下是選手資料：", ""]

    if goal := profile.get("goal_long_term"):
        lines.append(f"長期目標：{goal}")

    pbs = []
    for key, label in [("pb_5k", "5km"), ("pb_10k", "10km"), ("pb_half", "半馬"), ("pb_full", "全馬")]:
        if key in profile:
            pbs.append(f"{label} {profile[key]}")
    if pbs:
        lines.append(f"個人最佳：{' / '.join(pbs)}")

    if injuries := profile.get("injuries"):
        lines.append(f"傷病注意：{injuries}")

    if weekly_km := profile.get("weekly_km_target"):
        lines.append(f"每週目標里程：{weekly_km}km")

    # 動態注入近期賽事（距今 N 天內）
    races = db.get_upcoming_races(config.RACE_LOOKAHEAD_DAYS)
    if races:
        lines.append("")
        lines.append("近期目標賽事：")
        today = date.today()
        for r in races:
            race_date = date.fromisoformat(r["date"])
            days_away = (race_date - today).days
            status = "已確認報名" if r["confirmed"] else "考慮中"
            target = f"｜目標 {r['target_time']}" if r.get("target_time") else "｜目標完賽"
            lines.append(
                f"- [{r['id']}] {r['date']} {r['name']} {r['distance_km']}km"
                f"{target}｜距今 {days_away} 天（{status}）"
            )

    lines += [
        "",
        "請根據選手資料給予個人化的跑步訓練建議。回應使用繁體中文。",
        "",
        "【訓練歷史載入時機】",
        "以下情況請主動呼叫 get_recent_workouts 取得訓練歷史與分析摘要：",
        "・進行跑後回饋分析（save_workout 後）",
        "・討論訓練狀態、疲勞程度、體能趨勢",
        "・制定或調整訓練計畫",
        "・使用者詢問過去訓練內容或表現",
        "一般閒聊、賽事管理、個人資料更新等情況不需要呼叫。",
        "",
        "【跑後回報偵測】",
        "當使用者訊息符合以下任一條件，視為跑後回報，應主動呼叫 fetch_latest_strava_activity：",
        "・出現「跑完」「剛跑」「今天跑」「跑步完」等關鍵詞",
        "・出現體感數字，例如「7/10」「體感7」「RPE 8」",
        "・出現身體感受描述，例如「腿重」「呼吸」「心率」「膝蓋」「腳踝」等部位",
        "取得 Strava 資料後：",
        "・若活動日期 = 今天 → 呼叫 save_workout 合併主客觀資料並生成分析",
        "・若活動日期 ≠ 今天（Strava 尚未同步）→ 呼叫 save_pending_subjective 暫存主觀感受，"
        "並告知使用者 Strava 同步後輸入 /sync 完成合併",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# 組合五層 Context
# ---------------------------------------------------------------------------

def _truncate_msg(content: str) -> str:
    """若訊息超過單則字元上限，截斷並附上標記。"""
    limit = config.CONVERSATION_MSG_MAX_CHARS
    if len(content) <= limit:
        return content
    return content[:limit] + f"…（訊息過長，已截短至 {limit} 字）"


def get_context_for_api() -> dict:
    """回傳可直接傳入 Claude API 的 context dict，附帶各層字元數供 token 用量估算。

    層2（訓練摘要）已移除，改由 get_recent_workouts tool 按需載入。
    """
    system = _build_system_prompt()
    messages = []
    layer_chars: dict[str, int] = {
        "layer1": len(system),
        "layer3": 0,
        "layer4": 0,
        "layer5": 0,
    }

    # 層3 — 當前訓練計畫
    plan = db.get_active_training_plan()
    if plan:
        content = f"當前訓練計畫（{plan['week_label']}）：\n\n{plan['content']}"
        layer_chars["layer3"] = len(content)
        messages.append({"role": "user", "content": content})
        messages.append({"role": "assistant", "content": "已閱讀當前訓練計畫，我會依此規劃建議。"})

    # 層4 — 對話摘要（壓縮後的歷史重點）
    summary = db.get_latest_summary()
    if summary:
        content = f"以下是之前對話的重點摘要：\n\n{summary['content']}"
        layer_chars["layer4"] = len(content)
        messages.append({"role": "user", "content": content})
        messages.append({"role": "assistant", "content": "已閱讀對話摘要，我會記住這些重要資訊。"})

    # 層5 — Rolling Window（最近 N 輪原始對話，單則超長訊息截斷）
    recent = db.get_recent_conversations(config.CONVERSATION_KEEP)
    truncated = [
        {"role": r["role"], "content": _truncate_msg(r["content"])}
        for r in recent
    ]
    layer_chars["layer5"] = sum(len(r["content"]) for r in truncated)
    messages += truncated

    return {"system": system, "messages": messages, "layer_chars": layer_chars}


# ---------------------------------------------------------------------------
# 壓縮相關
# ---------------------------------------------------------------------------

def should_compress() -> bool:
    return db.count_conversations() > config.CONVERSATION_MAX


def get_conversations_to_compress() -> list[dict]:
    """回傳應被壓縮的舊對話（最舊的 total - KEEP 筆）."""
    total = db.count_conversations()
    compress_count = total - config.CONVERSATION_KEEP
    if compress_count <= 0:
        return []
    return db.get_oldest_conversations(compress_count)


def apply_compression(summary_text: str, covers_up_to_id: int) -> None:
    db.save_summary(summary_text, covers_up_to_id)
    db.delete_conversations_up_to(covers_up_to_id)


# ---------------------------------------------------------------------------
# Status（供 /status 指令使用）
# ---------------------------------------------------------------------------

def get_status_summary() -> dict:
    """回傳各記憶層的狀態摘要."""
    workout_summaries = db.get_recent_workout_summaries(config.WORKOUT_SUMMARY_COUNT)
    plan = db.get_active_training_plan()
    summary = db.get_latest_summary()
    conv_count = db.count_conversations()
    races = db.get_upcoming_races(config.RACE_LOOKAHEAD_DAYS)
    profile = db.get_profile()

    return {
        "profile_keys": len(profile),
        "upcoming_races": len(races),
        "workout_summaries": len(workout_summaries),
        "has_training_plan": plan is not None,
        "training_plan_label": plan["week_label"] if plan else None,
        "has_conv_summary": summary is not None,
        "conversation_count": conv_count,
        "conversation_max": config.CONVERSATION_MAX,
    }
