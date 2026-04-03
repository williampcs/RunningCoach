"""Strava Tool — OAuth token 管理、活動拉取、資料正規化.

Phase 3 實作：fetch_latest_activity, fetch_activities
Phase 4 補充：fetch_activity_laps, fetch_activity_streams
"""
import json
import logging
import time

import requests

import config
import memory.db as db

logger = logging.getLogger(__name__)

BASE_URL = "https://www.strava.com/api/v3"


def _speed_to_pace(speed_mps: float) -> str | None:
    """將 m/s 轉換為配速字串，例：'5:30/km'."""
    if not speed_mps or speed_mps <= 0:
        return None
    secs_per_km = 1000 / speed_mps
    mins = int(secs_per_km // 60)
    secs = int(secs_per_km % 60)
    return f"{mins}:{secs:02d}/km"


class StravaTool:

    def _get_valid_token(self) -> str:
        """取得有效 access token，過期前 5 分鐘自動 refresh."""
        token = db.get_strava_token()
        if not token:
            raise RuntimeError(
                "找不到 Strava token，請先執行 strava_auth.py 完成授權。"
            )
        if token["expires_at"] - time.time() < 300:
            logger.info("Strava token 即將過期，自動 refresh...")
            token = self._do_refresh(token["refresh_token"])
        return token["access_token"]

    def _do_refresh(self, refresh_token: str) -> dict:
        resp = requests.post(
            "https://www.strava.com/oauth/token",
            data={
                "client_id":     config.STRAVA_CLIENT_ID,
                "client_secret": config.STRAVA_CLIENT_SECRET,
                "refresh_token": refresh_token,
                "grant_type":    "refresh_token",
            },
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        db.save_strava_token(
            access_token=data["access_token"],
            refresh_token=data["refresh_token"],
            expires_at=int(data["expires_at"]),
        )
        logger.info("Strava token 已 refresh，expires_at=%d", data["expires_at"])
        return data

    def _headers(self) -> dict:
        return {"Authorization": f"Bearer {self._get_valid_token()}"}

    def _normalize(self, raw: dict) -> dict:
        """將 Strava 活動資料正規化為系統格式."""
        return {
            "strava_id":    str(raw["id"]),
            "date":         raw["start_date_local"][:10],
            "type":         "run",
            "distance_km":  round(raw.get("distance", 0) / 1000, 2),
            "duration_min": round(raw.get("elapsed_time", 0) / 60, 1),
            "avg_hr":       raw.get("average_heartrate"),
            "max_hr":       raw.get("max_heartrate"),
            "avg_pace":     _speed_to_pace(raw.get("average_speed", 0)),
            "elevation_m":  raw.get("total_elevation_gain"),
            "calories":     raw.get("calories"),
            "raw_json":     json.dumps(raw, ensure_ascii=False),
        }

    def _is_run(self, activity: dict) -> bool:
        return activity.get("sport_type") == "Run" or activity.get("type") == "Run"

    def fetch_latest_activity(self) -> dict | None:
        """拉取最新一筆跑步活動（基本資料，不含 laps/streams）."""
        resp = requests.get(
            f"{BASE_URL}/athlete/activities",
            headers=self._headers(),
            params={"per_page": 1, "page": 1},
            timeout=15,
        )
        resp.raise_for_status()
        activities = resp.json()

        if not activities or not self._is_run(activities[0]):
            return None
        return self._normalize(activities[0])

    def fetch_activities(self, days: int) -> list[dict]:
        """拉取最近 N 天的跑步活動列表（基本資料）."""
        after = int(time.time()) - days * 86400
        resp = requests.get(
            f"{BASE_URL}/athlete/activities",
            headers=self._headers(),
            params={"after": after, "per_page": 30},
            timeout=15,
        )
        resp.raise_for_status()
        return [self._normalize(a) for a in resp.json() if self._is_run(a)]

    # ------------------------------------------------------------------
    # Phase 4 stubs
    # ------------------------------------------------------------------

    def fetch_activity_laps(self, activity_id: str) -> list[dict]:
        """拉取活動的 laps 資料（Phase 4 實作）."""
        resp = requests.get(
            f"{BASE_URL}/activities/{activity_id}/laps",
            headers=self._headers(),
            timeout=15,
        )
        resp.raise_for_status()
        return resp.json()

    def fetch_activity_streams(self, activity_id: str) -> dict:
        """拉取活動的心率／配速時序資料並降採樣（Phase 4 實作）."""
        resp = requests.get(
            f"{BASE_URL}/activities/{activity_id}/streams",
            headers=self._headers(),
            params={"keys": "time,heartrate,velocity_smooth"},
            timeout=15,
        )
        resp.raise_for_status()
        raw_streams = {s["type"]: s["data"] for s in resp.json()}

        # 降採樣：每 10 秒取一筆
        time_series = raw_streams.get("time", [])
        hr_series   = raw_streams.get("heartrate", [])
        vel_series  = raw_streams.get("velocity_smooth", [])

        sampled_time, sampled_hr, sampled_pace = [], [], []
        for i, t in enumerate(time_series):
            if t % 10 == 0:
                sampled_time.append(t)
                sampled_hr.append(hr_series[i] if i < len(hr_series) else None)
                pace = _speed_to_pace(vel_series[i]) if i < len(vel_series) else None
                sampled_pace.append(pace)

        return {"time": sampled_time, "heartrate": sampled_hr, "pace_per_km": sampled_pace}


# 模組層級 singleton
strava = StravaTool()
