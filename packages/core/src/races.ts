/**
 * 賽事的規則（規格 12.15）：選手的網頁與教練的工具共用，兩邊能做的事一致.
 *
 * - 結局只有三種：完賽（有成績）、沒有完賽（DNF）、沒有出賽（DNS，賽前「不參加了」或賽後「沒有出賽」）.
 * - 賽前可以改所有欄位；賽後（比賽日已過，或已經有結局）只能改名稱與備註.
 * - 成績只能在比賽當天以後記錄；教練記錄或修改前要先查手錶紀錄、請選手確認.
 * - 只有選手能刪除；教練可以列出所有賽事，看到可能重複的會告訴選手.
 */
import { daysBetween } from "./dates";
import type { Db, RaceUpdate } from "./db";
import { parseDuration } from "./training-values";
import type { Race } from "./types";

export type RaceOutcome = "finished" | "dnf" | "dns";

/** 沒有出賽的原因 */
export const DNS_REASONS = {
  injury: "受傷或生病",
  event_cancelled: "賽事取消",
  conflict: "有其他安排",
  other: "其他",
} as const;
export type DnsReason = keyof typeof DNS_REASONS;

/** 賽後還能改的欄位 */
const AFTER_RACE_FIELDS = new Set(["name", "notes"]);

/** 賽事的結局；schema 11 之前或舊版同步過來的資料沒有 outcome，用 cancelled 與成績判斷 */
export function raceOutcome(r: Pick<Race, "outcome" | "cancelled" | "result_time">): RaceOutcome | null {
  if (r.outcome === "finished" || r.outcome === "dnf" || r.outcome === "dns") return r.outcome;
  if (r.cancelled) return "dns";
  if (r.result_time) return "finished";
  return null;
}

/** 賽後：比賽日已過，或已經有結局。賽後只能改名稱與備註 */
export function isAfterRace(r: Race, today: string): boolean {
  return raceOutcome(r) !== null || r.date < today;
}

export function dnsReasonText(code: string | null | undefined): string {
  return DNS_REASONS[code as DnsReason] ?? (code || DNS_REASONS.other);
}

/** 一場賽事目前的狀態，網頁與教練看到的一樣 */
export function raceStatusText(r: Race, today: string): string {
  const outcome = raceOutcome(r);
  if (outcome === "finished") return `完賽 ${r.result_time ?? ""}`.trim();
  if (outcome === "dnf") return `沒有完賽${r.outcome_reason ? `（${r.outcome_reason}）` : ""}`;
  if (outcome === "dns") return `沒有出賽（${dnsReasonText(r.outcome_reason)}）`;
  const days = daysBetween(today, r.date);
  if (days < 0) return `${-days} 天前，還沒記錄成績`;
  return (days === 0 ? "今天" : `還有 ${days} 天`) + (r.confirmed ? "" : "（考慮中）");
}

/** 同一天、距離差不多（5% 或 0.5 km 內）的賽事：新增時提醒可能重複 */
export function similarRaces(races: Race[], race: { date: string; distance_km: number }, excludeId?: number): Race[] {
  return races.filter(
    (r) => r.id !== excludeId && r.date === race.date && Math.abs(r.distance_km - race.distance_km) <= Math.max(0.5, race.distance_km * 0.05),
  );
}

/** 看起來重複的賽事組（每組依 id 排序） */
export function duplicateGroups(races: Race[]): Race[][] {
  const groups: Race[][] = [];
  const seen = new Set<number>();
  for (const r of [...races].sort((a, b) => a.id - b.id)) {
    if (seen.has(r.id)) continue;
    const same = [r, ...similarRaces(races, r, r.id).filter((o) => !seen.has(o.id))];
    if (same.length > 1) {
      same.forEach((o) => seen.add(o.id));
      groups.push(same.sort((a, b) => a.id - b.id));
    }
  }
  return groups;
}

async function requireRace(db: Db, id: number): Promise<Race> {
  const race = await db.getRace(id);
  if (!race) throw new Error(`找不到這場賽事（id=${id}），可能已經刪除`);
  return race;
}

/** 修改賽事資訊；賽後只能改名稱與備註 */
export async function editRace(db: Db, today: string, id: number, fields: RaceUpdate): Promise<Race> {
  const race = await requireRace(db, id);
  const changing = Object.entries(fields).filter(([, v]) => v !== undefined && v !== null);
  if (isAfterRace(race, today)) {
    const blocked = changing.map(([k]) => k).filter((k) => !AFTER_RACE_FIELDS.has(k));
    if (blocked.length) throw new Error(`「${race.name}」已經是賽後，只能改名稱與備註（不能改：${blocked.join("、")}）`);
  }
  if (typeof fields.date === "string" && !/^\d{4}-\d{2}-\d{2}$/.test(fields.date)) throw new Error(`日期格式要是 YYYY-MM-DD：${fields.date}`);
  await db.updateRace(id, fields);
  return (await db.getRace(id))!;
}

/** 成績寫成 h:mm:ss 或 m:ss；看不懂時丟錯 */
export function normalizeRaceTime(text: string): string {
  const secs = parseDuration(text);
  if (secs === null || secs <= 0) throw new Error(`看不懂這個成績：${text}（例：1:55:30、48:12）`);
  return formatRaceTime(secs);
}

export function formatRaceTime(secs: number): string {
  const s = Math.round(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** 記錄或修改成績（完賽或沒有完賽）；比賽當天以後才可以 */
export async function recordRaceResult(
  db: Db,
  today: string,
  id: number,
  result: { outcome: "finished"; time: string } | { outcome: "dnf"; note?: string | null },
): Promise<Race> {
  const race = await requireRace(db, id);
  if (race.date > today) throw new Error(`「${race.name}」還沒到比賽日（${race.date}），比賽當天以後才能記錄成績`);
  if (result.outcome === "finished") {
    await db.setRaceOutcome(id, "finished", { resultTime: normalizeRaceTime(result.time) });
  } else {
    await db.setRaceOutcome(id, "dnf", { reason: result.note?.trim() || null });
  }
  return (await db.getRace(id))!;
}

/** 不參加了（賽前）或沒有出賽（賽後）；已經完賽的不能改成沒有出賽 */
export async function markRaceNotStarted(db: Db, id: number, reason: string, note?: string | null): Promise<Race> {
  const race = await requireRace(db, id);
  if (raceOutcome(race) === "finished") throw new Error(`「${race.name}」已經記錄完賽成績，不能改成沒有出賽`);
  if (!(reason in DNS_REASONS)) throw new Error(`原因只能是：${Object.keys(DNS_REASONS).join("、")}`);
  await db.setRaceOutcome(id, "dns", { reason });
  const extra = note?.trim();
  if (extra) await db.updateRace(id, { notes: race.notes ? `${race.notes}；${extra}` : extra });
  return (await db.getRace(id))!;
}

/** 比賽當天的手錶紀錄：距離最接近的一趟（差 25% 以內）；用總時間（含停下來的），比較接近大會成績 */
export async function raceActivity(db: Db, race: Race): Promise<{ time: string; distanceKm: number | null; workoutId: number } | null> {
  const runs = (await db.getWorkoutsOn(race.date)).filter((w) => w.distance_km != null);
  const best = runs
    .filter((w) => Math.abs(w.distance_km! - race.distance_km) <= race.distance_km * 0.25)
    .sort((a, b) => Math.abs(a.distance_km! - race.distance_km) - Math.abs(b.distance_km! - race.distance_km))[0];
  if (!best) return null;
  let secs: number | null = null;
  try {
    const raw = JSON.parse(best.raw_json ?? "{}") as { elapsed_time?: unknown; moving_time?: unknown };
    secs = Number(raw.elapsed_time) || Number(raw.moving_time) || null;
  } catch {
    // 原始資料壞掉時用時長
  }
  secs ??= best.duration_min != null ? best.duration_min * 60 : null;
  if (!secs) return null;
  return { time: formatRaceTime(secs), distanceKm: best.distance_km, workoutId: best.id };
}

/** 教練看到的一行，例：[3] 2026-11-01 半馬 21.1km｜目標 1:58:00｜還有 8 天 */
export function raceLineForCoach(r: Race, today: string): string {
  return (
    `- [${r.id}] ${r.date} ${r.name} ${r.distance_km}km｜目標 ${r.target_time || "完賽"}｜${raceStatusText(r, today)}` +
    (r.notes ? `｜備註：${r.notes}` : "")
  );
}
