/** 日期工具 — 一律以使用者時區的「曆日」（YYYY-MM-DD 字串）運算，不依賴執行環境的系統時區. */

const WEEKDAYS = ["星期一", "星期二", "星期三", "星期四", "星期五", "星期六", "星期日"];

/** 指定時區的當地日期，例：2026-10-10 */
export function localDate(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** 指定時區的當地時間（24 小時制），例：21:05 */
export function localTime(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("hour")}:${get("minute")}`;
}

/** 當地某一天 00:00 對應的 UTC 時間（ISO，與對話的 timestamp 同格式），例：2026-10-18 在台北是 2026-10-17T16:00:00Z */
export function localDayStartUtc(isoDate: string, timeZone: string): string {
  const midnight = Date.parse(`${isoDate}T00:00:00Z`);
  // 當地時間比 UTC 快多少：先以 UTC 午夜那一刻的偏移估，再以估出的時刻校正一次（跨日光節約時間時兩者不同）
  const offset = (t: number) => Date.parse(`${localDate(new Date(t), timeZone)}T${localTime(new Date(t), timeZone)}:00Z`) - Math.floor(t / 60_000) * 60_000;
  const first = midnight - offset(midnight);
  return nowIso(new Date(midnight - offset(first)));
}

/** 時區的 UTC 偏移標示，例：UTC+8、UTC-3:30 */
export function utcOffsetLabel(now: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "shortOffset" }).formatToParts(now);
  const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  return name === "GMT" ? "UTC+0" : name.replace("GMT", "UTC");
}

function toUtcMs(isoDate: string): number {
  const [y, m, d] = isoDate.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`日期格式錯誤：${isoDate}`);
  return Date.UTC(y, m - 1, d);
}

export function addDays(isoDate: string, days: number): string {
  return new Date(toUtcMs(isoDate) + days * 86_400_000).toISOString().slice(0, 10);
}

/** b − a 的天數 */
export function daysBetween(a: string, b: string): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

/** 星期一 = 0 … 星期日 = 6 */
export function weekdayIndex(isoDate: string): number {
  return (new Date(toUtcMs(isoDate)).getUTCDay() + 6) % 7;
}

export function weekdayName(isoDate: string): string {
  return WEEKDAYS[weekdayIndex(isoDate)]!;
}

/** ISO 週標籤（週一起算），例：2026-W41 */
export function isoWeekLabel(isoDate: string): string {
  // 該週的週四決定 ISO 年份
  const thursday = addDays(isoDate, 3 - weekdayIndex(isoDate));
  const year = Number(thursday.slice(0, 4));
  const week = Math.floor(daysBetween(`${year}-01-01`, thursday) / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** UTC 時間戳記，格式與 v1 相同：2026-10-10T03:06:37Z */
export function nowIso(now: Date): string {
  return now.toISOString().slice(0, 19) + "Z";
}
