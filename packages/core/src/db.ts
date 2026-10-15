/** SQLite schema 與查詢 — schema 與 v1（Python 版）相容，v1 的資料庫檔可直接使用. */
import { addDays, nowIso } from "./dates";
import type {
  Activity,
  ConversationRow,
  PendingSubjective,
  Race,
  Row,
  SqlDriver,
  SqlValue,
  SummaryRow,
  TrainingPlan,
  Workout,
} from "./types";

export const SCHEMA_VERSION = 1;

const SCHEMA = `
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

  CREATE TABLE IF NOT EXISTS pending_subjective (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    perceived_effort INTEGER,
    subjective_notes TEXT,
    created_at       TEXT NOT NULL
  );
`;

const RACE_FIELDS = ["name", "date", "distance_km", "target_time", "confirmed", "notes"] as const;
export type RaceUpdate = Partial<Record<(typeof RACE_FIELDS)[number], string | number | null>>;

export interface DbClock {
  now(): Date;
  /** 使用者時區的今天，YYYY-MM-DD */
  today(): string;
}

export class Db {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly driver: SqlDriver,
    private readonly clock: DbClock,
  ) {}

  /**
   * 所有操作經由同一佇列依序執行。
   * 外殼只有一條連線，主對話與背景壓縮會交錯 await；不排隊的話，
   * 別人的敘述會落進進行中的交易裡。
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private tx<T>(fn: () => Promise<T>): Promise<T> {
    return this.serial(async () => {
      await this.driver.exec("BEGIN");
      try {
        const value = await fn();
        await this.driver.exec("COMMIT");
        return value;
      } catch (e) {
        await this.driver.exec("ROLLBACK");
        throw e;
      }
    });
  }

  private run(sql: string, params: SqlValue[] = []) {
    return this.serial(() => this.driver.run(sql, params));
  }

  private all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.serial(() => this.driver.all(sql, params)) as Promise<T[]>;
  }

  private async get<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  private async count(sql: string, params: SqlValue[] = []): Promise<number> {
    const row = await this.get<{ n: number }>(sql, params);
    return row?.n ?? 0;
  }

  private stamp(): string {
    return nowIso(this.clock.now());
  }

  /** 建立所有 table，並執行增量 migration */
  async init(): Promise<void> {
    const d = this.driver;
    await this.tx(async () => {
      await d.exec(SCHEMA);

      const columns = async (table: string) =>
        new Set((await d.all(`PRAGMA table_info(${table})`)).map((r) => String(r.name)));

      // --- Migration: races.cancelled ---
      if (!(await columns("races")).has("cancelled")) {
        await d.exec("ALTER TABLE races ADD COLUMN cancelled INTEGER DEFAULT 0");
      }

      const workoutCols = await columns("workouts");
      // --- Migration: workouts.intervals_id ---
      if (!workoutCols.has("intervals_id")) {
        await d.exec("ALTER TABLE workouts ADD COLUMN intervals_id TEXT");
      }
      await d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_workouts_intervals_id ON workouts(intervals_id)");

      // --- Migration: workouts.training_load ---
      if (!workoutCols.has("training_load")) {
        await d.exec("ALTER TABLE workouts ADD COLUMN training_load INTEGER");
        // 既有紀錄從 raw_json 回填
        await d.exec(
          "UPDATE workouts SET training_load = json_extract(raw_json, '$.icu_training_load')" +
            " WHERE json_valid(raw_json)",
        );
      }

      await d.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    });
  }

  // ---------------------------------------------------------------------------
  // athlete_profile
  // ---------------------------------------------------------------------------

  async getProfile(): Promise<Record<string, string>> {
    const rows = await this.all<{ key: string; value: string }>("SELECT key, value FROM athlete_profile");
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async setProfileKey(key: string, value: string): Promise<void> {
    await this.run(
      "INSERT INTO athlete_profile (key, value, updated_at) VALUES (?, ?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at",
      [key, value, this.stamp()],
    );
  }

  async deleteProfileKey(key: string): Promise<void> {
    await this.run("DELETE FROM athlete_profile WHERE key=?", [key]);
  }

  // ---------------------------------------------------------------------------
  // races
  // ---------------------------------------------------------------------------

  getUpcomingRaces(days: number): Promise<Race[]> {
    const today = this.clock.today();
    return this.all<Race>("SELECT * FROM races WHERE date >= ? AND date <= ? AND cancelled=0 ORDER BY date", [
      today,
      addDays(today, days),
    ]);
  }

  /** 過去 N 天內已結束、尚未記錄成績且未取消的賽事（供賽後補登成績） */
  getPastRacesWithoutResult(days: number): Promise<Race[]> {
    const today = this.clock.today();
    return this.all<Race>(
      "SELECT * FROM races WHERE date < ? AND date >= ? AND cancelled=0" +
        " AND (result_time IS NULL OR result_time = '') ORDER BY date DESC",
      [today, addDays(today, -days)],
    );
  }

  /** 全部賽事（含已結束、已取消），供介面列表使用 */
  getAllRaces(): Promise<Race[]> {
    return this.all<Race>("SELECT * FROM races ORDER BY date DESC");
  }

  async addRace(race: {
    name: string;
    date: string;
    distance_km: number;
    target_time?: string;
    confirmed?: number;
    notes?: string;
  }): Promise<number> {
    const result = await this.run(
      "INSERT INTO races (name, date, distance_km, target_time, confirmed, notes, created_at)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        race.name,
        race.date,
        race.distance_km,
        race.target_time || null,
        race.confirmed ?? 1,
        race.notes || null,
        this.stamp(),
      ],
    );
    return result.lastInsertRowid;
  }

  /** 只更新有傳入的欄位 */
  async updateRace(raceId: number, fields: RaceUpdate): Promise<void> {
    const updates = RACE_FIELDS.filter((k) => fields[k] !== undefined && fields[k] !== null);
    if (updates.length === 0) return;
    const setClause = updates.map((k) => `${k}=?`).join(", ");
    await this.run(`UPDATE races SET ${setClause} WHERE id=?`, [...updates.map((k) => fields[k]!), raceId]);
  }

  /** 標記為已取消（不刪除，保留歷史紀錄） */
  async cancelRace(raceId: number, notes = ""): Promise<void> {
    await this.run("UPDATE races SET cancelled=1, notes=COALESCE(NULLIF(?, ''), notes) WHERE id=?", [
      notes || null,
      raceId,
    ]);
  }

  async updateRaceResult(raceId: number, resultTime: string, notes = ""): Promise<void> {
    await this.run("UPDATE races SET result_time=?, notes=COALESCE(NULLIF(?, ''), notes) WHERE id=?", [
      resultTime,
      notes || null,
      raceId,
    ]);
  }

  // ---------------------------------------------------------------------------
  // conversations
  // ---------------------------------------------------------------------------

  async appendConversation(role: "user" | "assistant", content: string): Promise<number> {
    const result = await this.run("INSERT INTO conversations (role, content, timestamp) VALUES (?, ?, ?)", [
      role,
      content,
      this.stamp(),
    ]);
    return result.lastInsertRowid;
  }

  async getRecentConversations(limit: number): Promise<ConversationRow[]> {
    const rows = await this.all<ConversationRow>(
      "SELECT id, role, content FROM conversations ORDER BY id DESC LIMIT ?",
      [limit],
    );
    return rows.reverse();
  }

  getConversation(id: number): Promise<ConversationRow | null> {
    return this.get<ConversationRow>("SELECT id, role, content FROM conversations WHERE id=?", [id]);
  }

  countConversations(): Promise<number> {
    return this.count("SELECT COUNT(*) AS n FROM conversations");
  }

  getOldestConversations(n: number): Promise<ConversationRow[]> {
    return this.all<ConversationRow>("SELECT id, role, content FROM conversations ORDER BY id ASC LIMIT ?", [n]);
  }

  // ---------------------------------------------------------------------------
  // summaries
  // ---------------------------------------------------------------------------

  getLatestSummary(): Promise<SummaryRow | null> {
    return this.get<SummaryRow>("SELECT * FROM summaries ORDER BY id DESC LIMIT 1");
  }

  /**
   * 一次取出最新摘要與尚未壓縮的對話。
   * 兩者必須在同一個時間點讀取：背景壓縮若剛好落在兩次讀取之間，
   * 被壓縮掉的對話會既不在舊摘要、也不在對話視窗中。
   */
  getMemorySnapshot(limit: number): Promise<{ summary: SummaryRow | null; conversations: ConversationRow[] }> {
    return this.serial(async () => {
      const summary = (await this.driver.all("SELECT * FROM summaries ORDER BY id DESC LIMIT 1"))[0];
      const rows = await this.driver.all("SELECT id, role, content FROM conversations ORDER BY id DESC LIMIT ?", [
        limit,
      ]);
      return {
        summary: (summary as SummaryRow | undefined) ?? null,
        conversations: (rows as unknown as ConversationRow[]).reverse(),
      };
    });
  }

  /** 存入新摘要（只保留最新一筆），並刪除已被摘要涵蓋的對話 */
  applyCompression(summaryText: string, coversUpToId: number): Promise<void> {
    const d = this.driver;
    return this.tx(async () => {
      await d.run("INSERT INTO summaries (content, covers_up_to_id, created_at) VALUES (?, ?, ?)", [
        summaryText,
        coversUpToId,
        this.stamp(),
      ]);
      await d.exec("DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY id DESC LIMIT 1)");
      await d.run("DELETE FROM conversations WHERE id <= ?", [coversUpToId]);
    });
  }

  // ---------------------------------------------------------------------------
  // workout_summaries
  // ---------------------------------------------------------------------------

  async saveWorkoutSummary(workoutId: number, summary: string): Promise<void> {
    await this.run("INSERT INTO workout_summaries (workout_id, summary, created_at) VALUES (?, ?, ?)", [
      workoutId,
      summary,
      this.stamp(),
    ]);
  }

  // ---------------------------------------------------------------------------
  // training_plans
  // ---------------------------------------------------------------------------

  getActiveTrainingPlan(): Promise<TrainingPlan | null> {
    return this.get<TrainingPlan>("SELECT * FROM training_plans WHERE is_active=1 ORDER BY id DESC LIMIT 1");
  }

  /** 儲存新計畫並停用舊計畫 */
  saveTrainingPlan(weekLabel: string, content: string): Promise<void> {
    const d = this.driver;
    return this.tx(async () => {
      await d.exec("UPDATE training_plans SET is_active=0");
      await d.run("INSERT INTO training_plans (week_label, content, created_at, is_active) VALUES (?, ?, ?, 1)", [
        weekLabel,
        content,
        this.stamp(),
      ]);
    });
  }

  // ---------------------------------------------------------------------------
  // workouts
  // ---------------------------------------------------------------------------

  /** 單筆訓練，附最新的摘要 */
  getWorkout(id: number): Promise<Workout | null> {
    return this.get<Workout>(
      `SELECT w.*, ws.summary
         FROM workouts w
         LEFT JOIN workout_summaries ws
           ON ws.id = (SELECT MAX(id) FROM workout_summaries WHERE workout_id = w.id)
        WHERE w.id = ?`,
      [id],
    );
  }

  /** 補填或修改已存檔訓練的主觀感受 */
  async updateWorkoutSubjective(id: number, perceivedEffort: number, subjectiveNotes: string | null): Promise<void> {
    await this.run("UPDATE workouts SET perceived_effort=?, subjective_notes=? WHERE id=?", [
      perceivedEffort,
      subjectiveNotes,
      id,
    ]);
  }

  getWorkoutByIntervalsId(intervalsId: string): Promise<Workout | null> {
    return this.get<Workout>("SELECT * FROM workouts WHERE intervals_id=?", [intervalsId]);
  }

  /** 將客觀活動資料與主觀感受合併存入 workouts；同一活動已存在時只補上主觀感受與負荷 */
  saveWorkout(
    activity: Activity,
    perceivedEffort: number | null = null,
    subjectiveNotes: string | null = null,
  ): Promise<number> {
    const d = this.driver;
    const intervalsId = activity.intervals_id ?? null;
    const stravaId = activity.strava_id ?? null;
    const source = intervalsId ? "intervals" : (activity.source ?? "strava");

    return this.tx(async () => {
      let existing: Row | undefined;
      if (intervalsId) {
        existing = (await d.all("SELECT id FROM workouts WHERE intervals_id=?", [intervalsId]))[0];
      } else if (stravaId) {
        existing = (await d.all("SELECT id FROM workouts WHERE strava_id=?", [stravaId]))[0];
      }

      if (existing) {
        const workoutId = Number(existing.id);
        await d.run(
          `UPDATE workouts SET
             perceived_effort = COALESCE(?, perceived_effort),
             subjective_notes = COALESCE(?, subjective_notes),
             training_load    = COALESCE(?, training_load),
             synced_at        = ?
           WHERE id = ?`,
          [perceivedEffort, subjectiveNotes, activity.training_load ?? null, this.stamp(), workoutId],
        );
        return workoutId;
      }

      const result = await d.run(
        `INSERT INTO workouts
           (intervals_id, strava_id, date, type, distance_km, duration_min,
            avg_hr, max_hr, avg_pace, elevation_m, calories, training_load,
            perceived_effort, subjective_notes, raw_json, source, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          intervalsId,
          stravaId,
          activity.date,
          activity.type ?? "run",
          activity.distance_km ?? null,
          activity.duration_min ?? null,
          activity.avg_hr ?? null,
          activity.max_hr ?? null,
          activity.avg_pace ?? null,
          activity.elevation_m ?? null,
          activity.calories ?? null,
          activity.training_load ?? null,
          perceivedEffort,
          subjectiveNotes,
          activity.raw_json ?? null,
          source,
          this.stamp(),
        ],
      );
      return result.lastInsertRowid;
    });
  }

  /**
   * 最近 N 天的跑步紀錄，各附上最新一筆 AI 摘要。
   * 同一筆訓練重新回報時會再生成一次摘要；只取最新的，避免同一筆訓練重複出現。
   */
  getRecentWorkouts(days: number): Promise<Workout[]> {
    return this.all<Workout>(
      `SELECT w.*, ws.summary
         FROM workouts w
         LEFT JOIN workout_summaries ws
           ON ws.id = (SELECT MAX(id) FROM workout_summaries WHERE workout_id = w.id)
        WHERE w.date >= ?
        ORDER BY w.date DESC, w.id DESC`,
      [addDays(this.clock.today(), -days)],
    );
  }

  /** 訓練紀錄筆數；指定 days 時只計最近 N 天 */
  countWorkouts(days?: number): Promise<number> {
    if (days === undefined) return this.count("SELECT COUNT(*) AS n FROM workouts");
    return this.count("SELECT COUNT(*) AS n FROM workouts WHERE date >= ?", [addDays(this.clock.today(), -days)]);
  }

  getWorkoutsForPaceTrend(weeks: number): Promise<{ date: string; avg_pace: string; distance_km: number | null }[]> {
    return this.all(
      "SELECT date, avg_pace, distance_km FROM workouts WHERE date >= ? AND avg_pace IS NOT NULL ORDER BY date",
      [addDays(this.clock.today(), -weeks * 7)],
    );
  }

  // ---------------------------------------------------------------------------
  // pending_subjective
  // ---------------------------------------------------------------------------

  async savePendingSubjective(date: string, perceivedEffort: number, subjectiveNotes: string): Promise<void> {
    await this.run(
      "INSERT INTO pending_subjective (date, perceived_effort, subjective_notes, created_at) VALUES (?, ?, ?, ?)",
      [date, perceivedEffort, subjectiveNotes, this.stamp()],
    );
  }

  getPendingSubjectiveByDate(date: string): Promise<PendingSubjective | null> {
    return this.get<PendingSubjective>("SELECT * FROM pending_subjective WHERE date=? ORDER BY id DESC LIMIT 1", [
      date,
    ]);
  }

  countPendingSubjective(): Promise<number> {
    return this.count("SELECT COUNT(*) AS n FROM pending_subjective");
  }

  async deletePendingSubjective(id: number): Promise<void> {
    await this.run("DELETE FROM pending_subjective WHERE id=?", [id]);
  }

  /** 刪除超過 7 天未配對的主觀暫存資料 */
  async cleanupOldPendingSubjective(): Promise<void> {
    await this.run("DELETE FROM pending_subjective WHERE date < ?", [addDays(this.clock.today(), -7)]);
  }
}
