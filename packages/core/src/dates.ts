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

/** ISO 週標籤的週一，例：2026-W41 → 2026-10-05；格式不對時為 null（舊的文字課表用） */
export function isoWeekStart(label: string): string | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(label);
  if (!m) return null;
  // 1 月 4 日一定在第 1 週
  const jan4 = `${m[1]}-01-04`;
  return addDays(addDays(jan4, -weekdayIndex(jan4)), (Number(m[2]) - 1) * 7);
}

/** UTC 時間戳記，格式與 v1 相同：2026-10-10T03:06:37Z */
export function nowIso(now: Date): string {
  return now.toISOString().slice(0, 19) + "Z";
}

const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];

/** 月／日加上星期，例：10/24（六） */
export function shortDateLabel(isoDate: string): string {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${m}/${d}（${WEEKDAY_SHORT[weekdayIndex(isoDate)]}）`;
}

/**
 * 訊息旁的時間（12.16）：今天「14:32」、昨天「昨天 14:32」、今年更早「10/21 14:32」、不同年「2025/10/21 14:32」。
 * 沒有時間或無法解析（v1 帶過來的舊訊息）時回傳 null，不顯示。
 */
export function messageTimeLabel(timestamp: string | null | undefined, now: Date, timeZone: string): string | null {
  if (!timestamp) return null;
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return null;
  const date = localDate(at, timeZone);
  const today = localDate(now, timeZone);
  const time = localTime(at, timeZone);
  if (date === today) return time;
  if (date === addDays(today, -1)) return `昨天 ${time}`;
  const [y, m, d] = date.split("-").map(Number);
  return date.slice(0, 4) === today.slice(0, 4) ? `${m}/${d} ${time}` : `${y}/${m}/${d} ${time}`;
}
