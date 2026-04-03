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
