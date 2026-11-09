/**
 * 匯入的檔案和 Intervals.icu 的同一趟（規格 12.40「讀 FIT 檔」）：Db 與多裝置同步共用的部分.
 */
import { addDays } from "../dates";
import { keepScore, sameRun } from "../dedupe";
import { sportOfType } from "../sports";
import type { SqlDriver } from "../types";

type Sql = Pick<SqlDriver, "all" | "run">;

/**
 * 騎車等其他運動：匯入的檔案（file:）和不是檔案的（Intervals.icu 的）同一運動、時間重疊時，刪掉檔案那筆，
 * 體感與分析搬過去（那筆還沒有的時候）. 只看 ids 這幾筆（null 是全部）、range 這幾天（null 是全部）. 回傳刪掉的筆數
 */
export async function dropCoveredFileOthers(sql: Sql, ids: string[] | null, range: { from: string; to: string } | null = null): Promise<number> {
  // 只看範圍內的檔案（同步時是那幾天）：匯入了幾千趟時不必每次全部比對
  const files = (await sql.all(
    `SELECT intervals_id, date, type, raw_json FROM other_activities WHERE intervals_id LIKE 'file:%'${range ? " AND date BETWEEN ? AND ?" : ""}`,
    range ? [addDays(range.from, -1), addDays(range.to, 1)] : [],
  )) as {
    intervals_id: string;
    date: string;
    type: string;
    raw_json: string | null;
  }[];
  const wanted = ids ? new Set(ids) : null;
  let dropped = 0;
  for (const f of files) {
    const near = (await sql.all("SELECT intervals_id, type, raw_json FROM other_activities WHERE intervals_id NOT LIKE 'file:%' AND date BETWEEN ? AND ?", [
      addDays(f.date, -1),
      addDays(f.date, 1),
    ])) as { intervals_id: string; type: string; raw_json: string | null }[];
    const cover = near.find((o) => (!wanted || wanted.has(o.intervals_id) || wanted.has(f.intervals_id)) && sportOfType(o.type) === sportOfType(f.type) && sameRun(o as never, f as never));
    if (!cover) continue;
    await sql.run("UPDATE OR IGNORE activity_feedback SET intervals_id=? WHERE intervals_id=?", [cover.intervals_id, f.intervals_id]);
    await sql.run("UPDATE OR IGNORE activity_summaries SET intervals_id=? WHERE intervals_id=?", [cover.intervals_id, f.intervals_id]);
    await sql.run("DELETE FROM activity_feedback WHERE intervals_id=?", [f.intervals_id]);
    await sql.run("DELETE FROM activity_summaries WHERE intervals_id=?", [f.intervals_id]);
    await sql.run("DELETE FROM other_activities WHERE intervals_id=?", [f.intervals_id]);
    dropped++;
  }
  return dropped;
}

/**
 * 別台匯入的跑步同步到這台之後：和這台已經有的同一趟（時間重疊）標成重複，保留資料多的
 * （和 Db.saveWorkoutChecked 的規則一樣；體感與分析不搬，兩筆各自的照舊同步）
 */
export async function markFileRunDuplicate(sql: Sql, id: number): Promise<void> {
  const row = (await sql.all("SELECT id, date, distance_km, duration_min, avg_hr, training_load, raw_json FROM workouts WHERE id=?", [id]))[0];
  if (!row) return;
  const nearby = await sql.all(
    "SELECT id, date, distance_km, duration_min, avg_hr, training_load, raw_json FROM workouts WHERE duplicate_of IS NULL AND removed_at IS NULL AND id != ? AND date BETWEEN ? AND ?",
    [id, addDays(String(row.date), -1), addDays(String(row.date), 1)],
  );
  const match = nearby.find((w) => sameRun(w as never, row as never));
  if (!match) return;
  const [keep, dup] = keepScore(row as never) > keepScore(match as never) ? [id, Number(match.id)] : [Number(match.id), id];
  await sql.run("UPDATE workouts SET duplicate_of = ? WHERE id = ? OR duplicate_of = ?", [keep, dup, dup]);
}
