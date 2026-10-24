/**
 * 同步哪些資料、每一筆在各裝置上叫什麼名字（規格 12.10）.
 *
 * 只同步只存在 App 裡的資料：選手資料、賽事、課表、每日自評、記住的事、對話與對話摘要，以及跑步上的體感、
 * 教練的分析與「不是同一趟」. 從 Intervals.icu 來的跑步、恢復資料、其他運動由各裝置自己同步.
 * API key 與設定不在資料庫裡，不同步.
 *
 * 名稱：選手資料用欄位名、自評用日期、賽事、課表與記住的事用 sync_id（同步時補上的隨機 id）、
 * 對話與摘要用內容的雜湊（內容寫入後不再修改；對話的「已整理」與回覆可以變）、跑步上的資料用 Intervals.icu 的活動 id.
 */
import type { SqlDriver, SqlValue } from "../types";

export type Sql = Pick<SqlDriver, "all" | "run">;
export type EntityData = Record<string, SqlValue>;

/** 掛在跑步上的資料：這台還沒有那趟跑步時先暫存，不因為找不到就當成刪除 */
export const isAttached = (name: string) => /^(w|ws|wd):/.test(name);

/** 這個版本認得的種類；新版本才有的種類，這台不套用、也不會當成刪除送出 */
export const isKnown = (name: string) => /^(p|r|pl|ps|ck|c|cs|m|w|ws|wd):/.test(name);

/** 排序後的 JSON：同樣的內容一定得到同樣的字串 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
    .join(",")}}`;
}

async function sha256(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...digest.subarray(0, 16)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const hashOf = (data: EntityData) => sha256(canonical(data));

/** 衝突時比較誰比較新：內容裡的時間欄位；沒有時是 null */
export function modifiedOf(data: EntityData | null): string | null {
  if (!data) return null;
  for (const k of ["updated_at", "u", "at", "timestamp", "created_at"]) {
    if (typeof data[k] === "string") return data[k] as string;
  }
  return null;
}

const RACE_COLS = ["name", "date", "distance_km", "target_time", "confirmed", "result_time", "notes", "cancelled", "outcome", "outcome_reason", "created_at"] as const;
const PLAN_COLS = ["week_label", "content", "created_at", "is_active", "week_start", "style", "reason", "outline", "notes"] as const;
const SESSION_COLS = ["position", "date", "kind", "title", "steps", "purpose", "success", "fallback", "status", "note", "updated_at"] as const;
const CHECKIN_COLS = ["energy", "soreness", "sleep", "notes", "updated_at"] as const;
const MEMORY_COLS = ["content", "source", "created_at", "updated_at"] as const;

const pick = (row: Record<string, SqlValue>, cols: readonly string[]): EntityData => Object.fromEntries(cols.map((c) => [c, row[c] ?? null]));

/** 跑步在各裝置上共通的名字：Intervals.icu 的活動 id，舊的 Strava 紀錄用 Strava 的 id */
const workoutKey = (row: Record<string, SqlValue>) => (row.intervals_id ? `i${row.intervals_id}` : row.strava_id ? `s${row.strava_id}` : null);

export interface Snapshot {
  data: Map<string, EntityData>;
  /** 對話與摘要的名稱 → 這台的 id（刪除時用） */
  local: Map<string, number>;
}

/** 兩筆內容相同（id 與建立時間以外）時視為同一筆 */
const same = (cols: readonly string[]) => cols.map((c) => `o.${c} IS t.${c}`).join(" AND ");

/**
 * 合併重複的賽事、課表與課：兩台各自有同一份資料（例如之前用匯出、匯入搬過去，或兩台各自新增了同一場賽事），
 * 加入同步時各自有不同的 sync_id，合併後就會出現兩份. 內容相同的只留 sync_id 最小的一份
 * （各台的判斷一致），其他的刪掉，下次送出時成為刪除，別台也跟著刪.
 * 課表重複時，被刪的那份的課先移到留下的那份，再依日期、順序、種類與標題合併，留下最近更新的
 */
async function mergeDuplicates(sql: Sql): Promise<void> {
  const raceCols = RACE_COLS.filter((c) => c !== "created_at");
  await sql.run(`DELETE FROM races AS t WHERE EXISTS (SELECT 1 FROM races o WHERE o.sync_id < t.sync_id AND ${same(raceCols)})`);

  const planCols = PLAN_COLS.filter((c) => c !== "created_at" && c !== "is_active");
  const plans = await sql.all(
    `SELECT t.id AS dup, (SELECT o.id FROM training_plans o WHERE o.sync_id < t.sync_id AND ${same(planCols)} ORDER BY o.sync_id LIMIT 1) AS keep` +
      " FROM training_plans t",
  );
  for (const row of plans) {
    const [dup, keep] = [row.dup ?? null, row.keep ?? null];
    if (keep === null || dup === null) continue;
    await sql.run("UPDATE planned_sessions SET plan_id=? WHERE plan_id=?", [keep, dup]);
    await sql.run("UPDATE training_plans SET is_active = MAX(is_active, (SELECT is_active FROM training_plans WHERE id=?)) WHERE id=?", [dup, keep]);
    await sql.run("DELETE FROM training_plans WHERE id=?", [dup]);
  }

  await sql.run("DELETE FROM memories AS t WHERE EXISTS (SELECT 1 FROM memories o WHERE o.sync_id < t.sync_id AND o.content IS t.content)");

  const sessionKey = ["plan_id", "position", "date", "kind", "title"].map((c) => `o.${c} IS t.${c}`).join(" AND ");
  await sql.run(
    `DELETE FROM planned_sessions AS t WHERE EXISTS (SELECT 1 FROM planned_sessions o WHERE ${sessionKey}` +
      " AND (o.updated_at > t.updated_at OR (o.updated_at = t.updated_at AND o.sync_id < t.sync_id)))",
  );
}

/** 這台目前的資料；先替還沒有 sync_id 的賽事與課表補上，合併重複的 */
export async function snapshot(sql: Sql): Promise<Snapshot> {
  for (const table of ["races", "training_plans", "planned_sessions", "memories"]) {
    await sql.run(`UPDATE ${table} SET sync_id = lower(hex(randomblob(16))) WHERE sync_id IS NULL`);
  }
  await mergeDuplicates(sql);
  const data = new Map<string, EntityData>();
  const local = new Map<string, number>();

  for (const r of await sql.all("SELECT key, value, updated_at FROM athlete_profile")) {
    data.set(`p:${r.key}`, { v: r.value ?? null, u: r.updated_at ?? null });
  }
  for (const r of await sql.all("SELECT * FROM races")) data.set(`r:${r.sync_id}`, pick(r, RACE_COLS));
  for (const r of await sql.all("SELECT * FROM training_plans")) data.set(`pl:${r.sync_id}`, pick(r, PLAN_COLS));
  for (const r of await sql.all("SELECT s.*, p.sync_id AS plan FROM planned_sessions s JOIN training_plans p ON p.id = s.plan_id")) {
    data.set(`ps:${r.sync_id}`, { plan: r.plan ?? null, ...pick(r, SESSION_COLS) });
  }
  for (const r of await sql.all("SELECT * FROM daily_checkins")) data.set(`ck:${r.date}`, pick(r, CHECKIN_COLS));
  for (const r of await sql.all("SELECT * FROM memories")) data.set(`m:${r.sync_id}`, pick(r, MEMORY_COLS));
  for (const r of await sql.all("SELECT id, role, content, timestamp, sources, archived, reply_to FROM conversations")) {
    const entity: EntityData = { role: r.role ?? null, content: r.content ?? null, timestamp: r.timestamp ?? null, sources: r.sources ?? null };
    // 只在有值時才放：之前版本同步過的對話內容不變，不必全部重送
    if (r.archived) entity.archived = 1;
    if (r.reply_to) entity.reply_to = r.reply_to;
    const name = `c:${await sha256(canonical({ role: entity.role, content: entity.content, timestamp: entity.timestamp }))}`;
    data.set(name, entity);
    local.set(name, Number(r.id));
  }
  for (const r of await sql.all("SELECT id, content, created_at FROM summaries")) {
    const entity = { content: r.content ?? null, created_at: r.created_at ?? null };
    const name = `cs:${await sha256(canonical(entity))}`;
    data.set(name, entity);
    local.set(name, Number(r.id));
  }

  // 跑步上的資料
  const workouts = await sql.all("SELECT id, intervals_id, strava_id, perceived_effort, subjective_notes FROM workouts WHERE removed_at IS NULL");
  const keyById = new Map<number, string>();
  for (const w of workouts) {
    const key = workoutKey(w);
    if (!key) continue;
    keyById.set(Number(w.id), key);
    if (w.perceived_effort !== null || w.subjective_notes !== null) data.set(`w:${key}`, { e: w.perceived_effort ?? null, n: w.subjective_notes ?? null });
  }
  for (const r of await sql.all(
    "SELECT workout_id, summary, created_at FROM workout_summaries s WHERE id = (SELECT MAX(id) FROM workout_summaries WHERE workout_id = s.workout_id)",
  )) {
    const key = keyById.get(Number(r.workout_id));
    if (key) data.set(`ws:${key}`, { s: r.summary ?? null, at: r.created_at ?? null });
  }
  for (const r of await sql.all("SELECT a, b FROM workout_distinct")) {
    const [ka, kb] = [keyById.get(Number(r.a)), keyById.get(Number(r.b))];
    if (ka && kb) data.set(`wd:${[ka, kb].sort().join("|")}`, {});
  }
  return { data, local };
}

async function workoutId(sql: Sql, key: string): Promise<number | null> {
  const column = key.startsWith("i") ? "intervals_id" : "strava_id";
  const row = (await sql.all(`SELECT id FROM workouts WHERE ${column}=? AND removed_at IS NULL ORDER BY duplicate_of IS NOT NULL, id LIMIT 1`, [key.slice(1)]))[0];
  return row ? Number(row.id) : null;
}

async function upsert(sql: Sql, table: string, syncId: string, row: EntityData): Promise<void> {
  const cols = Object.keys(row);
  const values = cols.map((c) => row[c] ?? null);
  const updated = await sql.run(`UPDATE ${table} SET ${cols.map((c) => `${c}=?`).join(", ")} WHERE sync_id=?`, [...values, syncId]);
  if (updated.changes === 0) {
    await sql.run(`INSERT INTO ${table} (${cols.join(", ")}, sync_id) VALUES (${cols.map(() => "?").join(", ")}, ?)`, [...values, syncId]);
  }
}

/**
 * 套用別台的一筆（data 是 null 表示刪除）. 回傳 "pending"：這台還沒有對應的跑步或課表，先暫存，
 * 之後每次同步再試一次
 */
export async function applyEntity(sql: Sql, name: string, data: EntityData | null, snap: Snapshot): Promise<"applied" | "pending"> {
  const colon = name.indexOf(":");
  const kind = name.slice(0, colon);
  const id = name.slice(colon + 1);
  switch (kind) {
    case "p":
      if (!data) await sql.run("DELETE FROM athlete_profile WHERE key=?", [id]);
      else await sql.run("INSERT OR REPLACE INTO athlete_profile (key, value, updated_at) VALUES (?, ?, ?)", [id, data.v ?? "", data.u ?? ""]);
      return "applied";
    case "r":
      if (!data) await sql.run("DELETE FROM races WHERE sync_id=?", [id]);
      else await upsert(sql, "races", id, pick(data, RACE_COLS));
      return "applied";
    case "pl":
      if (!data) {
        await sql.run("DELETE FROM planned_sessions WHERE plan_id IN (SELECT id FROM training_plans WHERE sync_id=?)", [id]);
        await sql.run("DELETE FROM training_plans WHERE sync_id=?", [id]);
      } else await upsert(sql, "training_plans", id, pick(data, PLAN_COLS));
      return "applied";
    case "ps": {
      if (!data) {
        await sql.run("DELETE FROM planned_sessions WHERE sync_id=?", [id]);
        return "applied";
      }
      const plan = (await sql.all("SELECT id FROM training_plans WHERE sync_id=?", [data.plan ?? ""]))[0];
      if (!plan) return "pending";
      await upsert(sql, "planned_sessions", id, { plan_id: Number(plan.id), ...pick(data, SESSION_COLS) });
      return "applied";
    }
    case "ck":
      if (!data) await sql.run("DELETE FROM daily_checkins WHERE date=?", [id]);
      else {
        await sql.run("INSERT OR REPLACE INTO daily_checkins (date, energy, soreness, sleep, notes, updated_at) VALUES (?, ?, ?, ?, ?, ?)", [
          id,
          data.energy ?? 3,
          data.soreness ?? 3,
          data.sleep ?? 3,
          data.notes ?? null,
          data.updated_at ?? "",
        ]);
      }
      return "applied";
    case "c":
      if (!data) {
        const local = snap.local.get(name);
        if (local !== undefined) await sql.run("DELETE FROM conversations WHERE id=?", [local]);
      } else if (snap.data.has(name)) {
        // 同一則訊息：「依據」與回覆以傳來的為準；已整理進摘要只會從沒有變成有（任一台整理過就算）
        await sql.run("UPDATE conversations SET sources=?, reply_to=COALESCE(?, reply_to), archived=MAX(archived, ?) WHERE id=?", [
          data.sources ?? null,
          data.reply_to ?? null,
          data.archived ? 1 : 0,
          snap.local.get(name) ?? -1,
        ]);
      } else {
        await sql.run("INSERT INTO conversations (role, content, timestamp, sources, archived, reply_to) VALUES (?, ?, ?, ?, ?, ?)", [
          data.role ?? "user",
          data.content ?? "",
          data.timestamp ?? "",
          data.sources ?? null,
          data.archived ? 1 : 0,
          data.reply_to ?? null,
        ]);
      }
      return "applied";
    case "m":
      if (!data) await sql.run("DELETE FROM memories WHERE sync_id=?", [id]);
      else await upsert(sql, "memories", id, pick(data, MEMORY_COLS));
      return "applied";
    case "cs":
      if (!data) {
        const local = snap.local.get(name);
        if (local !== undefined) await sql.run("DELETE FROM summaries WHERE id=?", [local]);
      } else if (!snap.data.has(name)) {
        // 涵蓋到哪一則是各台自己的 id，別台的摘要不記
        await sql.run("INSERT INTO summaries (content, covers_up_to_id, created_at) VALUES (?, NULL, ?)", [data.content ?? "", data.created_at ?? ""]);
      }
      return "applied";
    case "w": {
      const wid = await workoutId(sql, id);
      if (wid === null) return "pending";
      await sql.run("UPDATE workouts SET perceived_effort=?, subjective_notes=? WHERE id=?", [data?.e ?? null, data?.n ?? null, wid]);
      return "applied";
    }
    case "ws": {
      if (!data) return "applied";
      const wid = await workoutId(sql, id);
      if (wid === null) return "pending";
      const latest = (await sql.all("SELECT id, summary FROM workout_summaries WHERE workout_id=? ORDER BY id DESC LIMIT 1", [wid]))[0];
      if (latest?.summary !== data.s) {
        await sql.run("INSERT INTO workout_summaries (workout_id, summary, created_at) VALUES (?, ?, ?)", [wid, data.s ?? "", data.at ?? ""]);
      } else {
        // 內容相同、時間不同（兩台各自產生過）：時間也對齊，否則兩台會一直互相覆蓋
        await sql.run("UPDATE workout_summaries SET created_at=? WHERE id=?", [data.at ?? "", latest!.id ?? -1]);
      }
      return "applied";
    }
    case "wd": {
      const [ka, kb] = id.split("|");
      const [a, b] = [await workoutId(sql, ka ?? ""), await workoutId(sql, kb ?? "")];
      if (a === null || b === null) return data ? "pending" : "applied";
      const [lo, hi] = a < b ? [a, b] : [b, a];
      if (data) await sql.run("INSERT OR IGNORE INTO workout_distinct (a, b) VALUES (?, ?)", [lo, hi]);
      else await sql.run("DELETE FROM workout_distinct WHERE a=? AND b=?", [lo, hi]);
      return "applied";
    }
    default:
      // 新版本才有的種類：舊版略過
      return "applied";
  }
}
