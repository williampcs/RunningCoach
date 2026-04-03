"""SQLite initialization and query helpers."""
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

import config


@contextmanager
def get_conn():
    conn = sqlite3.connect(config.DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db() -> None:
    """Create all tables if they don't exist, and run incremental migrations."""
    with get_conn() as conn:
        conn.executescript("""
            CREATE TABLE IF NOT EXISTS athlete_profile (
                key        TEXT PRIMARY KEY,
                value      TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS races (
                id           INTEGER PRIMARY KEY AUTOINCREMENT,
                name         TEXT NOT NULL,
                date         TEXT NOT NULL,
                distance_km  REAL NOT NULL,
                target_time  TEXT,
                confirmed    INTEGER DEFAULT 1,
                result_time  TEXT,
                notes        TEXT,
                created_at   TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workouts (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                strava_id         TEXT UNIQUE,
                date              TEXT NOT NULL,
                type              TEXT DEFAULT 'run',
                distance_km       REAL,
                duration_min      REAL,
                avg_hr            INTEGER,
                max_hr            INTEGER,
                avg_pace          TEXT,
                elevation_m       REAL,
                calories          INTEGER,
                perceived_effort  INTEGER,
                subjective_notes  TEXT,
                laps_json         TEXT,
                streams_json      TEXT,
                raw_json          TEXT,
                source            TEXT DEFAULT 'strava',
                synced_at         TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workout_summaries (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                workout_id  INTEGER REFERENCES workouts(id),
                summary     TEXT NOT NULL,
                created_at  TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS training_plans (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                week_label TEXT NOT NULL,
                content    TEXT NOT NULL,
                created_at TEXT NOT NULL,
                is_active  INTEGER DEFAULT 1
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                role      TEXT NOT NULL,
                content   TEXT NOT NULL,
                timestamp TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS summaries (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                content         TEXT NOT NULL,
                covers_up_to_id INTEGER,
                created_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS strava_tokens (
                id            INTEGER PRIMARY KEY CHECK (id = 1),
                access_token  TEXT NOT NULL,
                refresh_token TEXT NOT NULL,
                expires_at    INTEGER NOT NULL
            );

            CREATE TABLE IF NOT EXISTS pending_subjective (
                id               INTEGER PRIMARY KEY AUTOINCREMENT,
                date             TEXT NOT NULL,
                perceived_effort INTEGER,
                subjective_notes TEXT,
                created_at       TEXT NOT NULL
            );
        """)

        # --- Migration: races.cancelled (added after initial schema) ---
        existing_cols = {
            row[1] for row in conn.execute("PRAGMA table_info(races)").fetchall()
        }
        if "cancelled" not in existing_cols:
            conn.execute(
                "ALTER TABLE races ADD COLUMN cancelled INTEGER DEFAULT 0"
            )


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------
# athlete_profile helpers
# ---------------------------------------------------------------------------

def get_profile() -> dict:
    with get_conn() as conn:
        rows = conn.execute("SELECT key, value FROM athlete_profile").fetchall()
    return {r["key"]: r["value"] for r in rows}


def set_profile_key(key: str, value: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO athlete_profile (key, value, updated_at) VALUES (?, ?, ?)"
            " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
            (key, value, now_iso()),
        )


# ---------------------------------------------------------------------------
# races helpers
# ---------------------------------------------------------------------------

def get_upcoming_races(days: int) -> list[dict]:
    from datetime import date, timedelta
    today = date.today().isoformat()
    cutoff = (date.today() + timedelta(days=days)).isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT * FROM races WHERE date >= ? AND date <= ? AND cancelled=0 ORDER BY date",
            (today, cutoff),
        ).fetchall()
    return [dict(r) for r in rows]


def add_race(name: str, date: str, distance_km: float,
             target_time: str = "", confirmed: int = 1, notes: str = "") -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO races (name, date, distance_km, target_time, confirmed, notes, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            (name, date, distance_km, target_time or None, confirmed, notes or None, now_iso()),
        )
        return cur.lastrowid


def update_race(race_id: int, **kwargs) -> None:
    """更新賽事欄位，只更新有傳入的欄位（name/date/distance_km/target_time/confirmed/notes）."""
    allowed = {"name", "date", "distance_km", "target_time", "confirmed", "notes"}
    updates = {k: v for k, v in kwargs.items() if k in allowed and v is not None}
    if not updates:
        return
    set_clause = ", ".join(f"{k}=?" for k in updates)
    values = list(updates.values()) + [race_id]
    with get_conn() as conn:
        conn.execute(f"UPDATE races SET {set_clause} WHERE id=?", values)


def cancel_race(race_id: int, notes: str = "") -> None:
    """將賽事標記為已取消（不刪除，保留歷史紀錄）."""
    with get_conn() as conn:
        conn.execute(
            "UPDATE races SET cancelled=1, notes=COALESCE(NULLIF(?, ''), notes) WHERE id=?",
            (notes or None, race_id),
        )


def update_race_result(race_id: int, result_time: str, notes: str = "") -> None:
    with get_conn() as conn:
        conn.execute(
            "UPDATE races SET result_time=?, notes=COALESCE(NULLIF(?, ''), notes) WHERE id=?",
            (result_time, notes or None, race_id),
        )


# ---------------------------------------------------------------------------
# conversations helpers
# ---------------------------------------------------------------------------

def append_conversation(role: str, content: str) -> int:
    with get_conn() as conn:
        cur = conn.execute(
            "INSERT INTO conversations (role, content, timestamp) VALUES (?, ?, ?)",
            (role, content, now_iso()),
        )
        return cur.lastrowid


def get_recent_conversations(limit: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM conversations ORDER BY id DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return list(reversed([dict(r) for r in rows]))


def count_conversations() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) FROM conversations").fetchone()[0]


def delete_conversations_up_to(max_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM conversations WHERE id <= ?", (max_id,))


def get_oldest_conversations(n: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT id, role, content FROM conversations ORDER BY id ASC LIMIT ?",
            (n,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# summaries helpers
# ---------------------------------------------------------------------------

def get_latest_summary() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM summaries ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def save_summary(content: str, covers_up_to_id: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO summaries (content, covers_up_to_id, created_at) VALUES (?, ?, ?)",
            (content, covers_up_to_id, now_iso()),
        )
        # Keep only the latest summary
        conn.execute(
            "DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY id DESC LIMIT 1)"
        )


# ---------------------------------------------------------------------------
# workout_summaries helpers
# ---------------------------------------------------------------------------

def get_recent_workout_summaries(count: int) -> list[dict]:
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT ws.summary, w.date
               FROM workout_summaries ws
               JOIN workouts w ON ws.workout_id = w.id
               ORDER BY ws.id DESC LIMIT ?""",
            (count,),
        ).fetchall()
    return list(reversed([dict(r) for r in rows]))


# ---------------------------------------------------------------------------
# training_plans helpers
# ---------------------------------------------------------------------------

def get_active_training_plan() -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM training_plans WHERE is_active=1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
    return dict(row) if row else None


def save_training_plan(week_label: str, content: str) -> None:
    with get_conn() as conn:
        conn.execute("UPDATE training_plans SET is_active=0")
        conn.execute(
            "INSERT INTO training_plans (week_label, content, created_at, is_active) VALUES (?, ?, ?, 1)",
            (week_label, content, now_iso()),
        )


# ---------------------------------------------------------------------------
# strava_tokens helpers
# ---------------------------------------------------------------------------

def get_strava_token() -> dict | None:
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM strava_tokens WHERE id=1").fetchone()
    return dict(row) if row else None


def save_strava_token(access_token: str, refresh_token: str, expires_at: int) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO strava_tokens (id, access_token, refresh_token, expires_at)"
            " VALUES (1, ?, ?, ?)"
            " ON CONFLICT(id) DO UPDATE SET"
            "   access_token=excluded.access_token,"
            "   refresh_token=excluded.refresh_token,"
            "   expires_at=excluded.expires_at",
            (access_token, refresh_token, expires_at),
        )


# ---------------------------------------------------------------------------
# workouts helpers
# ---------------------------------------------------------------------------

def get_workout_by_strava_id(strava_id: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM workouts WHERE strava_id=?", (strava_id,)
        ).fetchone()
    return dict(row) if row else None


def save_workout(strava_data: dict,
                 perceived_effort: int | None = None,
                 subjective_notes: str | None = None) -> int:
    """將客觀 Strava 資料與主觀感受合併存入 workouts table."""
    import json as _json
    raw = strava_data.get("raw_json")
    raw_str = _json.dumps(raw, ensure_ascii=False) if isinstance(raw, dict) else raw
    with get_conn() as conn:
        cur = conn.execute(
            """INSERT INTO workouts
               (strava_id, date, type, distance_km, duration_min,
                avg_hr, max_hr, avg_pace, elevation_m, calories,
                perceived_effort, subjective_notes, raw_json, source, synced_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'strava',?)
               ON CONFLICT(strava_id) DO UPDATE SET
                 perceived_effort = COALESCE(excluded.perceived_effort, perceived_effort),
                 subjective_notes = COALESCE(excluded.subjective_notes, subjective_notes),
                 synced_at        = excluded.synced_at""",
            (
                strava_data.get("strava_id"),
                strava_data["date"],
                strava_data.get("type", "run"),
                strava_data.get("distance_km"),
                strava_data.get("duration_min"),
                strava_data.get("avg_hr"),
                strava_data.get("max_hr"),
                strava_data.get("avg_pace"),
                strava_data.get("elevation_m"),
                strava_data.get("calories"),
                perceived_effort,
                subjective_notes,
                raw_str,
                now_iso(),
            ),
        )
        # UPSERT 不回傳 lastrowid，需另查
        row = conn.execute(
            "SELECT id FROM workouts WHERE strava_id=?", (strava_data.get("strava_id"),)
        ).fetchone()
        return row["id"] if row else cur.lastrowid


def save_workout_summary(workout_id: int, summary: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO workout_summaries (workout_id, summary, created_at) VALUES (?, ?, ?)",
            (workout_id, summary, now_iso()),
        )


def get_recent_workouts_raw(days: int) -> list[dict]:
    """回傳最近 N 天的跑步紀錄（含 workout_summaries）."""
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            """SELECT w.*, ws.summary
               FROM workouts w
               LEFT JOIN workout_summaries ws ON ws.workout_id = w.id
               WHERE w.date >= ?
               ORDER BY w.date DESC""",
            (cutoff,),
        ).fetchall()
    return [dict(r) for r in rows]


def get_workouts_for_pace_trend(weeks: int) -> list[dict]:
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(weeks=weeks)).isoformat()
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT date, avg_pace, distance_km FROM workouts"
            " WHERE date >= ? AND avg_pace IS NOT NULL ORDER BY date",
            (cutoff,),
        ).fetchall()
    return [dict(r) for r in rows]


# ---------------------------------------------------------------------------
# pending_subjective helpers
# ---------------------------------------------------------------------------

def save_pending_subjective(date: str, perceived_effort: int,
                            subjective_notes: str) -> None:
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO pending_subjective (date, perceived_effort, subjective_notes, created_at)"
            " VALUES (?, ?, ?, ?)",
            (date, perceived_effort, subjective_notes, now_iso()),
        )


def get_pending_subjective_by_date(date: str) -> dict | None:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM pending_subjective WHERE date=? ORDER BY id DESC LIMIT 1",
            (date,),
        ).fetchone()
    return dict(row) if row else None


def delete_pending_subjective(record_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM pending_subjective WHERE id=?", (record_id,))


def cleanup_old_pending_subjective() -> None:
    """刪除超過 7 天未配對的主觀暫存資料."""
    from datetime import date, timedelta
    cutoff = (date.today() - timedelta(days=7)).isoformat()
    with get_conn() as conn:
        conn.execute("DELETE FROM pending_subjective WHERE date < ?", (cutoff,))
