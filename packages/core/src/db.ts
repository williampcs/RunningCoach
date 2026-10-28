/** SQLite schema 與查詢 — schema 與 v1（Python 版）相容，v1 的資料庫檔可直接使用. */
import { addDays, nowIso } from "./dates";
import { keepScore, sameRun } from "./dedupe";
import type { PlannedSession, PlanStyle, SessionDraft, SessionStatus } from "./plan";
import type { RaceOutcome } from "./races";
import type {
  Activity,
  ConversationRow,
  DailyCheckin,
  OtherActivity,
  PendingSubjective,
  Race,
  Row,
  SqlDriver,
  SqlValue,
  SummaryRow,
  Memory,
  ReplyRef,
  TrainingPlan,
  WellnessDay,
  Workout,
} from "./types";

/**
 * 2：新增 wellness 與 daily_checkins（v1 不讀這兩張表，仍可開啟同一個資料庫）
 * 3：wellness.hrv_sdnn
 * 4：workouts.duplicate_of、workouts.removed_at 與 workout_distinct（去重、跟著 Intervals.icu 的刪除）
 * 5：source_snapshots（同步時存下的跑步設定與最佳配速曲線，訓練數值用）
 * 6：conversations.sources（教練回覆前讀過的資料，顯示為「參考了：…」）
 * 7：planned_sessions 與 training_plans 的 week_start、style、reason、outline、notes（結構化課表）
 * 8：other_activities（跑步以外的運動：騎車、游泳、肌力訓練等）
 * 9：多裝置同步（sync_state、sync_pending、sync_meta；賽事與課表的 sync_id）
 * 10：memories（記住的事）、conversations.archived（壓縮後保留原文）與 conversations.reply_to（回覆）
 * 11：races 的 outcome、outcome_reason（完賽、沒有完賽、沒有出賽）、gun_time、result_source、result_activity
 * 12：planned_sessions 的 sport（交叉訓練的運動）與 done_at（選手回報做完了）（多運動，規格 12.24）
 * 13：races.sport（賽事的運動）與 activity_feedback（騎車等其他運動的體感與感受）（多運動的第 3 階段）
 * 14：planned_sessions.edited_at（教練改過這堂課的內容，規格 12.31 第 1 點）
 * 15：races 的 place_label、place_lat、place_lon（比賽的地點，只用來查天氣）與 start_time（起跑時間）（規格 12.31 第 3 點）
 */
export const SCHEMA_VERSION = 15;

/** 記住的事最多幾條、每條最多幾個字：每次對話都會帶入 */
export const MEMORY_MAX_ITEMS = 30;
export const MEMORY_MAX_CHARS = 300;
/** 回覆時存下的被回覆訊息摘錄長度 */
export const REPLY_EXCERPT_CHARS = 200;

/** 列表、統計與教練看到的訓練：排除重複的與已移除的 */
const ACTIVE = "w.duplicate_of IS NULL AND w.removed_at IS NULL";

/** 還沒有結局的賽事；舊版或同步過來、沒有 outcome 的，用 cancelled 與成績判斷 */
const NO_OUTCOME = "COALESCE(outcome, '') = '' AND cancelled=0 AND COALESCE(result_time, '') = ''";

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

  CREATE TABLE IF NOT EXISTS memories (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_id     TEXT,
    content     TEXT NOT NULL,
    source      TEXT NOT NULL DEFAULT 'user',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
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

  CREATE TABLE IF NOT EXISTS planned_sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_id    INTEGER NOT NULL,
    position   INTEGER NOT NULL,
    date       TEXT,
    kind       TEXT NOT NULL,
    title      TEXT NOT NULL,
    steps      TEXT NOT NULL,
    purpose    TEXT NOT NULL DEFAULT '',
    success    TEXT NOT NULL DEFAULT '',
    fallback   TEXT,
    status     TEXT NOT NULL DEFAULT 'planned',
    note       TEXT,
    updated_at TEXT NOT NULL,
    sport      TEXT,
    done_at    TEXT,
    edited_at  TEXT
  );

  CREATE TABLE IF NOT EXISTS other_activities (
    intervals_id  TEXT PRIMARY KEY,
    date          TEXT NOT NULL,
    type          TEXT NOT NULL,
    duration_min  REAL,
    distance_km   REAL,
    avg_hr        INTEGER,
    training_load INTEGER,
    raw_json      TEXT,
    synced_at     TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS source_snapshots (
    key        TEXT PRIMARY KEY,
    json       TEXT NOT NULL,
    fetched_at TEXT NOT NULL
  );

  -- 多裝置同步（schema 9，規格 12.10）：上次同步時每一筆的雜湊與伺服器序號
  CREATE TABLE IF NOT EXISTS sync_state (
    key      TEXT PRIMARY KEY,
    hash     TEXT NOT NULL,
    seq      INTEGER NOT NULL,
    v        INTEGER NOT NULL DEFAULT 0
  );
  -- 別台傳來、但這台還沒有對應紀錄的（例如另一台的跑步還沒同步到這台）
  CREATE TABLE IF NOT EXISTS sync_pending (
    key   TEXT PRIMARY KEY,
    data  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sync_meta (
    k  TEXT PRIMARY KEY,
    v  TEXT NOT NULL
  );
  -- 跑步以外的運動的體感與感受（運動回報）：other_activities 跟著來源整批更新，回報另外存，不會被同步蓋掉
  CREATE TABLE IF NOT EXISTS activity_feedback (
    intervals_id     TEXT PRIMARY KEY,
    perceived_effort INTEGER,
    subjective_notes TEXT,
    updated_at       TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS pending_subjective (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    date             TEXT NOT NULL,
    perceived_effort INTEGER,
    subjective_notes TEXT,
    created_at       TEXT NOT NULL
  );
`;

const RACE_FIELDS = ["name", "date", "distance_km", "target_time", "confirmed", "notes", "sport", "place_label", "place_lat", "place_lon", "start_time"] as const;
/** 可以清掉（寫成 NULL）的欄位：地點與起跑時間；其他欄位傳 null 時不改 */
const RACE_CLEARABLE = new Set<string>(["place_label", "place_lat", "place_lon", "start_time"]);
export type RaceUpdate = Partial<Record<(typeof RACE_FIELDS)[number], string | number | null>>;

function parseJsonArray(json: string | null): unknown[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

const CONVERSATION_COLS = "id, role, content, timestamp, sources, archived, reply_to";

type StoredConversation = Omit<ConversationRow, "sources" | "archived" | "reply_to"> & {
  sources: string | null;
  archived: number;
  reply_to: string | null;
};

function conversationOf(r: StoredConversation): ConversationRow {
  return { ...r, sources: parseSources(r.sources), archived: Boolean(r.archived), reply_to: parseReply(r.reply_to) };
}

function parseReply(json: string | null): ReplyRef | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json) as Partial<ReplyRef>;
    if ((v.role === "user" || v.role === "assistant") && typeof v.timestamp === "string" && typeof v.text === "string") {
      return { role: v.role, timestamp: v.timestamp, text: v.text };
    }
  } catch {
    // 壞掉的就當成沒有
  }
  return null;
}

/** 記住的事：去掉頭尾空白，空的或太長都不行 */
function memoryText(content: string): string {
  const text = content.trim();
  if (!text) throw new Error("內容是空的");
  if (text.length > MEMORY_MAX_CHARS) throw new Error(`一條最多 ${MEMORY_MAX_CHARS} 字，請精簡成一句話`);
  return text;
}

function parseSources(json: string | null): string[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

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

  /**
   * 多裝置同步用（sync/）：在交易中直接執行 SQL。fn 裡只能用傳入的 sql，
   * 不能呼叫 Db 的其他方法（它們也要排隊，會互相等待）
   */
  syncTransaction<T>(fn: (sql: Pick<SqlDriver, "all" | "run">) => Promise<T>): Promise<T> {
    return this.tx(() => fn({ all: (q, p) => this.driver.all(q, p), run: (q, p) => this.driver.run(q, p) }));
  }

  /**
   * 別台已經對這趟跑步產生過的分析（多裝置同步傳來、這台當時還沒有這趟跑步而暫存的）；
   * 同步 Intervals.icu 存進這趟時直接用它，不再花費用產生
   */
  async syncedSummaryFor(intervalsId: string): Promise<string | null> {
    const row = await this.get<{ data: string }>("SELECT data FROM sync_pending WHERE key=?", [`ws:i${intervalsId}`]);
    if (!row) return null;
    try {
      const data = JSON.parse(row.data) as { s?: unknown };
      return typeof data.s === "string" && data.s ? data.s : null;
    } catch {
      return null;
    }
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

      // --- Migration: training_plans 的結構化欄位（schema 7）；舊的文字課表這些欄位是 NULL ---
      const planCols = await columns("training_plans");
      for (const col of ["week_start", "style", "reason", "outline", "notes"]) {
        if (!planCols.has(col)) await d.exec(`ALTER TABLE training_plans ADD COLUMN ${col} TEXT`);
      }

      // --- Migration: conversations.sources（schema 6：回覆的依據） ---
      if (!(await columns("conversations")).has("sources")) await d.exec("ALTER TABLE conversations ADD COLUMN sources TEXT");

      // --- Migration: workouts.training_load ---
      if (!workoutCols.has("training_load")) {
        await d.exec("ALTER TABLE workouts ADD COLUMN training_load INTEGER");
        // 既有紀錄從 raw_json 回填
        await d.exec(
          "UPDATE workouts SET training_load = json_extract(raw_json, '$.icu_training_load')" +
            " WHERE json_valid(raw_json)",
        );
      }

      // --- Migration: sync_id（schema 9：多裝置同步時跨裝置不變的 id，同步時才補上） ---
      for (const table of ["races", "training_plans", "planned_sessions"]) {
        if (!(await columns(table)).has("sync_id")) await d.exec(`ALTER TABLE ${table} ADD COLUMN sync_id TEXT`);
        await d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_sync_id ON ${table}(sync_id)`);
      }
      // --- Migration: conversations.archived、reply_to（schema 10：壓縮後保留原文、回覆） ---
      const conversationCols = await columns("conversations");
      if (!conversationCols.has("archived")) await d.exec("ALTER TABLE conversations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
      if (!conversationCols.has("reply_to")) await d.exec("ALTER TABLE conversations ADD COLUMN reply_to TEXT");
      await d.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_sync_id ON memories(sync_id)");

      // --- Migration: races.outcome、outcome_reason（schema 11：完賽、沒有完賽、沒有出賽，規格 12.15） ---
      const raceCols = await columns("races");
      if (!raceCols.has("outcome")) {
        await d.exec("ALTER TABLE races ADD COLUMN outcome TEXT");
        await d.exec("ALTER TABLE races ADD COLUMN outcome_reason TEXT");
        // 舊的「已取消」是沒有出賽（原因不明）；有成績的是完賽
        await d.exec("UPDATE races SET outcome='dns', outcome_reason='other' WHERE cancelled=1");
        await d.exec("UPDATE races SET outcome='finished' WHERE outcome IS NULL AND result_time IS NOT NULL AND result_time != ''");
      }
      // result_time 是個人成績（淨時間）；gun_time 是大會成績（槍聲，選填）；result_source 成績從哪裡來；
      // result_activity 比賽當天那趟跑步的 intervals_id（跨裝置不變），之後的賽後分析用
      for (const col of ["gun_time", "result_source", "result_activity"]) {
        if (!raceCols.has(col)) await d.exec(`ALTER TABLE races ADD COLUMN ${col} TEXT`);
      }

      // --- Migration: planned_sessions.sport、done_at（schema 12：交叉訓練的運動、選手回報做完了，規格 12.24） ---
      const sessionCols = await columns("planned_sessions");
      for (const col of ["sport", "done_at"]) {
        if (!sessionCols.has(col)) await d.exec(`ALTER TABLE planned_sessions ADD COLUMN ${col} TEXT`);
      }
      // --- Migration: planned_sessions.edited_at（schema 14：只改一堂課的內容，規格 12.31） ---
      if (!sessionCols.has("edited_at")) await d.exec("ALTER TABLE planned_sessions ADD COLUMN edited_at TEXT");

      // --- Migration: races.sport（schema 13：賽事的運動；NULL 是跑步） ---
      if (!(await columns("races")).has("sport")) await d.exec("ALTER TABLE races ADD COLUMN sport TEXT");
      // --- Migration: races 的地點與起跑時間（schema 15：比賽地點的天氣，規格 12.31） ---
      const raceCols15 = await columns("races");
      for (const [col, type] of [["place_label", "TEXT"], ["place_lat", "REAL"], ["place_lon", "REAL"], ["start_time", "TEXT"]] as const) {
        if (!raceCols15.has(col)) await d.exec(`ALTER TABLE races ADD COLUMN ${col} ${type}`);
      }

      // 對話依時間排序（多裝置同步時 id 的先後不等於時間的先後）
      await d.exec("CREATE INDEX IF NOT EXISTS idx_conversations_time ON conversations(timestamp, id)");
      // 每一筆看過的最新版本號：伺服器送回舊的版本時拒絕
      if (!(await columns("sync_state")).has("v")) await d.exec("ALTER TABLE sync_state ADD COLUMN v INTEGER NOT NULL DEFAULT 0");

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
    return this.all<Race>(`SELECT * FROM races WHERE date >= ? AND date <= ? AND ${NO_OUTCOME} ORDER BY date`, [
      today,
      addDays(today, days),
    ]);
  }

  /** 過去 N 天內已結束、尚未記錄成績且未取消的賽事（供賽後補登成績） */
  getPastRacesWithoutResult(days: number): Promise<Race[]> {
    const today = this.clock.today();
    return this.all<Race>(
      `SELECT * FROM races WHERE date < ? AND date >= ? AND ${NO_OUTCOME} ORDER BY date DESC`,
      [today, addDays(today, -days)],
    );
  }

  /** 全部賽事（含已結束、沒有出賽），供介面列表與 list_races 使用 */
  getAllRaces(): Promise<Race[]> {
    return this.all<Race>("SELECT * FROM races ORDER BY date DESC, id DESC");
  }

  getRace(id: number): Promise<Race | null> {
    return this.get<Race>("SELECT * FROM races WHERE id=?", [id]);
  }

  async addRace(race: {
    name: string;
    date: string;
    distance_km: number;
    target_time?: string;
    confirmed?: number;
    notes?: string;
    /** run 跑步（預設，存成 NULL）、ride 騎車 */
    sport?: string | null;
    /** 比賽的地點（只用來查天氣）與起跑時間，選填 */
    place_label?: string | null;
    place_lat?: number | null;
    place_lon?: number | null;
    start_time?: string | null;
  }): Promise<number> {
    const result = await this.run(
      "INSERT INTO races (name, date, distance_km, target_time, confirmed, notes, created_at, sport, place_label, place_lat, place_lon, start_time)" +
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        race.name,
        race.date,
        race.distance_km,
        race.target_time || null,
        race.confirmed ?? 1,
        race.notes || null,
        this.stamp(),
        race.sport && race.sport !== "run" ? race.sport : null,
        race.place_lat != null && race.place_lon != null ? (race.place_label ?? null) : null,
        race.place_lat != null && race.place_lon != null ? race.place_lat : null,
        race.place_lat != null && race.place_lon != null ? race.place_lon : null,
        race.start_time || null,
      ],
    );
    return result.lastInsertRowid;
  }

  /** 只更新有傳入的欄位 */
  async updateRace(raceId: number, fields: RaceUpdate): Promise<void> {
    const updates = RACE_FIELDS.filter((k) => fields[k] !== undefined && (fields[k] !== null || RACE_CLEARABLE.has(k)));
    if (updates.length === 0) return;
    const setClause = updates.map((k) => `${k}=?`).join(", ");
    await this.run(`UPDATE races SET ${setClause} WHERE id=?`, [...updates.map((k) => fields[k] ?? null), raceId]);
  }

  /**
   * 賽事的結局（規則見 races.ts）：完賽寫成績，沒有完賽與沒有出賽清掉成績.
   * 沒有出賽同時設 cancelled=1，v1 與舊的查詢照樣把它當成取消
   */
  async setRaceOutcome(
    raceId: number,
    outcome: RaceOutcome,
    fields: { resultTime?: string | null; gunTime?: string | null; source?: string | null; activity?: string | null; reason?: string | null } = {},
  ): Promise<void> {
    const finished = outcome === "finished";
    await this.run(
      "UPDATE races SET outcome=?, outcome_reason=?, result_time=?, gun_time=?, result_source=?, result_activity=?, cancelled=? WHERE id=?",
      [
        outcome,
        fields.reason || null,
        finished ? (fields.resultTime ?? null) : null,
        finished ? (fields.gunTime ?? null) : null,
        finished ? (fields.source ?? null) : null,
        outcome === "dns" ? null : (fields.activity ?? null),
        outcome === "dns" ? 1 : 0,
        raceId,
      ],
    );
  }

  /** 刪除一場賽事（只有選手能刪，見 races.ts） */
  async deleteRace(raceId: number): Promise<boolean> {
    return (await this.run("DELETE FROM races WHERE id=?", [raceId])).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // conversations
  // ---------------------------------------------------------------------------

  /** sources：教練回覆前讀過的資料，沒有時不存；replyTo：選手回覆的那一則 */
  async appendConversation(role: "user" | "assistant", content: string, sources: string[] = [], replyTo: ReplyRef | null = null): Promise<number> {
    const result = await this.run("INSERT INTO conversations (role, content, timestamp, sources, reply_to) VALUES (?, ?, ?, ?, ?)", [
      role,
      content,
      this.stamp(),
      sources.length ? JSON.stringify(sources) : null,
      replyTo ? JSON.stringify({ ...replyTo, text: replyTo.text.slice(0, REPLY_EXCERPT_CHARS) }) : null,
    ]);
    return result.lastInsertRowid;
  }

  /** 最近、還沒整理進摘要的對話，舊的在前；附上教練回覆的依據 */
  async getRecentConversations(limit: number): Promise<ConversationRow[]> {
    const rows = await this.all<StoredConversation>(
      `SELECT ${CONVERSATION_COLS} FROM conversations WHERE archived=0 ORDER BY timestamp DESC, id DESC LIMIT ?`,
      [limit],
    );
    return rows.reverse().map(conversationOf);
  }

  /**
   * 對話頁一次讀一段（含已整理進摘要的），舊的在前. before 是目前畫面上最舊的那一則，沒有時讀最新的
   */
  async getConversationPage(limit: number, before: { timestamp: string; id: number } | null = null): Promise<ConversationRow[]> {
    const rows = await this.all<StoredConversation>(
      before
        ? `SELECT ${CONVERSATION_COLS} FROM conversations WHERE (timestamp, id) < (?, ?) ORDER BY timestamp DESC, id DESC LIMIT ?`
        : `SELECT ${CONVERSATION_COLS} FROM conversations ORDER BY timestamp DESC, id DESC LIMIT ?`,
      before ? [before.timestamp, before.id, limit] : [limit],
    );
    return rows.reverse().map(conversationOf);
  }

  /** 一則訊息（含已整理進摘要的） */
  async getConversation(id: number): Promise<ConversationRow | null> {
    const row = await this.get<StoredConversation>(`SELECT ${CONVERSATION_COLS} FROM conversations WHERE id=?`, [id]);
    return row ? conversationOf(row) : null;
  }

  /**
   * 找較早的對話（含已整理進摘要的）：傳送時間介於 fromUtc 與 toUtc（不含）之間、內容包含 keyword.
   * 符合的超過 limit 時取最新的 limit 則；舊的在前
   */
  async searchConversations(q: { fromUtc?: string; toUtc?: string; keyword?: string; limit: number }): Promise<ConversationRow[]> {
    const where: string[] = [];
    const params: SqlValue[] = [];
    if (q.fromUtc) {
      where.push("timestamp >= ?");
      params.push(q.fromUtc);
    }
    if (q.toUtc) {
      where.push("timestamp < ?");
      params.push(q.toUtc);
    }
    if (q.keyword) {
      where.push("content LIKE ? ESCAPE '\\'");
      params.push(`%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    }
    const rows = await this.all<StoredConversation>(
      `SELECT ${CONVERSATION_COLS} FROM conversations${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY timestamp DESC, id DESC LIMIT ?`,
      [...params, q.limit],
    );
    return rows.reverse().map(conversationOf);
  }

  /** 還沒整理進摘要的對話則數（超過上限時壓縮） */
  countConversations(): Promise<number> {
    return this.count("SELECT COUNT(*) AS n FROM conversations WHERE archived=0");
  }

  /** 最舊的幾則還沒整理進摘要的對話（壓縮用） */
  getOldestConversations(n: number): Promise<ConversationRow[]> {
    return this.all<ConversationRow>("SELECT id, role, content, timestamp FROM conversations WHERE archived=0 ORDER BY timestamp, id LIMIT ?", [n]);
  }

  // ---------------------------------------------------------------------------
  // memories（記住的事）
  // ---------------------------------------------------------------------------

  /** 記住的事，依建立時間 */
  getMemories(): Promise<Memory[]> {
    return this.all<Memory>("SELECT id, content, source, created_at, updated_at FROM memories ORDER BY created_at, id");
  }

  /** 新增一條；超過上限或太長時丟出錯誤（訊息給選手或教練看） */
  async addMemory(content: string, source: Memory["source"]): Promise<number> {
    const text = memoryText(content);
    const d = this.driver;
    return this.tx(async () => {
      const n = Number((await d.all("SELECT COUNT(*) AS n FROM memories"))[0]?.n ?? 0);
      if (n >= MEMORY_MAX_ITEMS) throw new Error(`記住的事已經有 ${MEMORY_MAX_ITEMS} 條（上限），請先刪掉或合併幾條`);
      const stamp = this.stamp();
      const { lastInsertRowid } = await d.run(
        "INSERT INTO memories (sync_id, content, source, created_at, updated_at) VALUES (lower(hex(randomblob(16))), ?, ?, ?, ?)",
        [text, source, stamp, stamp],
      );
      return lastInsertRowid;
    });
  }

  async updateMemory(id: number, content: string): Promise<boolean> {
    const result = await this.run("UPDATE memories SET content=?, updated_at=? WHERE id=?", [memoryText(content), this.stamp(), id]);
    return result.changes > 0;
  }

  async deleteMemory(id: number): Promise<boolean> {
    return (await this.run("DELETE FROM memories WHERE id=?", [id])).changes > 0;
  }

  // ---------------------------------------------------------------------------
  // summaries
  // ---------------------------------------------------------------------------

  getLatestSummary(): Promise<SummaryRow | null> {
    return this.get<SummaryRow>("SELECT * FROM summaries ORDER BY created_at DESC, id DESC LIMIT 1");
  }

  /**
   * 一次取出最新摘要與尚未壓縮的對話。
   * 兩者必須在同一個時間點讀取：背景壓縮若剛好落在兩次讀取之間，
   * 被壓縮掉的對話會既不在舊摘要、也不在對話視窗中。
   */
  getMemorySnapshot(limit: number): Promise<{ summary: SummaryRow | null; conversations: ConversationRow[] }> {
    return this.serial(async () => {
      const summary = (await this.driver.all("SELECT * FROM summaries ORDER BY created_at DESC, id DESC LIMIT 1"))[0];
      const rows = await this.driver.all(
        `SELECT ${CONVERSATION_COLS} FROM conversations WHERE archived=0 ORDER BY timestamp DESC, id DESC LIMIT ?`,
        [limit],
      );
      return {
        summary: (summary as SummaryRow | undefined) ?? null,
        conversations: (rows as unknown as StoredConversation[]).reverse().map(conversationOf),
      };
    });
  }

  /**
   * 存入新摘要（只保留最新一筆），並把已被摘要涵蓋的對話標成已整理：依時間排在 coversUpToId 那一則（含）之前的.
   * 原文保留，對話頁看得到、教練可以用 search_conversations 找；教練每次帶入的只有摘要與還沒整理的對話.
   * 對話的先後一律看時間，不看 id：多裝置同步時，別台較早的訊息可能較晚才寫進這台
   */
  applyCompression(summaryText: string, coversUpToId: number): Promise<void> {
    const d = this.driver;
    return this.tx(async () => {
      await d.run("INSERT INTO summaries (content, covers_up_to_id, created_at) VALUES (?, ?, ?)", [
        summaryText,
        coversUpToId,
        this.stamp(),
      ]);
      await d.exec("DELETE FROM summaries WHERE id NOT IN (SELECT id FROM summaries ORDER BY created_at DESC, id DESC LIMIT 1)");
      await d.run(
        "UPDATE conversations SET archived=1 WHERE archived=0 AND (timestamp, id) <= (SELECT timestamp, id FROM conversations WHERE id=?)",
        [coversUpToId],
      );
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

  /**
   * 目前的課表：啟用中、而且這週就是今天所在那週的優先（先排好的下週課表不會蓋掉這週的）；
   * 沒有的話用最新的一份。依建立時間：多裝置同步時，別台較早的課表可能較晚才寫進這台
   */
  getActiveTrainingPlan(): Promise<TrainingPlan | null> {
    const today = this.clock.today();
    return this.get<TrainingPlan>(
      "SELECT * FROM training_plans WHERE is_active=1" +
        " ORDER BY (week_start IS NOT NULL AND week_start <= ? AND week_start >= ?) DESC, created_at DESC, id DESC LIMIT 1",
      [today, addDays(today, -6)],
    );
  }

  /** 已經排好、還沒開始的下一週課表（啟用中、週一在今天之後） */
  getNextTrainingPlan(): Promise<TrainingPlan | null> {
    return this.get<TrainingPlan>(
      "SELECT * FROM training_plans WHERE is_active=1 AND week_start > ? ORDER BY week_start, created_at DESC, id DESC LIMIT 1",
      [this.clock.today()],
    );
  }

  getTrainingPlan(id: number): Promise<TrainingPlan | null> {
    return this.get<TrainingPlan>("SELECT * FROM training_plans WHERE id=?", [id]);
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

  /**
   * 儲存結構化的課表，回傳新計畫的 id. 停用同一週的舊版本、文字課表與已經過完的週；
   * 排的是下週時，這週的課表繼續啟用（週日排下週，這週剩下的課不會消失）
   */
  saveStructuredPlan(
    plan: { weekLabel: string; weekStart: string; style: PlanStyle; reason: string; outline: string | null; notes: string | null; content: string },
    sessions: SessionDraft[],
  ): Promise<number> {
    const d = this.driver;
    return this.tx(async () => {
      await d.run("UPDATE training_plans SET is_active=0 WHERE week_start IS NULL OR week_start = ? OR week_start < ?", [
        plan.weekStart,
        addDays(this.clock.today(), -6),
      ]);
      const { lastInsertRowid: planId } = await d.run(
        "INSERT INTO training_plans (week_label, content, created_at, is_active, week_start, style, reason, outline, notes)" +
          " VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)",
        [plan.weekLabel, plan.content, this.stamp(), plan.weekStart, plan.style, plan.reason, plan.outline, plan.notes],
      );
      for (const [i, s] of sessions.entries()) {
        await d.run(
          "INSERT INTO planned_sessions (plan_id, position, date, kind, title, steps, purpose, success, fallback, sport, updated_at)" +
            " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [planId, i, s.date, s.kind, s.title, JSON.stringify(s.steps), s.purpose, s.success, s.fallback, s.sport ?? null, this.stamp()],
        );
      }
      return planId;
    });
  }

  /** 每週最新的一份結構化課表（週一在 since 之後的），舊的在前；依結果調整配速時看最近幾週 */
  getWeeklyPlansSince(since: string): Promise<TrainingPlan[]> {
    return this.all<TrainingPlan>(
      "SELECT * FROM training_plans p WHERE week_start IS NOT NULL AND week_start >= ?" +
        " AND id = (SELECT id FROM training_plans q WHERE q.week_start = p.week_start ORDER BY created_at DESC, id DESC LIMIT 1)" +
        " ORDER BY week_start",
      [since],
    );
  }

  async getPlannedSessions(planId: number): Promise<PlannedSession[]> {
    const rows = await this.all<Omit<PlannedSession, "steps"> & { steps: string }>(
      "SELECT id, plan_id, date, kind, title, steps, purpose, success, fallback, status, note, sport, done_at, edited_at FROM planned_sessions WHERE plan_id=? ORDER BY position",
      [planId],
    );
    return rows.map((r) => ({ ...r, steps: parseJsonArray(r.steps) as PlannedSession["steps"] }));
  }

  async getPlannedSession(id: number): Promise<PlannedSession | null> {
    const row = await this.get<Omit<PlannedSession, "steps"> & { steps: string }>(
      "SELECT id, plan_id, date, kind, title, steps, purpose, success, fallback, status, note, sport, done_at, edited_at FROM planned_sessions WHERE id=?",
      [id],
    );
    return row ? { ...row, steps: parseJsonArray(row.steps) as PlannedSession["steps"] } : null;
  }

  async updatePlannedSession(
    id: number,
    fields: { date?: string | null; status?: SessionStatus; note?: string | null; done_at?: string | null },
  ): Promise<void> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    for (const key of ["date", "status", "note", "done_at"] as const) {
      if (fields[key] !== undefined) {
        sets.push(`${key}=?`);
        params.push(fields[key] ?? null);
      }
    }
    if (!sets.length) return;
    await this.run(`UPDATE planned_sessions SET ${sets.join(", ")}, updated_at=? WHERE id=?`, [...params, this.stamp(), id]);
  }

  /** 改一堂課的內容（日期不變）：恢復成照計畫、記下原因與修改的時間 */
  async editPlannedSessionContent(id: number, draft: Omit<SessionDraft, "date">, note: string): Promise<void> {
    const stamp = this.stamp();
    await this.run(
      "UPDATE planned_sessions SET kind=?, title=?, steps=?, purpose=?, success=?, fallback=?, sport=?, status='planned', note=?, edited_at=?, updated_at=? WHERE id=?",
      [draft.kind, draft.title, JSON.stringify(draft.steps), draft.purpose, draft.success, draft.fallback, draft.sport ?? null, note, stamp, stamp, id],
    );
  }

  /** 改了單堂課之後，更新計畫的文字版 */
  async updatePlanContent(planId: number, content: string): Promise<void> {
    await this.run("UPDATE training_plans SET content=? WHERE id=?", [content, planId]);
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
        existing = (await d.all("SELECT id, removed_at FROM workouts WHERE intervals_id=?", [intervalsId]))[0];
      } else if (stravaId) {
        existing = (await d.all("SELECT id, removed_at FROM workouts WHERE strava_id=?", [stravaId]))[0];
      }

      if (existing) {
        let workoutId = Number(existing.id);
        // 已移除的又被存到（例如跑後回報選了它）：先恢復，存到保留的那筆
        if (existing.removed_at) workoutId = (await this.restoreInTx(workoutId)).id;
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
  /** 某一天的跑步（不含重複與已移除的），比賽當天的手錶紀錄用 */
  getWorkoutsOn(date: string): Promise<Workout[]> {
    return this.all<Workout>(`SELECT * FROM workouts w WHERE date = ? AND ${ACTIVE} ORDER BY id`, [date]);
  }

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

  /**
   * 在交易中：dupId 標為 keepId 的重複，原本指向 dupId 的也改指向 keepId。
   * 保留的那筆沒有體感或 AI 分析時，從重複的那筆帶過來
   */
  private async attachDuplicate(keepId: number, dupId: number): Promise<void> {
    const d = this.driver;
    await d.run("UPDATE workouts SET duplicate_of = ? WHERE id = ? OR duplicate_of = ?", [keepId, dupId, dupId]);
    await this.inheritFrom(keepId, dupId);
  }

  /** 在交易中：toId 沒有體感或 AI 分析時，從 fromId 帶過來 */
  private async inheritFrom(toId: number, fromId: number): Promise<void> {
    const d = this.driver;
    await d.run(
      `UPDATE workouts SET
         perceived_effort = COALESCE(perceived_effort, (SELECT perceived_effort FROM workouts WHERE id = ?)),
         subjective_notes = COALESCE(subjective_notes, (SELECT subjective_notes FROM workouts WHERE id = ?))
       WHERE id = ?`,
      [fromId, fromId, toId],
    );
    const own = await d.all("SELECT 1 FROM workout_summaries WHERE workout_id = ? LIMIT 1", [toId]);
    if (!own.length) await d.run("UPDATE workout_summaries SET workout_id = ? WHERE workout_id = ?", [toId, fromId]);
  }

  /** 在交易中：恢復已移除的一筆，當成單獨的一筆重新判斷是否和其他紀錄是同一趟 */
  private async restoreInTx(id: number): Promise<SaveResult> {
    const d = this.driver;
    await d.run("UPDATE workouts SET removed_at = NULL, duplicate_of = NULL WHERE id = ?", [id]);
    const row = ((await d.all(
      `SELECT id, date, distance_km, duration_min, avg_hr, training_load, raw_json, perceived_effort, subjective_notes
         FROM workouts WHERE id = ?`,
      [id],
    )) as unknown as WorkoutRow[])[0]!;
    const match = await this.findSameRun(row, id);
    return match ? this.resolveSameRun(id, row, match) : { id, status: "existing" };
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
        await this.inheritFrom(heir.id, removed.id);
      }
      return missing.filter((r) => r.duplicate_of === null).length;
    });
  }

  /** 已移除的又出現了（例如類型改回跑步）：恢復，並重新判斷是否和其他紀錄是同一趟 */
  restoreWorkout(id: number): Promise<SaveResult> {
    return this.tx(() => this.restoreInTx(id));
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

  /** 最近 N 筆恢復資料的原始資料（含 Intervals.icu 的體能與疲勞），新的在前 */
  getWellnessRaw(limit: number): Promise<{ date: string; raw_json: string | null }[]> {
    return this.all("SELECT date, raw_json FROM wellness ORDER BY date DESC LIMIT ?", [limit]);
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
  // other_activities：跑步以外的運動，同步時整批更新，跟著來源的刪除
  // ---------------------------------------------------------------------------

  async upsertOtherActivities(list: OtherActivity[]): Promise<void> {
    for (const a of list) {
      await this.run(
        `INSERT INTO other_activities (intervals_id, date, type, duration_min, distance_km, avg_hr, training_load, raw_json, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(intervals_id) DO UPDATE SET
           date=excluded.date, type=excluded.type, duration_min=excluded.duration_min, distance_km=excluded.distance_km,
           avg_hr=excluded.avg_hr, training_load=excluded.training_load, raw_json=excluded.raw_json, synced_at=excluded.synced_at`,
        [a.intervals_id, a.date, a.type, a.duration_min, a.distance_km, a.avg_hr, a.training_load, a.raw_json ?? null, this.stamp()],
      );
    }
  }

  /** 範圍內本機有、這次沒拿到的（在來源已刪除）直接刪掉：這些紀錄沒有選手填的內容 */
  async removeOtherActivitiesMissing(seenIds: string[], since: string, until: string): Promise<void> {
    const placeholders = seenIds.map(() => "?").join(", ");
    await this.run(
      `DELETE FROM other_activities WHERE date >= ? AND date <= ?${seenIds.length ? ` AND intervals_id NOT IN (${placeholders})` : ""}`,
      [since, until, ...seenIds],
    );
  }

  /** 最近 N 天跑步以外的運動，新的在前 */
  getOtherActivities(days: number): Promise<OtherActivity[]> {
    return this.all<OtherActivity>(
      "SELECT o.intervals_id, o.date, o.type, o.duration_min, o.distance_km, o.avg_hr, o.training_load, o.raw_json, f.perceived_effort, f.subjective_notes" +
        " FROM other_activities o LEFT JOIN activity_feedback f ON f.intervals_id = o.intervals_id WHERE o.date >= ? ORDER BY o.date DESC",
      [addDays(this.clock.today(), -days)],
    );
  }

  /** 存了幾筆跑步以外的運動（只練騎車的人的新手引導用） */
  async countOtherActivities(): Promise<number> {
    const rows = await this.all<{ n: number }>("SELECT COUNT(*) AS n FROM other_activities");
    return Number(rows[0]?.n ?? 0);
  }

  /** 跑步以外的一筆運動（含回報的體感）；找不到時為 null */
  async getOtherActivity(intervalsId: string): Promise<OtherActivity | null> {
    const rows = await this.all<OtherActivity>(
      "SELECT o.intervals_id, o.date, o.type, o.duration_min, o.distance_km, o.avg_hr, o.training_load, o.raw_json, f.perceived_effort, f.subjective_notes" +
        " FROM other_activities o LEFT JOIN activity_feedback f ON f.intervals_id = o.intervals_id WHERE o.intervals_id = ?",
      [intervalsId],
    );
    return rows[0] ?? null;
  }

  /** 騎車等其他運動的體感與感受（運動回報）；兩個都是 null 時刪掉 */
  async setActivityFeedback(intervalsId: string, perceivedEffort: number | null, subjectiveNotes: string | null, updatedAt = this.stamp()): Promise<void> {
    if (perceivedEffort === null && !subjectiveNotes) {
      await this.run("DELETE FROM activity_feedback WHERE intervals_id=?", [intervalsId]);
      return;
    }
    await this.run(
      "INSERT INTO activity_feedback (intervals_id, perceived_effort, subjective_notes, updated_at) VALUES (?, ?, ?, ?)" +
        " ON CONFLICT(intervals_id) DO UPDATE SET perceived_effort=excluded.perceived_effort, subjective_notes=excluded.subjective_notes, updated_at=excluded.updated_at",
      [intervalsId, perceivedEffort, subjectiveNotes, updatedAt],
    );
  }

  // ---------------------------------------------------------------------------
  // source_snapshots：活動來源的設定與統計，每次同步整份換掉
  // ---------------------------------------------------------------------------

  async saveSnapshot(key: string, value: unknown): Promise<void> {
    await this.run(
      "INSERT INTO source_snapshots (key, json, fetched_at) VALUES (?, ?, ?)" +
        " ON CONFLICT(key) DO UPDATE SET json=excluded.json, fetched_at=excluded.fetched_at",
      [key, JSON.stringify(value), this.stamp()],
    );
  }

  async getSnapshot<T>(key: string): Promise<{ value: T; fetched_at: string } | null> {
    const row = await this.get<{ json: string; fetched_at: string }>("SELECT json, fetched_at FROM source_snapshots WHERE key=?", [key]);
    if (!row) return null;
    try {
      return { value: JSON.parse(row.json) as T, fetched_at: row.fetched_at };
    } catch {
      return null;
    }
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
