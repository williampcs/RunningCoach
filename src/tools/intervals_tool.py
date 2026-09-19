"""Intervals.icu Tool — API 連線、活動拉取、資料正規化.

提供：
- fetch_latest_activity: 取得最新一筆跑步活動
- fetch_activities: 批次取得指定天數內的跑步活動
- fetch_activity_intervals: 取得間歇分段資料 (Phase 4 預留)
- fetch_activity_streams: 取得秒級時序資料 (Phase 4 預留)
"""
import json
import logging
from datetime import date, timedelta
from typing import Any

import requests
from requests.auth import HTTPBasicAuth

import config

logger = logging.getLogger(__name__)

BASE_URL = "https://intervals.icu/api/v1"


def _speed_to_pace(speed_mps: float | None) -> str | None:
    """將 m/s 轉換為配速字串，例：'5:30/km'."""
    if not speed_mps or speed_mps <= 0:
        return None
    secs_per_km = 1000 / speed_mps
    mins = int(secs_per_km // 60)
    secs = int(secs_per_km % 60)
    return f"{mins}:{secs:02d}/km"


class IntervalsTool:

    def _auth(self) -> HTTPBasicAuth:
        if not config.INTERVALS_API_KEY:
            raise RuntimeError(
                "找不到 Intervals.icu API Key，請先在 .env 中設定 INTERVALS_API_KEY。"
            )
        return HTTPBasicAuth("API_KEY", config.INTERVALS_API_KEY)

    @property
    def athlete_id(self) -> str:
        return config.INTERVALS_ATHLETE_ID if config.INTERVALS_ATHLETE_ID else "0"

    def _is_run(self, activity: dict) -> bool:
        sport = (activity.get("type") or activity.get("sport_type") or "").lower()
        return "run" in sport

    def _normalize(self, raw: dict) -> dict:
        """將 Intervals.icu 活動資料正規化為系統統一口徑."""
        distance_m = raw.get("distance") or raw.get("icu_distance") or 0
        moving_sec = raw.get("moving_time") or raw.get("elapsed_time") or 0
        speed_mps = raw.get("average_speed")

        # 若未提供 average_speed 且有 distance 與 moving_time 則自動推算
        if not speed_mps and moving_sec > 0:
            speed_mps = distance_m / moving_sec

        start_date_local = raw.get("start_date_local") or ""
        date_str = start_date_local[:10] if start_date_local else str(date.today())

        return {
            "intervals_id":  str(raw.get("id")),
            "date":          date_str,
            "type":          "run",
            "distance_km":   round(distance_m / 1000, 2),
            "duration_min":  round(moving_sec / 60, 1),
            "avg_hr":        raw.get("average_heartrate"),
            "max_hr":        raw.get("max_heartrate"),
            "avg_pace":      _speed_to_pace(speed_mps),
            "elevation_m":   raw.get("total_elevation_gain"),
            "calories":      raw.get("calories"),
            "training_load": raw.get("icu_training_load"),
            "raw_json":      json.dumps(raw, ensure_ascii=False),
        }

    def fetch_latest_activity(self) -> dict | None:
        """拉取最新一筆跑步活動（查詢最近 7 天）."""
        today = date.today()
        oldest = (today - timedelta(days=7)).isoformat()
        newest = today.isoformat()

        activities = self._query_activities(oldest=oldest, newest=newest)
        if not activities:
            return None

        # 依 start_date_local 倒序排序
        activities.sort(key=lambda x: x.get("start_date_local", ""), reverse=True)
        for act in activities:
            if self._is_run(act):
                return self._normalize(act)
        return None

    def fetch_activities(self, days: int = 14) -> list[dict]:
        """拉取最近 N 天的跑步活動列表（基本資料）."""
        today = date.today()
        oldest = (today - timedelta(days=days)).isoformat()
        newest = today.isoformat()

        raw_list = self._query_activities(oldest=oldest, newest=newest)
        # 依 start_date_local 倒序排序
        raw_list.sort(key=lambda x: x.get("start_date_local", ""), reverse=True)
        return [self._normalize(a) for a in raw_list if self._is_run(a)]

    def _query_activities(self, oldest: str, newest: str) -> list[dict]:
        url = f"{BASE_URL}/athlete/{self.athlete_id}/activities"
        resp = requests.get(
            url,
            auth=self._auth(),
            params={"oldest": oldest, "newest": newest},
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        if isinstance(data, list):
            return data
        return []

    # ------------------------------------------------------------------
    # Phase 4 stubs
    # ------------------------------------------------------------------

    def fetch_activity_laps(self, activity_id: str) -> list[dict]:
        """拉取活動的 intervals / laps 資料（Phase 4 實作）."""
        url = f"{BASE_URL}/activity/{activity_id}/intervals"
        resp = requests.get(url, auth=self._auth(), timeout=15)
        resp.raise_for_status()
        return resp.json()

    def fetch_activity_streams(self, activity_id: str) -> dict:
        """拉取活動的心率／配速時序資料並降採樣（Phase 4 實作）."""
        url = f"{BASE_URL}/activity/{activity_id}/streams.json"
        resp = requests.get(url, auth=self._auth(), timeout=15)
        resp.raise_for_status()
        raw_streams = {s["type"]: s["data"] for s in resp.json() if "type" in s and "data" in s}

        time_series = raw_streams.get("time", [])
        hr_series   = raw_streams.get("heartrate", [])
        vel_series  = raw_streams.get("velocity_smooth", [])

        # 降採樣：每 10 秒取一筆
        sampled_time, sampled_hr, sampled_pace = [], [], []
        for i, t in enumerate(time_series):
            if t % 10 == 0:
                sampled_time.append(t)
                sampled_hr.append(hr_series[i] if i < len(hr_series) else None)
                pace = _speed_to_pace(vel_series[i]) if i < len(vel_series) else None
                sampled_pace.append(pace)

        return {"time": sampled_time, "heartrate": sampled_hr, "pace_per_km": sampled_pace}


# 模組層級 singleton
intervals = IntervalsTool()
