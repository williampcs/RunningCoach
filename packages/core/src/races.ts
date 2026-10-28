/**
 * 賽事的規則（規格 12.15）：選手的網頁與教練的工具共用，兩邊能做的事一致.
 *
 * - 結局只有三種：完賽（有成績）、沒有完賽（DNF）、沒有出賽（DNS，賽前「不參加了」或賽後「沒有出賽」）.
 * - 賽前可以改所有欄位；賽後（比賽日已過，或已經有結局）只能改名稱與備註.
 * - 成績只能在比賽當天以後記錄. 主成績是個人成績（淨時間，有晶片時用晶片的），推算訓練配速用它；
 *   大會成績（槍聲起算）選填；記下成績的來源. 選手手動登記為主，沒有正式成績時才拿手錶紀錄當參考.
 *   教練要先問選手的成績，選手確認後才記錄.
 * - 記錄成績時連到比賽當天距離最接近的那趟跑步（之後的賽後分析用，不另外存一份時間）.
 * - 只有選手能刪除；教練可以列出所有賽事，看到可能重複的會告訴選手.
 */
import { daysBetween } from "./dates";
import type { Db, RaceUpdate } from "./db";
import { roundPlace, type WeatherPlace } from "./weather";
import { sportOfType } from "./sports";
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

/** 成績的來源 */
export const RESULT_SOURCES = {
  chip: "晶片計時",
  watch: "手錶或手機",
  other: "不確定",
} as const;
export type ResultSource = keyof typeof RESULT_SOURCES;

/** 起跑時間寫成 HH:MM（24 小時制）；空白是沒有；看不懂時丟錯 */
export function normalizeStartTime(text: string | null | undefined): string | null {
  const t = (text ?? "").trim();
  if (!t) return null;
  const m = /^(\d{1,2})[:：](\d{2})$/.exec(t);
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59) throw new Error(`起跑時間要寫成 HH:MM（例：06:30）：${t}`);
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** 地點寫進賽事的欄位；null 是清除 */
export function placeFields(place: WeatherPlace | null, label = ""): { place_label: string | null; place_lat: number | null; place_lon: number | null } {
  if (!place) return { place_label: null, place_lat: null, place_lon: null };
  const { lat, lon } = roundPlace(place.lat, place.lon);
  return { place_label: label.trim().slice(0, 100) || null, place_lat: lat, place_lon: lon };
}

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
  if (fields.start_time !== undefined) fields = { ...fields, start_time: normalizeStartTime(fields.start_time === null ? null : String(fields.start_time)) };
  // 地點的座標只留到 0.1°（約 10 km），和天氣的城市一樣
  if (typeof fields.place_lat === "number" && typeof fields.place_lon === "number") {
    fields = { ...fields, ...placeFields(roundPlace(fields.place_lat, fields.place_lon), String(fields.place_label ?? "")) };
  }
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
  result:
    | { outcome: "finished"; time: string; gunTime?: string | null; source?: string | null }
    | { outcome: "dnf"; note?: string | null },
): Promise<Race> {
  const race = await requireRace(db, id);
  if (race.date > today) throw new Error(`「${race.name}」還沒到比賽日（${race.date}），比賽當天以後才能記錄成績`);
  const activity = (await raceActivity(db, race))?.intervalsId ?? null;
  if (result.outcome === "finished") {
    const source = result.source || "other";
    if (!(source in RESULT_SOURCES)) throw new Error(`成績來源只能是：${Object.keys(RESULT_SOURCES).join("、")}`);
    await db.setRaceOutcome(id, "finished", {
      resultTime: normalizeRaceTime(result.time),
      gunTime: result.gunTime?.trim() ? normalizeRaceTime(result.gunTime) : null,
      source,
      activity,
    });
  } else {
    await db.setRaceOutcome(id, "dnf", { reason: result.note?.trim() || null, activity });
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
export async function raceActivity(
  db: Db,
  race: Race,
): Promise<{ time: string; distanceKm: number | null; workoutId: number | null; intervalsId: string | null } | null> {
  // 單車的賽事：比賽當天的騎車（其他運動）
  const runs =
    race.sport === "ride"
      ? (await db.getOtherActivities(Math.max(1, daysBetween(race.date, db.today()) + 1)))
          .filter((a) => a.date === race.date && sportOfType(a.type) === "ride" && a.distance_km != null)
          .map((a) => ({ ...a, id: null as number | null }))
      : (await db.getWorkoutsOn(race.date)).filter((w) => w.distance_km != null);
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
  return { time: formatRaceTime(secs), distanceKm: best.distance_km, workoutId: best.id, intervalsId: best.intervals_id };
}

/** 成績的補充：大會成績與來源，例：["大會成績 1:56:10", "晶片計時"] */
export function resultDetail(r: Race): string[] {
  const out: string[] = [];
  if (r.gun_time) out.push(`大會成績 ${r.gun_time}`);
  if (r.result_source && r.result_source in RESULT_SOURCES) out.push(RESULT_SOURCES[r.result_source as ResultSource]);
  return out;
}

/** 教練看到的一行，例：[3] 2026-11-01 半馬 21.1km｜目標 1:58:00｜還有 8 天 */
export function raceLineForCoach(r: Race, today: string): string {
  return (
    `- [${r.id}] ${r.date} ${r.name} ${r.distance_km}km${r.sport === "ride" ? "（單車）" : ""}｜目標 ${r.target_time || "完賽"}｜${raceStatusText(r, today)}` +
    (raceOutcome(r) === "finished" ? resultDetail(r).map((d) => `｜${d}`).join("") : "") +
    // 地點不給教練看，只說有沒有設定（可以查比賽日的天氣）
    (raceOutcome(r) === null && r.date >= today ? `${r.start_time ? `｜起跑 ${r.start_time}` : ""}${r.place_lat != null ? "｜已設定地點" : ""}` : "") +
    (r.notes ? `｜備註：${r.notes}` : "")
  );
}
