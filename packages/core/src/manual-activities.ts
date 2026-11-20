/**
 * 手動記的活動：沒有紀錄的課的回報（規格 12.48）.
 *
 * 照「紀錄不分來源」：選手回報「做了什麼」（時間、體感、備註）存成一筆 source 是手動的活動紀錄，帶那堂課的 sync_id，
 * 紀錄頁、累積、負荷、比對與教練都從原本讀紀錄的地方讀到它. 課的狀態（done_at）照舊留在課上.
 *
 * 存在哪裡（資料表這一版不搬，和規格 12.37 一樣）：
 * - 跑步：workouts（source manual、sync_id、session_id、completion），和手動新增的跑步同一種，跑量與去重照舊.
 * - 其他運動：other_activities（id 是 manual:<sync_id>，和匯入的檔案 file: 一樣不跟著 Intervals.icu 刪），
 *   體感與備註在 activity_feedback（和其他運動的回報同一處，讀取的地方都不用改）.
 * 同步：整筆一起送，一筆 ma:<sync_id>（device-sync/entities.ts）；舊版不認得這個種類，略過.
 *
 * 這裡的函式都直接用 SQL（已經在交易裡：Db 的交易或同步的交易），不經過 Db 的佇列.
 */
import { sportOfType } from "./sports";
import type { OtherActivity, SqlDriver, SqlValue } from "./types";

type Sql = Pick<SqlDriver, "all" | "run">;

/** 回報一堂沒有紀錄的課時，選手說做到多少：完成、只做了一部分、有改 */
export type Completion = "done" | "partial" | "changed";
export const COMPLETIONS: readonly Completion[] = ["done", "partial", "changed"];
export const COMPLETION_LABELS: Record<Completion, string> = { done: "完成", partial: "做了一部分", changed: "有改" };
export const isCompletion = (v: unknown): v is Completion => typeof v === "string" && (COMPLETIONS as readonly string[]).includes(v);

/** 手動記一筆活動的欄位 */
export interface ManualActivityInput {
  /** 回報的是哪一堂課（planned_sessions.sync_id）；沒有時是 null */
  session_id: string | null;
  /** run、ride、swim、strength、other */
  sport: string;
  date: string;
  duration_min: number;
  /** 跑步、騎車、游泳可以填；沒有時是 null */
  distance_km: number | null;
  perceived_effort: number;
  subjective_notes: string | null;
  completion: Completion;
}

/** 手動記的一筆 */
export interface ManualActivity extends ManualActivityInput {
  /** 跨裝置不變的 id（同步的 ma:<sync_id>） */
  sync_id: string;
  /** 活動的類型（Run、WeightTraining 等，和 Intervals.icu 同一套） */
  type: string;
  /** 跑步：workouts 的 id；其他運動是 null */
  workout_id: number | null;
  /** 其他運動：other_activities 的 id（manual:<sync_id>）；跑步是 null */
  intervals_id: string | null;
  updated_at: string;
}

/** 範圍（回報的檢查與同步套用共用）：時間（分）、距離（km）、備註的字數 */
export const MANUAL_MAX_MINUTES = 24 * 60;
export const MANUAL_MAX_KM = 500;
export const MANUAL_MAX_NOTES = 2000;

/** 手動記的活動用的類型（和 Intervals.icu 的類型同一套，sportOfType 認得） */
export const MANUAL_TYPES: Record<string, string> = { run: "Run", ride: "Ride", swim: "Swim", strength: "WeightTraining", other: "Other" };
/** other_activities 裡手動記的 id 的開頭 */
export const MANUAL_OTHER_PREFIX = "manual:";
export const isManualOtherId = (id: string) => id.startsWith(MANUAL_OTHER_PREFIX);

/** 平均配速（例：6:30/km）；沒有距離時是 null */
function paceOf(distanceKm: number | null, minutes: number): string | null {
  if (!distanceKm || !(distanceKm > 0) || !(minutes > 0)) return null;
  const seconds = Math.round((minutes * 60) / distanceKm);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}/km`;
}

/** 刪一筆跑步：併進它的重複紀錄回到列表上，分析與「不是同一趟」一起刪（和 Db.deleteManualWorkout 一樣） */
async function deleteWorkoutRow(sql: Sql, id: number): Promise<void> {
  await sql.run("UPDATE workouts SET duplicate_of = NULL WHERE duplicate_of = ?", [id]);
  await sql.run("DELETE FROM workout_distinct WHERE a = ? OR b = ?", [id, id]);
  await sql.run("DELETE FROM workout_summaries WHERE workout_id = ?", [id]);
  await sql.run("DELETE FROM workouts WHERE id = ?", [id]);
}

/**
 * 寫入一筆手動記的活動（新增或覆蓋；同步套用也用這裡）. 同一個 sync_id 換了運動（跑步 ↔ 其他）時，先刪掉另一張表的那筆
 */
export async function writeManualActivity(sql: Sql, syncId: string, input: ManualActivityInput, updatedAt: string): Promise<void> {
  const otherId = `${MANUAL_OTHER_PREFIX}${syncId}`;
  const notes = input.subjective_notes?.trim() || null;
  // 同一筆在每台寫出來的內容要一樣（同步比雜湊）：沒有距離一律是 null
  input = { ...input, distance_km: input.distance_km && input.distance_km > 0 ? input.distance_km : null };
  if (input.sport === "run" && !input.session_id) throw new Error("手動記的跑步要有回報的課（沒有課的用「記一趟跑步」）");
  if (input.sport === "run") {
    await sql.run("DELETE FROM other_activities WHERE intervals_id=?", [otherId]);
    await sql.run("DELETE FROM activity_feedback WHERE intervals_id=?", [otherId]);
    const values: SqlValue[] = [
      input.date,
      input.distance_km,
      input.duration_min,
      paceOf(input.distance_km, input.duration_min),
      input.perceived_effort,
      notes,
      input.session_id,
      input.completion,
      updatedAt,
    ];
    const updated = await sql.run(
      "UPDATE workouts SET date=?, distance_km=?, duration_min=?, avg_pace=?, perceived_effort=?, subjective_notes=?, session_id=?, completion=?, updated_at=? WHERE sync_id=?",
      [...values, syncId],
    );
    if (updated.changes === 0) {
      await sql.run(
        "INSERT INTO workouts (date, distance_km, duration_min, avg_pace, perceived_effort, subjective_notes, session_id, completion, updated_at, type, source, sync_id, synced_at)" +
          " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'run', 'manual', ?, ?)",
        [...values, syncId, updatedAt],
      );
    }
    return;
  }
  const run = (await sql.all("SELECT id FROM workouts WHERE sync_id=? AND source='manual'", [syncId]))[0];
  if (run) await deleteWorkoutRow(sql, Number(run.id));
  const type = MANUAL_TYPES[input.sport] ?? MANUAL_TYPES.other!;
  await sql.run(
    "INSERT INTO other_activities (intervals_id, date, type, duration_min, distance_km, avg_hr, training_load, raw_json, synced_at, session_id, completion, updated_at)" +
      " VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?)" +
      " ON CONFLICT(intervals_id) DO UPDATE SET date=excluded.date, type=excluded.type, duration_min=excluded.duration_min, distance_km=excluded.distance_km," +
      " session_id=excluded.session_id, completion=excluded.completion, updated_at=excluded.updated_at",
    [otherId, input.date, type, input.duration_min, input.distance_km, updatedAt, input.session_id, input.completion, updatedAt],
  );
  await sql.run(
    "INSERT INTO activity_feedback (intervals_id, perceived_effort, subjective_notes, updated_at) VALUES (?, ?, ?, ?)" +
      " ON CONFLICT(intervals_id) DO UPDATE SET perceived_effort=excluded.perceived_effort, subjective_notes=excluded.subjective_notes, updated_at=excluded.updated_at",
    [otherId, input.perceived_effort, notes, updatedAt],
  );
}

/** 刪掉手動記的那一筆（跑步連同分析；其他運動連同體感與分析）；找不到時回傳 false */
export async function deleteManualActivity(sql: Sql, syncId: string): Promise<boolean> {
  const otherId = `${MANUAL_OTHER_PREFIX}${syncId}`;
  const run = (await sql.all("SELECT id FROM workouts WHERE sync_id=? AND source='manual' AND session_id IS NOT NULL", [syncId]))[0];
  if (run) await deleteWorkoutRow(sql, Number(run.id));
  const other = await sql.run("DELETE FROM other_activities WHERE intervals_id=?", [otherId]);
  await sql.run("DELETE FROM activity_feedback WHERE intervals_id=?", [otherId]);
  await sql.run("DELETE FROM activity_summaries WHERE intervals_id=?", [otherId]);
  return !!run || other.changes > 0;
}

/**
 * 手動記的活動. 跑步：source manual 而且有 session_id 的（「記一趟跑步」記的沒有 session_id，照舊是 mw:）；
 * 其他運動：other_activities 的 manual:. 條件：syncId（一筆）或 session（回報某一堂課的）；都不給是全部. 最近改的在前
 */
export async function listManualActivities(sql: Pick<Sql, "all">, filter: { syncId?: string; session?: string } = {}): Promise<ManualActivity[]> {
  const runWhere = filter.syncId !== undefined ? " AND w.sync_id = ?" : filter.session !== undefined ? " AND w.session_id = ?" : "";
  const otherWhere = filter.syncId !== undefined ? " AND o.intervals_id = ?" : filter.session !== undefined ? " AND o.session_id = ?" : "";
  const runParams = filter.syncId !== undefined ? [filter.syncId] : filter.session !== undefined ? [filter.session] : [];
  const otherParams = filter.syncId !== undefined ? [`${MANUAL_OTHER_PREFIX}${filter.syncId}`] : runParams;
  const runs = await sql.all(
    "SELECT w.* FROM workouts w WHERE w.source='manual' AND w.session_id IS NOT NULL AND w.sync_id IS NOT NULL AND w.removed_at IS NULL" + runWhere,
    runParams,
  );
  const others = await sql.all(
    "SELECT o.*, f.perceived_effort, f.subjective_notes, MAX(COALESCE(o.updated_at, ''), COALESCE(f.updated_at, '')) AS changed_at" +
      " FROM other_activities o LEFT JOIN activity_feedback f ON f.intervals_id = o.intervals_id WHERE o.intervals_id LIKE 'manual:%'" +
      otherWhere,
    otherParams,
  );
  const num = (v: SqlValue | undefined) => (typeof v === "number" ? v : v == null ? null : Number(v));
  const list: ManualActivity[] = [
    ...runs.map((w) => ({
      sync_id: String(w.sync_id),
      session_id: w.session_id == null ? null : String(w.session_id),
      sport: "run",
      type: String(w.type ?? "run"),
      date: String(w.date),
      duration_min: num(w.duration_min) ?? 0,
      distance_km: num(w.distance_km),
      perceived_effort: num(w.perceived_effort) ?? 0,
      subjective_notes: w.subjective_notes == null ? null : String(w.subjective_notes),
      completion: isCompletion(w.completion) ? w.completion : ("done" as const),
      workout_id: Number(w.id),
      intervals_id: null,
      updated_at: String(w.updated_at ?? ""),
    })),
    ...others.map((o) => ({
      sync_id: String(o.intervals_id).slice(MANUAL_OTHER_PREFIX.length),
      session_id: o.session_id == null ? null : String(o.session_id),
      sport: sportOfType(String(o.type)),
      type: String(o.type),
      date: String(o.date),
      duration_min: num(o.duration_min) ?? 0,
      distance_km: num(o.distance_km),
      perceived_effort: num(o.perceived_effort) ?? 0,
      subjective_notes: o.subjective_notes == null ? null : String(o.subjective_notes),
      completion: isCompletion(o.completion) ? o.completion : ("done" as const),
      workout_id: null,
      intervals_id: String(o.intervals_id),
      updated_at: String(o.changed_at ?? ""),
    })),
  ];
  return list.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

/**
 * 去重（之後 Apple 健康的同一趟也一樣）：手動記的其他運動和裝置的同一天、同一種運動的一筆，看成同一趟，只留裝置的那筆（資料多）.
 * 手動記的體感、備註、回報的課與做到多少，在裝置那筆沒有時帶過去. 手動的沒有開始時間，照手動跑步的原則不自動刪：
 * 只在讀取時合併、不改資料，裝置的那筆不見了，手動的又會出現（跑步照舊由教練動態問要不要合併）
 */
export function coverManualOthers(list: OtherActivity[]): OtherActivity[] {
  const devices = list.filter((a) => !isManualOtherId(a.intervals_id));
  const taken = new Set<string>();
  const covered = new Set<string>();
  const carried = new Map<string, OtherActivity>();
  for (const m of list) {
    if (!isManualOtherId(m.intervals_id)) continue;
    const sport = sportOfType(m.type);
    const device = devices.find((a) => a.date === m.date && sportOfType(a.type) === sport && !taken.has(a.intervals_id));
    if (!device) continue;
    taken.add(device.intervals_id);
    covered.add(m.intervals_id);
    carried.set(device.intervals_id, {
      ...device,
      perceived_effort: device.perceived_effort ?? m.perceived_effort ?? null,
      subjective_notes: device.subjective_notes ?? m.subjective_notes ?? null,
      session_id: device.session_id ?? m.session_id ?? null,
      completion: device.completion ?? m.completion ?? null,
    });
  }
  return list.filter((a) => !covered.has(a.intervals_id)).map((a) => carried.get(a.intervals_id) ?? a);
}
