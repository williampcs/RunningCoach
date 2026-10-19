/**
 * 恢復狀態的判讀：手錶的恢復資料與選手的自評並列.
 *
 * 手錶的數據只是參考：與選手的自評不一致時以選手的感受為主（系統提示、工具說明都這樣要求）。
 * 這裡只做簡單、可解釋的比較：最近一天對比「平常」（8～35 天前）的平均。
 * 不和前幾天比，是因為過度訓練這類持續好幾天的偏差，會把前幾天的平均一起拉高而看不出來；
 * 歷史資料不夠（剛開始使用）時才退回和前 7 天比。
 */
import { addDays, daysBetween, weekdayName } from "./dates";
import type { Db } from "./db";
import type { DailyCheckin, WellnessDay } from "./types";

/** 基準至少要有幾天的資料才比較 */
const MIN_BASELINE_DAYS = 3;
/** 「平常」：8～35 天前；資料少於 7 天時改用前 7 天 */
const USUAL_FROM = 35;
const USUAL_TO = 8;
const USUAL_MIN_DAYS = 7;
const RECENT_DAYS = 7;
/** 恢復資料要多新才算「今天的狀況」 */
const LATEST_MAX_AGE = 1;

export interface RecoverySignals {
  /** 最近一天（今天或昨天）的手錶資料 */
  latest: WellnessDay | null;
  baseline: { restingHr: number | null; hrv: number | null; sleepHours: number | null };
  /** HRV 用哪一種：rMSSD（Garmin 等）或 SDNN（Apple「健康」）；兩者不能互相比較，只和同一種的平常比 */
  hrvKind: "rmssd" | "sdnn" | null;
  /** 基準的說法：「平常」或「前幾天」 */
  baselineLabel: "平常" | "前幾天";
  restingHrDelta: number | null;
  hrvChangePct: number | null;
  sleepHours: number | null;
  /** 手錶數據偏差的說明，例：「靜息心率比前幾天平均高 6 bpm」 */
  watchFlags: string[];
  /** 今天的自評 */
  checkin: DailyCheckin | null;
  /** 自評偏差的說明，例：「自評精神差（2/5）」 */
  selfFlags: string[];
  /** watch_worse：手錶偏差但自評不錯；self_worse：自評偏差但手錶正常 */
  mismatch: "watch_worse" | "self_worse" | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

function baselineOf(days: WellnessDay[], pick: (w: WellnessDay) => number | null): number | null {
  const values = days.map(pick).filter((v): v is number => v !== null);
  return values.length >= MIN_BASELINE_DAYS ? mean(values) : null;
}

export function analyzeRecovery(wellness: WellnessDay[], checkins: DailyCheckin[], today: string): RecoverySignals {
  const sorted = [...wellness].sort((a, b) => a.date.localeCompare(b.date));
  const latestCandidate = sorted.at(-1) ?? null;
  const latest =
    latestCandidate && daysBetween(latestCandidate.date, today) <= LATEST_MAX_AGE ? latestCandidate : null;
  const usual = latest
    ? sorted.filter((w) => w.date >= addDays(latest.date, -USUAL_FROM) && w.date <= addDays(latest.date, -USUAL_TO))
    : [];
  const recent = latest
    ? sorted.filter((w) => w.date < latest.date && w.date >= addDays(latest.date, -RECENT_DAYS))
    : [];
  const baselineLabel = usual.length >= USUAL_MIN_DAYS ? "平常" : "前幾天";
  const prior = baselineLabel === "平常" ? usual : recent;

  const hrvKind = latest?.hrv != null ? "rmssd" : latest?.hrv_sdnn != null ? "sdnn" : null;
  const hrvOf = (w: WellnessDay) => (hrvKind === "sdnn" ? w.hrv_sdnn : w.hrv);
  const baseline = {
    restingHr: baselineOf(prior, (w) => w.resting_hr),
    hrv: hrvKind ? baselineOf(prior, hrvOf) : null,
    sleepHours: baselineOf(prior, (w) => (w.sleep_secs === null ? null : w.sleep_secs / 3600)),
  };
  const restingHrDelta =
    latest?.resting_hr != null && baseline.restingHr !== null ? Math.round(latest.resting_hr - baseline.restingHr) : null;
  const latestHrv = latest ? hrvOf(latest) : null;
  const hrvChangePct =
    latestHrv != null && baseline.hrv ? Math.round(((latestHrv - baseline.hrv) / baseline.hrv) * 100) : null;
  const sleepHours = latest?.sleep_secs != null ? Math.round((latest.sleep_secs / 3600) * 10) / 10 : null;

  const watchFlags: string[] = [];
  if (restingHrDelta !== null && restingHrDelta >= 5) watchFlags.push(`靜息心率比${baselineLabel}平均高 ${restingHrDelta} bpm`);
  if (hrvChangePct !== null && hrvChangePct <= -15) watchFlags.push(`HRV 比${baselineLabel}平均低 ${-hrvChangePct}%`);
  if (sleepHours !== null && (sleepHours < 6 || (baseline.sleepHours !== null && sleepHours <= baseline.sleepHours - 1))) {
    watchFlags.push(`睡眠只有 ${sleepHours} 小時`);
  }

  const checkin = checkins.find((c) => c.date === today) ?? null;
  const selfFlags: string[] = [];
  if (checkin) {
    if (checkin.energy <= 2) selfFlags.push(`自評精神差（${checkin.energy}/5）`);
    if (checkin.soreness >= 4) selfFlags.push(`自評痠痛明顯（${checkin.soreness}/5）`);
    if (checkin.sleep <= 2) selfFlags.push(`自評睡不好（${checkin.sleep}/5）`);
  }

  let mismatch: RecoverySignals["mismatch"] = null;
  if (checkin && watchFlags.length && !selfFlags.length && checkin.energy >= 4) mismatch = "watch_worse";
  else if (latest && selfFlags.length && !watchFlags.length) mismatch = "self_worse";

  return {
    latest,
    baseline,
    hrvKind,
    baselineLabel,
    restingHrDelta,
    hrvChangePct,
    sleepHours,
    watchFlags,
    checkin,
    selfFlags,
    mismatch,
  };
}

export function describeCheckin(c: DailyCheckin): string {
  return `精神 ${c.energy}/5、痠痛 ${c.soreness}/5、睡眠 ${c.sleep}/5${c.notes ? `；${c.notes}` : ""}`;
}

/** 手錶資料的一行說明，例：「靜息心率 58（前幾天平均 52，+6）｜HRV 48 ms（-23%）｜睡眠 6.2 小時」 */
export function describeWatch(s: RecoverySignals): string | null {
  if (!s.latest) return null;
  const parts: string[] = [];
  if (s.latest.resting_hr != null) {
    const base = s.baseline.restingHr;
    parts.push(
      `靜息心率 ${s.latest.resting_hr}` +
        (base !== null ? `（${s.baselineLabel}平均 ${Math.round(base)}，${s.restingHrDelta! >= 0 ? "+" : ""}${s.restingHrDelta}）` : ""),
    );
  }
  const hrv = s.hrvKind === "sdnn" ? s.latest.hrv_sdnn : s.latest.hrv;
  if (hrv != null) {
    parts.push(
      `${s.hrvKind === "sdnn" ? "HRV（SDNN）" : "HRV "}${Math.round(hrv)} ms` +
        (s.hrvChangePct !== null ? `（${s.hrvChangePct >= 0 ? "+" : ""}${s.hrvChangePct}%）` : ""),
    );
  }
  if (s.sleepHours !== null) parts.push(`睡眠 ${s.sleepHours} 小時`);
  if (s.latest.sleep_score != null) parts.push(`睡眠分數 ${s.latest.sleep_score}`);
  if (s.latest.readiness != null) parts.push(`準備度 ${s.latest.readiness}`);
  return parts.length ? parts.join("｜") : null;
}

/** 判讀原則：系統提示與工具結果共用 */
export const RECOVERY_RULES =
  "手錶的恢復數據只是參考。與選手的自評不一致時，以選手的感受為主：說明差異、建議觀察，不要用手錶數據否定選手的感受。" +
  "選手自評狀況差時，即使手錶數據正常，也要降低當天的強度；手錶偏差但選手自評不錯時，可以照計畫，但提醒留意。";

/**
 * 跑後分析用：跑步當天的身體狀況（當天或前一天的手錶資料，與當天的自評）。
 * 兩者都沒有時為 null，分析的提示就和沒有恢復資料時一樣。
 */
export async function recoveryNoteFor(db: Db, date: string): Promise<string | null> {
  const [wellness, checkin] = await Promise.all([db.getWellness(USUAL_FROM + 1, date), db.getCheckin(date)]);
  const s = analyzeRecovery(wellness, checkin ? [checkin] : [], date);
  const parts: string[] = [];
  const watch = describeWatch(s);
  if (watch) parts.push(`手錶：${watch}`);
  if (s.checkin) parts.push(`選手自評：${describeCheckin(s.checkin)}`);
  return parts.length ? parts.join("；") : null;
}

/** get_recovery_status 的內容：每天一行，加上今天的判讀 */
export function formatRecoveryReport(
  wellness: WellnessDay[],
  checkins: DailyCheckin[],
  today: string,
  days: number,
): string {
  const lines = [`最近 ${days} 天的恢復狀況（手錶資料與選手自評）：`];
  for (let i = days - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const w = wellness.find((x) => x.date === date);
    const c = checkins.find((x) => x.date === date);
    if (!w && !c) continue;
    const watch: string[] = [];
    if (w?.resting_hr != null) watch.push(`靜息心率 ${w.resting_hr}`);
    if (w?.hrv != null) watch.push(`HRV ${Math.round(w.hrv)}`);
    else if (w?.hrv_sdnn != null) watch.push(`HRV（SDNN）${Math.round(w.hrv_sdnn)}`);
    if (w?.sleep_secs != null) watch.push(`睡眠 ${Math.round((w.sleep_secs / 3600) * 10) / 10}h`);
    lines.push(
      `${date}（${weekdayName(date)}）` +
        (watch.length ? `　手錶：${watch.join("｜")}` : "") +
        (c ? `　自評：${describeCheckin(c)}` : ""),
    );
  }
  if (lines.length === 1) return "最近沒有恢復資料，也沒有自評。可以請選手描述今天的精神、痠痛與睡眠。";

  const s = analyzeRecovery(wellness, checkins, today);
  lines.push("", "今天的判讀：");
  lines.push(s.watchFlags.length ? `・手錶：${s.watchFlags.join("；")}` : s.latest ? "・手錶：沒有明顯偏差" : "・手錶：今天沒有資料");
  lines.push(s.checkin ? `・自評：${s.selfFlags.length ? s.selfFlags.join("；") : "沒有明顯問題"}` : "・自評：今天還沒自評");
  if (s.mismatch === "watch_worse") lines.push("・手錶偏差，但選手自評不錯：以選手的感受為主，提醒留意即可。");
  if (s.mismatch === "self_worse") lines.push("・選手自評偏差，但手錶正常：以選手的感受為主，降低今天的強度。");
  lines.push("", RECOVERY_RULES);
  return lines.join("\n");
}
