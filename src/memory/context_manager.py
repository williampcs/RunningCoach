"""Context Manager — 組合五層 Context 送入 Claude API.

Phase 1 實作：
  層1 — System Prompt（選手資料 + 動態注入近期賽事）
  層5 — Rolling Window（最近 N 輪原始對話）

Phase 2 補完：
  層2 — workout_summaries
  層3 — training_plan
  層4 — 對話摘要
"""
from datetime import date, timedelta

import config
import memory.db as db


def _build_system_prompt() -> str:
    profile = db.get_profile()

    lines = ["你是一位專業跑步教練，以下是選手資料：", ""]

    goal = profile.get("goal_long_term", "")
    if goal:
        lines.append(f"長期目標：{goal}")

    pbs = []
    for key, label in [("pb_5k", "5km"), ("pb_10k", "10km"), ("pb_half", "半馬"), ("pb_full", "全馬")]:
        if key in profile:
            pbs.append(f"{label} {profile[key]}")
    if pbs:
        lines.append(f"個人最佳：{' / '.join(pbs)}")

    if "injuries" in profile:
        lines.append(f"傷病注意：{profile['injuries']}")

    if "weekly_km_target" in profile:
        lines.append(f"每週目標里程：{profile['weekly_km_target']}km")

    # 動態注入近期賽事（距今 90 天內）
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
                f"- {r['date']} {r['name']} {r['distance_km']}km{target}｜距今 {days_away} 天（{status}）"
            )

    lines += [
        "",
        "請根據選手資料給予個人化的跑步訓練建議。回應使用繁體中文。",
    ]

    return "\n".join(lines)


def get_context_for_api() -> dict:
    """回傳可直接傳入 Claude API 的 context dict."""
    system = _build_system_prompt()

    # 層5 — Rolling Window
    recent = db.get_recent_conversations(config.CONVERSATION_KEEP)
    messages = [{"role": r["role"], "content": r["content"]} for r in recent]

    return {"system": system, "messages": messages}


def should_compress() -> bool:
    return db.count_conversations() > config.CONVERSATION_MAX


def get_conversations_to_compress() -> list[dict]:
    """回傳應該被壓縮的舊對話（最舊的 total - KEEP 筆）."""
    total = db.count_conversations()
    compress_count = total - config.CONVERSATION_KEEP
    if compress_count <= 0:
        return []
    return db.get_oldest_conversations(compress_count)


def apply_compression(summary_text: str, covers_up_to_id: int) -> None:
    db.save_summary(summary_text, covers_up_to_id)
    db.delete_conversations_up_to(covers_up_to_id)
