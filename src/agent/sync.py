"""/sync 指令的完整同步流程.

流程：
1. 從 Strava 拉取最近 14 天的跑步活動
2. 以 strava_id 去重，只處理新資料
3. 檢查 pending_subjective 是否有符合日期的主觀暫存
4. 合併主客觀資料（或僅存客觀資料）後存入 workouts
5. 生成 AI 摘要存入 workout_summaries
6. 清理超過 7 天的 pending_subjective
"""
import logging

import memory.db as db
from tools.strava_tool import strava
from agent.loop import generate_workout_summary

logger = logging.getLogger(__name__)


def run_sync() -> str:
    """執行完整 Strava 同步，回傳結果摘要字串."""
    # 拉取最近 14 天活動
    try:
        activities = strava.fetch_activities(days=14)
    except RuntimeError as e:
        return f"❌ Strava 連線失敗：{e}"
    except Exception as e:
        logger.error("Strava fetch error: %s", e)
        return f"❌ 拉取 Strava 資料時發生錯誤：{e}"

    if not activities:
        return "Strava 最近 14 天無跑步活動。"

    new_count = 0
    merged_count = 0
    skipped_count = 0

    for activity in activities:
        strava_id = activity["strava_id"]
        act_date  = activity["date"]

        # 去重：已存在則跳過
        if db.get_workout_by_strava_id(strava_id):
            skipped_count += 1
            continue

        # 檢查是否有主觀暫存資料
        pending = db.get_pending_subjective_by_date(act_date)
        perceived_effort  = pending["perceived_effort"]  if pending else None
        subjective_notes  = pending["subjective_notes"]  if pending else None

        # 儲存 workout
        try:
            workout_id = db.save_workout(
                strava_data=activity,
                perceived_effort=perceived_effort,
                subjective_notes=subjective_notes,
            )
        except Exception as e:
            logger.error("save_workout failed for strava_id=%s: %s", strava_id, e)
            continue

        # 生成 AI 摘要
        try:
            workout_data = {**activity,
                            "perceived_effort": perceived_effort,
                            "subjective_notes": subjective_notes}
            summary = generate_workout_summary(workout_data)
            db.save_workout_summary(workout_id, summary)
        except Exception as e:
            logger.warning("Summary generation failed for workout_id=%d: %s", workout_id, e)

        # 清除已配對的 pending 資料
        if pending:
            db.delete_pending_subjective(pending["id"])
            merged_count += 1

        new_count += 1

    # 清理超過 7 天的主觀暫存
    db.cleanup_old_pending_subjective()

    # 組合回傳訊息
    parts = [f"✅ Strava 同步完成"]
    if new_count:
        parts.append(f"新增 {new_count} 筆訓練紀錄")
    if merged_count:
        parts.append(f"其中 {merged_count} 筆合併了主觀感受")
    if skipped_count:
        parts.append(f"略過 {skipped_count} 筆已存在資料")
    if new_count == 0 and skipped_count > 0:
        parts = ["✅ 無新資料，所有活動已是最新狀態。"]

    return "，".join(parts[:1]) + "：" + "，".join(parts[1:]) if len(parts) > 1 else parts[0]
