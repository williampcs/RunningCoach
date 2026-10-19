/** SQLite schema 與查詢 — schema 與 v1（Python 版）相容，v1 的資料庫檔可直接使用. */
import { addDays, nowIso } from "./dates";
import { keepScore, sameRun } from "./dedupe";
import type {
  Activity,
  ConversationRow,
  DailyCheckin,
  PendingSubjective,
  Race,
  Row,
  SqlDriver,
  SqlValue,
  SummaryRow,
  TrainingPlan,
  WellnessDay,
  Workout,
} from "./types";

/**
 * 2：新增 wellness 與 daily_checkins（v1 不讀這兩張表，仍可開啟同一個資料庫）
 * 3：wellness.hrv_sdnn
 * 4：workouts.duplicate_of、workouts.removed_at 與 workout_distinct（去重、跟著 Intervals.icu 的刪除）
 */
export const SCHEMA_VERSION = 4;

/** 列表、統計與教練看到的訓練：排除重複的與已移除的 */
const ACTIVE = "w.duplicate_of IS NULL AND w.removed_at IS NULL";

/** 存一筆訓練的結果；id 是保留的那筆 */
export interface SaveResult {
  id: number;
  /**
   * new：新的一筆；existing：已存過（依活動 id），只補上體感與負荷；
   * duplicate：和既有的一筆是同一趟，標為重複，保留既有的那筆；
   * replaced：和既有的一筆是同一趟，新的資料較完整（例如有心率），改保留新的這筆
   */
  status: "new" | "existing" | "duplicate" | "replaced";
}

type WorkoutRow = Pick<
  Workout,
  "id" | "date" | "distance_km" | "duration_min" | "avg_hr" | "training_load" | "raw_json" | "perceived_effort" | "subjective_notes"
>;

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

  CREATE TABLE IF NOT EXISTS wellness (
    date        TEXT PRIMARY KEY,
    resting_hr  INTEGER,
    hrv         REAL,
    hrv_sdnn    REAL,
    sleep_secs  INTEGER,
    sleep_score INTEGER,
    readiness   INTEGER,
    raw_json    TEXT,
    synced_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_checkins (
    date       TEXT PRIMARY KEY,
    energy     INTEGER NOT NULL,
    soreness   INTEGER NOT NULL,
    sleep      INTEGER NOT NULL,
    notes      TEXT,
    updated_at TEXT NOT NULL
  );

  -- 選手確認「不是同一趟」的兩筆（a < b），之後不再詢問或合併
  CREATE TABLE IF NOT EXISTS workout_distinct (
    a INTEGER NOT NULL,
    b INTEGER NOT NULL,
    PRIMARY KEY (a, b)
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

  /** 使用者時區的今天 */
  today(): string {
    return this.clock.today();
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

      // --- Migration: wellness.hrv_sdnn（schema 3：Apple「健康」的 HRV） ---
      if (!(await columns("wellness")).has("hrv_sdnn")) {
        await d.exec("ALTER TABLE wellness ADD COLUMN hrv_sdnn REAL");
      }

      // --- Migration: workouts.duplicate_of、removed_at（schema 4：去重、跟著 Intervals.icu 的刪除） ---
      if (!workoutCols.has("duplicate_of")) await d.exec("ALTER TABLE workouts ADD COLUMN duplicate_of INTEGER");
      if (!workoutCols.has("removed_at")) await d.exec("ALTER TABLE workouts ADD COLUMN removed_at TEXT");

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
    return this.all<ConversationRow>("SELECT id, role, content, timestamp FROM conversations ORDER BY id ASC LIMIT ?", [
      n,
    ]);
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
      const rows = await this.driver.all(
        "SELECT id, role, content, timestamp FROM conversations ORDER BY id DESC LIMIT ?",
        [limit],
      );
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

  /** 將客觀活動資料與主觀感受合併存入 workouts，回傳保留的那筆的 id（細節見 saveWorkoutChecked） */
  async saveWorkout(
    activity: Activity,
    perceivedEffort: number | null = null,
    subjectiveNotes: string | null = null,
  ): Promise<number> {
    return (await this.saveWorkoutChecked(activity, perceivedEffort, subjectiveNotes)).id;
  }

  /**
   * 存一筆訓練。同一活動（活動 id）已存在時只補上主觀感受與負荷；
   * 和既有的一筆是同一趟（時間重疊，dedupe.ts）時標記為重複，保留資料較完整的那筆。
   */
  saveWorkoutChecked(
    activity: Activity,
    perceivedEffort: number | null = null,
    subjectiveNotes: string | null = null,
  ): Promise<SaveResult> {
    const d = this.driver;
    const intervalsId = activity.intervals_id ?? null;
    const stravaId = activity.strava_id ?? null;
    // 活動來源有標明時沿用（例如測試模式的 "fake"）；Intervals.icu 的資料不帶 source
    const source = activity.source ?? (intervalsId ? "intervals" : "strava");

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
        return { id: workoutId, status: "existing" } as SaveResult;
      }

      const match = await this.findSameRun(activity, null);
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
      const id = result.lastInsertRowid;
      return match ? this.resolveSameRun(id, activity, match) : ({ id, status: "new" } as SaveResult);
    });
  }

  /**
   * 最近 N 天的跑步紀錄，各附上最新一筆 AI 摘要。
   * 同一筆訓練重新回報時會再生成一次摘要；只取最新的，避免同一筆訓練重複出現。
   */
  getRecentWorkouts(days: number): Promise<Workout[]> {
    return this.all<Workout>(
      `SELECT w.*, ws.summary,
              (SELECT COUNT(*) FROM workouts d WHERE d.duplicate_of = w.id AND d.removed_at IS NULL) AS duplicate_count
         FROM workouts w
         LEFT JOIN workout_summaries ws
           ON ws.id = (SELECT MAX(id) FROM workout_summaries WHERE workout_id = w.id)
        WHERE w.date >= ? AND ${ACTIVE}
        ORDER BY w.date DESC, w.id DESC`,
      [addDays(this.clock.today(), -days)],
    );
  }

  /** 訓練紀錄筆數（不含重複與已移除的）；指定 days 時只計最近 N 天 */
  countWorkouts(days?: number): Promise<number> {
    if (days === undefined) return this.count(`SELECT COUNT(*) AS n FROM workouts w WHERE ${ACTIVE}`);
    return this.count(`SELECT COUNT(*) AS n FROM workouts w WHERE date >= ? AND ${ACTIVE}`, [
      addDays(this.clock.today(), -days),
    ]);
  }

  getWorkoutsForPaceTrend(weeks: number): Promise<{ date: string; avg_pace: string; distance_km: number | null }[]> {
    return this.all(
      `SELECT date, avg_pace, distance_km FROM workouts w WHERE date >= ? AND avg_pace IS NOT NULL AND ${ACTIVE} ORDER BY date`,
      [addDays(this.clock.today(), -weeks * 7)],
    );
  }

  // ---------------------------------------------------------------------------
  // 去重：同一趟從不同來源進來（dedupe.ts 判斷）、跟著 Intervals.icu 的刪除
  // ---------------------------------------------------------------------------

  /** 在交易中：dupId 標為 keepId 的重複，原本指向 dupId 的也改指向 keepId；保留的那筆沒有體感時，從重複的那筆帶過來 */
  private async attachDuplicate(keepId: number, dupId: number): Promise<void> {
    const d = this.driver;
    await d.run("UPDATE workouts SET duplicate_of = ? WHERE id = ? OR duplicate_of = ?", [keepId, dupId, dupId]);
    await d.run(
      `UPDATE workouts SET
         perceived_effort = COALESCE(perceived_effort, (SELECT perceived_effort FROM workouts WHERE id = ?)),
         subjective_notes = COALESCE(subjective_notes, (SELECT subjective_notes FROM workouts WHERE id = ?))
       WHERE id = ?`,
      [dupId, dupId, keepId],
    );
  }

  /** 在交易中：和 row 同一趟、仍在列表上的另一筆（前後一天內） */
  private async findSameRun(row: WorkoutRow | Activity, excludeId: number | null): Promise<WorkoutRow | null> {
    const nearby = (await this.driver.all(
      `SELECT id, date, distance_km, duration_min, avg_hr, training_load, raw_json, perceived_effort, subjective_notes
         FROM workouts w WHERE ${ACTIVE} AND date BETWEEN ? AND ? AND id IS NOT ?`,
      [addDays(row.date, -1), addDays(row.date, 1), excludeId],
    )) as unknown as WorkoutRow[];
    return nearby.find((w) => sameRun(w, row)) ?? null;
  }

  /** 在交易中：新進來的 id 和既有的 match 是同一趟，依資料完整度決定保留哪一筆 */
  private async resolveSameRun(id: number, row: WorkoutRow | Activity, match: WorkoutRow): Promise<SaveResult> {
    if (keepScore(row) > keepScore(match)) {
      await this.attachDuplicate(id, match.id);
      return { id, status: "replaced" };
    }
    await this.attachDuplicate(match.id, id);
    return { id: match.id, status: "duplicate" };
  }

  /** 選手說過「不是同一趟」的組合，例：「12-15」（小的 id 在前） */
  async getDistinctPairs(): Promise<Set<string>> {
    const rows = await this.all<{ a: number; b: number }>("SELECT a, b FROM workout_distinct");
    return new Set(rows.map((r) => `${r.a}-${r.b}`));
  }

  async markDistinct(a: number, b: number): Promise<void> {
    await this.run("INSERT OR IGNORE INTO workout_distinct (a, b) VALUES (?, ?)", [Math.min(a, b), Math.max(a, b)]);
  }

  /** 手動合併：dupId 標為 keepId 的重複 */
  mergeWorkouts(keepId: number, dupId: number): Promise<void> {
    return this.tx(async () => {
      await this.attachDuplicate(keepId, dupId);
      await this.driver.run("DELETE FROM workout_distinct WHERE a = ? AND b = ?", [Math.min(keepId, dupId), Math.max(keepId, dupId)]);
    });
  }

  /** 「不是同一趟」：把併進 id 的紀錄拆開，記住之後不再合併；回傳拆開的筆數 */
  splitDuplicates(id: number): Promise<number> {
    const d = this.driver;
    return this.tx(async () => {
      const dups = await d.all("SELECT id FROM workouts WHERE duplicate_of = ?", [id]);
      for (const row of dups) {
        const dupId = Number(row.id);
        await d.run("UPDATE workouts SET duplicate_of = NULL WHERE id = ?", [dupId]);
        await d.run("INSERT OR IGNORE INTO workout_distinct (a, b) VALUES (?, ?)", [Math.min(id, dupId), Math.max(id, dupId)]);
      }
      return dups.length;
    });
  }

  /**
   * 跟著 Intervals.icu：since～until 之間，本機有、這次同步沒拿到的（已刪除，或類型不再是跑步），標記為已移除。
   * 被移除的若是保留的那筆，改由它的重複中資料最完整的一筆接手，體感與分析一起移過去。
   * 回傳移除的筆數，只算列表上看得到的（重複的那份本來就不顯示）。
   */
  markRemovedMissing(seenIntervalsIds: string[], since: string, until: string): Promise<number> {
    const d = this.driver;
    const seen = new Set(seenIntervalsIds);
    return this.tx(async () => {
      const rows = (await d.all(
        `SELECT id, intervals_id, duplicate_of FROM workouts
          WHERE intervals_id IS NOT NULL AND removed_at IS NULL AND date BETWEEN ? AND ?`,
        [since, until],
      )) as { id: number; intervals_id: string; duplicate_of: number | null }[];
      const missing = rows.filter((r) => !seen.has(r.intervals_id));
      for (const r of missing) await d.run("UPDATE workouts SET removed_at = ? WHERE id = ?", [this.stamp(), r.id]);

      for (const removed of missing.filter((r) => r.duplicate_of === null)) {
        const dups = (await d.all(
          "SELECT id, avg_hr, training_load FROM workouts WHERE duplicate_of = ? AND removed_at IS NULL ORDER BY id",
          [removed.id],
        )) as { id: number; avg_hr: number | null; training_load: number | null }[];
        if (!dups.length) continue;
        const heir = dups.reduce((best, w) => (keepScore(w) > keepScore(best) ? w : best));
        await d.run("UPDATE workouts SET duplicate_of = NULL WHERE id = ?", [heir.id]);
        await d.run("UPDATE workouts SET duplicate_of = ? WHERE duplicate_of = ? AND id != ?", [heir.id, removed.id, heir.id]);
        await d.run(
          `UPDATE workouts SET
             perceived_effort = COALESCE(perceived_effort, (SELECT perceived_effort FROM workouts WHERE id = ?)),
             subjective_notes = COALESCE(subjective_notes, (SELECT subjective_notes FROM workouts WHERE id = ?))
           WHERE id = ?`,
          [removed.id, removed.id, heir.id],
        );
        const own = await d.all("SELECT 1 FROM workout_summaries WHERE workout_id = ? LIMIT 1", [heir.id]);
        if (!own.length) await d.run("UPDATE workout_summaries SET workout_id = ? WHERE workout_id = ?", [heir.id, removed.id]);
      }
      return missing.filter((r) => r.duplicate_of === null).length;
    });
  }

  /** 已移除的又出現了（例如類型改回跑步）：恢復，並重新判斷是否和其他紀錄是同一趟 */
  restoreWorkout(id: number): Promise<SaveResult> {
    const d = this.driver;
    return this.tx(async () => {
      await d.run("UPDATE workouts SET removed_at = NULL WHERE id = ?", [id]);
      const row = ((await d.all(
        `SELECT id, date, distance_km, duration_min, avg_hr, training_load, raw_json, perceived_effort, subjective_notes
           FROM workouts WHERE id = ?`,
        [id],
      )) as unknown as WorkoutRow[])[0]!;
      const match = await this.findSameRun(row, id);
      return match ? this.resolveSameRun(id, row, match) : { id, status: "existing" };
    });
  }

  // ---------------------------------------------------------------------------
  // wellness（手錶的恢復資料）與 daily_checkins（選手自評）
  // ---------------------------------------------------------------------------

  /** 同一天以新資料覆蓋（手錶的睡眠、HRV 常在當天稍晚才補齊） */
  async upsertWellness(days: WellnessDay[]): Promise<void> {
    for (const w of days) {
      await this.run(
        `INSERT INTO wellness (date, resting_hr, hrv, hrv_sdnn, sleep_secs, sleep_score, readiness, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(date) DO UPDATE SET
           resting_hr=excluded.resting_hr, hrv=excluded.hrv, hrv_sdnn=excluded.hrv_sdnn, sleep_secs=excluded.sleep_secs,
           sleep_score=excluded.sleep_score, readiness=excluded.readiness,
           raw_json=excluded.raw_json, synced_at=excluded.synced_at`,
        [w.date, w.resting_hr, w.hrv, w.hrv_sdnn, w.sleep_secs, w.sleep_score, w.readiness, w.raw_json ?? null, this.stamp()],
      );
    }
  }

  /** 到 until（預設今天）為止 N 天的恢復資料（含 until 當天），舊的在前 */
  getWellness(days: number, until = this.clock.today()): Promise<WellnessDay[]> {
    return this.all<WellnessDay>(
      "SELECT date, resting_hr, hrv, hrv_sdnn, sleep_secs, sleep_score, readiness FROM wellness" +
        " WHERE date >= ? AND date <= ? ORDER BY date",
      [addDays(until, -days), until],
    );
  }

  async saveCheckin(c: DailyCheckin): Promise<void> {
    await this.run(
      `INSERT INTO daily_checkins (date, energy, soreness, sleep, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET energy=excluded.energy, soreness=excluded.soreness, sleep=excluded.sleep,
         notes=excluded.notes, updated_at=excluded.updated_at`,
      [c.date, c.energy, c.soreness, c.sleep, c.notes, this.stamp()],
    );
  }

  getCheckin(date: string): Promise<DailyCheckin | null> {
    return this.get<DailyCheckin>("SELECT date, energy, soreness, sleep, notes FROM daily_checkins WHERE date=?", [date]);
  }

  /** 最近 N 天（含今天）的自評，舊的在前 */
  getCheckins(days: number): Promise<DailyCheckin[]> {
    return this.all<DailyCheckin>(
      "SELECT date, energy, soreness, sleep, notes FROM daily_checkins WHERE date >= ? AND date <= ? ORDER BY date",
      [addDays(this.clock.today(), -days), this.clock.today()],
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
