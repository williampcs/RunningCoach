/**
 * 結構化課表（規格 12.8 的第三步 3a）：一堂一堂的課、以代號寫的目標、檢查器.
 *
 * - 目標寫代號（Daniels 的 E/M/T/I/R 配速、輕鬆跑的心率上限、心率區間、體感），由程式依訓練數值換算，
 *   模型寫不出自己編的配速；VDOT 更新後，還沒跑的課跟著更新。
 * - 強度課的配速先取保守的一端：範圍是 Daniels 的配速到慢 6 秒（想要挑戰的人改為前後 3 秒）。
 * - 檢查器依教練方法（coaching-method.ts）與最近的訓練紀錄檢查，只警告、不硬擋：
 *   教練要修改，或寫出理由後才能存。
 */
import { addDays, daysBetween, weekdayIndex, weekdayName } from "./dates";
import { formatPace, parsePace } from "./fake-activities";
import type { RecoverySignals } from "./recovery";
import { raceOutcome } from "./races";
import type { TrainingValues } from "./training-values";
import type { OtherActivity, Race, Workout } from "./types";

export const SESSION_KINDS = {
  easy: "輕鬆跑",
  long: "長跑",
  marathon: "M 馬拉松配速",
  threshold: "T 閾值",
  interval: "I 間歇",
  repetition: "R 反覆跑",
  rest: "休息",
  cross: "交叉訓練",
  strength: "肌力訓練",
  race: "比賽",
} as const;
export type SessionKind = keyof typeof SESSION_KINDS;

/** 強度課：一週最多兩堂、不連排兩天，要附狀況不好時的替代 */
export const QUALITY_KINDS: ReadonlySet<SessionKind> = new Set(["marathon", "threshold", "interval", "repetition"]);
/** 不是跑步的課：不算跑量 */
export const NON_RUN_KINDS: ReadonlySet<SessionKind> = new Set(["rest", "cross", "strength"]);

export type PaceCode = "E" | "M" | "T" | "I" | "R";
const PACE_CODES: readonly PaceCode[] = ["E", "M", "T", "I", "R"];

/** 一步的目標：Daniels 配速、輕鬆跑的心率上限、心率區間（例：Z2）或體感（1–10） */
export type Target = { pace: PaceCode } | { hr: "easy" } | { zone: string } | { rpe: [number, number] };

export interface Step {
  distance_km?: number;
  duration_min?: number;
  target?: Target;
  note?: string;
}

export interface RepeatBlock {
  repeat: number;
  steps: Step[];
}

export type PlanStep = Step | RepeatBlock;

export interface SessionDraft {
  /** 彈性的課表（菜單）沒有日期 */
  date: string | null;
  kind: SessionKind;
  title: string;
  steps: PlanStep[];
  purpose: string;
  /** 完成的標準 */
  success: string;
  /** 狀況不好時的替代；選了替代也算照計畫 */
  fallback: string | null;
}

export type SessionStatus = "planned" | "skipped" | "fallback";

export interface PlannedSession extends SessionDraft {
  id: number;
  plan_id: number;
  status: SessionStatus;
  /** 跳過、改用替代或移動的原因 */
  note: string | null;
}

/** 固定：照星期排；彈性：一週的菜單，哪天跑都可以 */
export type PlanStyle = "fixed" | "flexible";

/** 每種課預期的體感（1–10）：之後依回報的體感判斷「太難、剛好、太輕鬆」（我們的經驗值，規格 12.8） */
export const EXPECTED_RPE: Record<SessionKind, [number, number] | null> = {
  easy: [2, 4],
  long: [3, 5],
  marathon: [5, 6],
  threshold: [6, 7],
  interval: [8, 9],
  repetition: [8, 9],
  rest: null,
  cross: null,
  strength: null,
  race: null,
};
const PACE_RPE: Record<PaceCode, [number, number]> = { E: [2, 4], M: [5, 6], T: [6, 7], I: [8, 9], R: [8, 9] };

export const isRepeat = (step: PlanStep): step is RepeatBlock => "repeat" in step;

// ---------------------------------------------------------------------------
// 解析教練給的課表（工具的輸入）；格式錯誤時丟出錯誤，讓教練修正
// ---------------------------------------------------------------------------

function positive(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${label} 必須是正數：${String(value)}`);
  return n;
}

function parseTarget(value: unknown, where: string): Target | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object") throw new Error(`${where} 的 target 格式不對`);
  const t = value as Record<string, unknown>;
  if (typeof t.pace === "string") {
    const code = t.pace.toUpperCase() as PaceCode;
    if (!PACE_CODES.includes(code)) throw new Error(`${where} 的 pace 只能是 E、M、T、I、R：${t.pace}`);
    return { pace: code };
  }
  if (t.hr === "easy") return { hr: "easy" };
  if (typeof t.zone === "string" && /^Z\d[a-c]?$/i.test(t.zone)) return { zone: t.zone.toUpperCase().replace(/([ABC])$/, (c) => c.toLowerCase()) };
  if (Array.isArray(t.rpe) && t.rpe.length === 2) {
    const [lo, hi] = t.rpe.map(Number) as [number, number];
    if (lo >= 1 && hi <= 10 && lo <= hi) return { rpe: [lo, hi] };
  }
  throw new Error(`${where} 的 target 要寫代號：{"pace":"T"}、{"hr":"easy"}、{"zone":"Z2"} 或 {"rpe":[6,7]}，不要寫數字的配速`);
}

function parseStep(value: unknown, where: string): Step {
  if (typeof value !== "object" || value === null) throw new Error(`${where} 格式不對`);
  const s = value as Record<string, unknown>;
  const step: Step = {
    distance_km: positive(s.distance_km, `${where} 的 distance_km`),
    duration_min: positive(s.duration_min, `${where} 的 duration_min`),
    target: parseTarget(s.target, where),
    note: typeof s.note === "string" && s.note.trim() ? s.note.trim() : undefined,
  };
  if (step.distance_km === undefined && step.duration_min === undefined) throw new Error(`${where} 要有 distance_km 或 duration_min`);
  return step;
}

function parseSteps(value: unknown, where: string): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, i) => {
    const at = `${where}第 ${i + 1} 步`;
    if (typeof raw === "object" && raw !== null && "repeat" in raw) {
      const r = raw as Record<string, unknown>;
      const times = Number(r.repeat);
      if (!Number.isInteger(times) || times < 1 || times > 30) throw new Error(`${at} 的 repeat 要是 1–30 的整數`);
      const inner = Array.isArray(r.steps) ? r.steps.map((x, j) => parseStep(x, `${at}的第 ${j + 1} 段`)) : [];
      if (!inner.length) throw new Error(`${at} 的重複組沒有內容`);
      return { repeat: times, steps: inner };
    }
    return parseStep(raw, at);
  });
}

/** 工具輸入的 sessions → 課的草稿；固定的課表每堂都要有這週的日期 */
export function parseSessions(value: unknown, weekStart: string, style: PlanStyle): SessionDraft[] {
  if (!Array.isArray(value) || !value.length) throw new Error("sessions 至少要有一堂課");
  const weekEnd = addDays(weekStart, 6);
  return value.map((raw, i) => {
    const where = `第 ${i + 1} 堂課`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${where} 格式不對`);
    const s = raw as Record<string, unknown>;
    const kind = String(s.kind ?? "") as SessionKind;
    if (!(kind in SESSION_KINDS)) throw new Error(`${where} 的 kind 只能是 ${Object.keys(SESSION_KINDS).join("、")}`);
    const date = typeof s.date === "string" && s.date ? s.date : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${where} 的 date 格式要是 YYYY-MM-DD`);
    if (style === "fixed" && !date) throw new Error(`${where} 沒有日期；固定的課表每堂都要有日期（彈性的才可以不填）`);
    if (date && (date < weekStart || date > weekEnd)) throw new Error(`${where} 的日期 ${date} 不在這週（${weekStart}～${weekEnd}）`);
    const steps = parseSteps(s.steps, `${where}的`);
    if (!NON_RUN_KINDS.has(kind) && !steps.length) throw new Error(`${where} 沒有 steps`);
    const text = (key: string) => (typeof s[key] === "string" ? (s[key] as string).trim() : "");
    return {
      date,
      kind,
      title: text("title") || SESSION_KINDS[kind],
      steps,
      purpose: text("purpose"),
      success: text("success"),
      fallback: text("fallback") || null,
    };
  });
}

// ---------------------------------------------------------------------------
// 換算目標、估算距離與時間
// ---------------------------------------------------------------------------

export interface TargetContext {
  values: TrainingValues;
  /** 想要挑戰：強度課的配速用範圍中間，否則用保守的一端 */
  challenge: boolean;
  /** 沒有配速依據時估算用的配速（每公里秒數）：最近的平均配速 */
  fallbackPaceSec: number;
}

/** 強度課配速的範圍（每公里秒數，快、慢） */
function paceRange(code: PaceCode, ctx: TargetContext): [number, number] | null {
  const p = ctx.values.paces;
  if (!p) return null;
  if (code === "E") return p.easy;
  const pace = { M: p.marathon, T: p.threshold, I: p.interval, R: p.repetition }[code];
  return ctx.challenge ? [pace - 3, pace + 3] : [pace, pace + 6];
}

const rangeText = ([fast, slow]: [number, number]) => `${formatPace(fast).replace("/km", "")}–${formatPace(slow)}`;

/** 目標的文字，例：「5:05–5:11/km（T）」「心率 ≤153」「體感 6–7/10」 */
export function targetText(target: Target | undefined, ctx: TargetContext): string {
  if (!target) return "";
  if ("pace" in target) {
    const range = paceRange(target.pace, ctx);
    if (range) return `${rangeText(range)}（${target.pace}）`;
    const [lo, hi] = PACE_RPE[target.pace];
    return `體感 ${lo}–${hi}/10（${target.pace}，還沒有配速的依據）`;
  }
  if ("hr" in target) {
    const hr = ctx.values.hr;
    return hr ? `心率 ≤${hr.easyMax}` : "能聊天的強度（體感 2–4/10）";
  }
  if ("zone" in target) {
    const zone = ctx.values.hr?.zones.find((z) => z.name === target.zone);
    return zone ? `心率 ${zone.name}（${zone.min === null ? `≤${zone.max}` : `${zone.min}–${zone.max}`}）` : `心率 ${target.zone}`;
  }
  return `體感 ${target.rpe[0]}–${target.rpe[1]}/10`;
}

/** 估算用的配速（每公里秒數） */
function paceSecOf(target: Target | undefined, ctx: TargetContext): number {
  if (target && "pace" in target) {
    const range = paceRange(target.pace, ctx);
    if (range) return (range[0] + range[1]) / 2;
  }
  const easy = ctx.values.paces?.easy;
  return easy ? (easy[0] + easy[1]) / 2 : ctx.fallbackPaceSec;
}

export interface SessionEstimate {
  km: number;
  minutes: number;
  /** 各種強度配速的距離（公里） */
  qualityKm: Record<"M" | "T" | "I" | "R", number>;
}

function stepEstimate(step: Step, ctx: TargetContext): { km: number; minutes: number } {
  const pace = paceSecOf(step.target, ctx);
  const km = step.distance_km ?? ((step.duration_min ?? 0) * 60) / pace;
  const minutes = step.duration_min ?? (km * pace) / 60;
  return { km, minutes };
}

export function estimateSession(session: SessionDraft, ctx: TargetContext): SessionEstimate {
  const out: SessionEstimate = { km: 0, minutes: 0, qualityKm: { M: 0, T: 0, I: 0, R: 0 } };
  const add = (step: Step, times: number) => {
    const e = stepEstimate(step, ctx);
    out.km += e.km * times;
    out.minutes += e.minutes * times;
    if (step.target && "pace" in step.target && step.target.pace !== "E") out.qualityKm[step.target.pace] += e.km * times;
  };
  for (const step of session.steps) {
    if (isRepeat(step)) for (const inner of step.steps) add(inner, step.repeat);
    else add(step, 1);
  }
  if (NON_RUN_KINDS.has(session.kind)) out.km = 0;
  return out;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function lengthText(step: Step): string {
  if (step.distance_km !== undefined) return `${round1(step.distance_km)} km`;
  return `${round1(step.duration_min ?? 0)} 分鐘`;
}

function stepText(step: Step, ctx: TargetContext): string {
  const target = targetText(step.target, ctx);
  return [lengthText(step), target, step.note ? `（${step.note}）` : ""].filter(Boolean).join(" ");
}

/** 一堂課的步驟，例：「15 分鐘 心率 ≤153｜5 ×（1 km 5:05–5:11/km（T）＋ 2 分鐘 能聊天）｜10 分鐘 心率 ≤153」 */
export function stepsText(session: SessionDraft, ctx: TargetContext): string {
  return session.steps
    .map((step) => (isRepeat(step) ? `${step.repeat} ×（${step.steps.map((s) => stepText(s, ctx)).join(" ＋ ")}）` : stepText(step, ctx)))
    .join("｜");
}

// ---------------------------------------------------------------------------
// 檢查器
// ---------------------------------------------------------------------------

export interface PlanWarning {
  rule: string;
  message: string;
}

export interface CheckContext extends TargetContext {
  weekStart: string;
  style: PlanStyle;
  today: string;
  profile: Record<string, string>;
  /** 最近 60 天以上的跑步（不含重複與已移除的） */
  workouts: Workout[];
  races: Race[];
  recovery: RecoverySignals | null;
  /** 最近的其他運動（騎車、游泳、肌力訓練等）：前一天騎很久，隔天不排強度課 */
  others: OtherActivity[];
}

/** 其他運動算「很久或很硬」的門檻：隔天不排強度課 */
const HEAVY_OTHER = { minutes: 90, load: 60 };

/**
 * 每堂強度課的量：Daniels 的上限（週跑量的比例與公里數）。週跑量低時，至少允許一堂常見的最短量
 * （floorMin 分鐘，以該配速換算；沒有配速時用 floorKm）——我們的調整，否則跑量低的人排不出一堂 20 分鐘的 T。
 */
const QUALITY_CAPS: Record<"M" | "T" | "I" | "R", { share: number; max: number; floorMin: number; floorKm: number }> = {
  T: { share: 0.1, max: Infinity, floorMin: 20, floorKm: 4 },
  I: { share: 0.08, max: 10, floorMin: 15, floorKm: 3 },
  R: { share: 0.05, max: 8, floorMin: 10, floorKm: 2 },
  M: { share: 0.2, max: 29, floorMin: 40, floorKm: 7 },
};
/** 長跑佔週跑量的比例只在每週跑這麼多次以上時檢查：次數少時每一趟本來就佔比較大（我們的調整） */
const LONG_SHARE_MIN_RUNS = 5;
const MILE_KM = 1.6;

const WEEKDAY_SHORT = ["一", "二", "三", "四", "五", "六", "日"];

/** 「週一、週五」「星期六」→ 星期的索引（星期一 = 0） */
export function parseWeekdays(text: string | undefined): number[] {
  if (!text) return [];
  return [...text.matchAll(/(?:週|星期|禮拜)([一二三四五六日天])/g)].map((m) => (m[1] === "天" ? 6 : WEEKDAY_SHORT.indexOf(m[1]!)));
}

const intOf = (value: string | undefined) => (value && /^\s*\d+\s*$/.test(value) ? Number(value) : null);

function label(session: SessionDraft, index: number): string {
  return session.date ? `${session.date.slice(5)}（${weekdayName(session.date)}）的${session.title}` : `第 ${index + 1} 堂（${session.title}）`;
}

/** 依教練方法與最近的訓練紀錄檢查課表；回傳問題，沒有問題時為空陣列 */
export function checkPlan(sessions: SessionDraft[], ctx: CheckContext): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  const warn = (rule: string, message: string) => warnings.push({ rule, message });
  const estimates = sessions.map((s) => estimateSession(s, ctx));
  const runs = sessions.filter((s) => !NON_RUN_KINDS.has(s.kind));
  // 固定的課表：這週已經跑過、那天沒有排課的，也算進這週的跑量（彈性的菜單會把它們配進去，不重複算）
  const sessionDates = new Set(sessions.flatMap((s) => (s.date ? [s.date] : [])));
  const doneKm =
    ctx.style === "fixed"
      ? ctx.workouts
          .filter((w) => w.date >= ctx.weekStart && w.date < ctx.today && w.date <= addDays(ctx.weekStart, 6) && !sessionDates.has(w.date))
          .reduce((sum, w) => sum + (w.distance_km ?? 0), 0)
      : 0;
  const weekKm = estimates.reduce((sum, e) => sum + e.km, 0) + doneKm;
  const quality = sessions.map((s, i) => ({ s, i })).filter(({ s }) => QUALITY_KINDS.has(s.kind));

  // 1. 每週至少一天休息或很輕鬆
  if (ctx.style === "fixed") {
    const runDays = new Set(runs.map((s) => s.date));
    if (runDays.size >= 7) warn("rest_day", "這週每天都有跑，至少要有一天休息或很輕鬆。");
  } else if (runs.length >= 7) {
    warn("rest_day", "菜單有 7 堂以上的跑步，至少要有一天休息。");
  }

  // 2. 強度課一週最多兩堂，不連排兩天
  const intensity = ctx.profile.pref_intensity;
  const maxQuality = intensity === "easy" ? 0 : intensity === "moderate" ? 1 : 2;
  if (quality.length > maxQuality) {
    warn(
      "quality_count",
      intensity === "easy" || intensity === "moderate"
        ? `選手的強度偏好是「${intensity === "easy" ? "輕鬆就好" : "適度"}」，這週最多 ${maxQuality} 堂強度課，排了 ${quality.length} 堂。`
        : `強度課一週最多兩堂，排了 ${quality.length} 堂。`,
    );
  }
  const qualityDates = quality.flatMap(({ s }) => (s.date ? [s.date] : [])).sort();
  for (let i = 1; i < qualityDates.length; i++) {
    if (daysBetween(qualityDates[i - 1]!, qualityDates[i]!) <= 1) warn("quality_spacing", `強度課不要連排兩天：${qualityDates[i - 1]} 與 ${qualityDates[i]}。`);
  }

  // 3. 每堂強度課的量
  for (const { s, i } of quality) {
    for (const code of ["M", "T", "I", "R"] as const) {
      const km = estimates[i]!.qualityKm[code];
      if (!km) continue;
      const cap = QUALITY_CAPS[code];
      const pace = paceRange(code, ctx);
      const floor = pace ? (cap.floorMin * 60) / ((pace[0] + pace[1]) / 2) : cap.floorKm;
      const limit = Math.min(cap.max, Math.max(floor, weekKm * cap.share));
      // 上限本來就是約略的比例：超過 10% 以上才提醒，避免為了幾百公尺來回修改
      if (km > limit * 1.1) warn("quality_volume", `${label(s, i)}：${code} 配速的量約 ${round1(km)} km，超過上限 ${round1(limit)} km（週跑量 ${round1(weekKm)} km 的 ${Math.round(cap.share * 100)}%）。`);
    }
    if (!s.fallback) warn("fallback", `${label(s, i)} 沒有寫狀況不好時的替代（fallback）。`);
  }

  // 4. 長跑的比例與時間
  const longShare = weekKm >= 64 ? 0.25 : 0.3;
  sessions.forEach((s, i) => {
    if (s.kind !== "long") return;
    const e = estimates[i]!;
    if (e.minutes > 150) warn("long_run", `${label(s, i)} 約 ${Math.round(e.minutes)} 分鐘，長跑不超過 2.5 小時。`);
    else if (runs.length >= LONG_SHARE_MIN_RUNS && e.km > weekKm * longShare) warn("long_run", `${label(s, i)} 約 ${round1(e.km)} km，超過週跑量的 ${Math.round(longShare * 100)}%（${round1(weekKm * longShare)} km）。`);
  });

  // 5、6. 跑量的增加與單次距離：和最近的紀錄比
  const before = ctx.workouts.filter((w) => w.date < ctx.weekStart);
  const weekly = [1, 2, 3, 4].map((n) => {
    const start = addDays(ctx.weekStart, -7 * n);
    return before.filter((w) => w.date >= start && w.date < addDays(start, 7)).reduce((sum, w) => sum + (w.distance_km ?? 0), 0);
  });
  const recentWeeks = weekly.filter((km) => km > 0).length;
  const peak = Math.max(0, ...weekly);
  if (recentWeeks >= 2) {
    const limit = peak + runs.length * MILE_KM;
    if (weekKm > limit + 0.05) warn("weekly_volume", `這週約 ${round1(weekKm)} km，比最近四週最高的一週（${round1(peak)} km）多超過「每週次數 × 1.6 km」，上限約 ${round1(limit)} km。`);
  }
  const longest30 = Math.max(0, ...ctx.workouts.filter((w) => daysBetween(w.date, ctx.weekStart) <= 30).map((w) => w.distance_km ?? 0));
  if (longest30 > 0) {
    sessions.forEach((s, i) => {
      const km = estimates[i]!.km;
      if (s.kind !== "race" && km > longest30 * 1.1 + 0.05) warn("single_run", `${label(s, i)} 約 ${round1(km)} km，比最近 30 天最長的一趟（${round1(longest30)} km）多 10% 以上。`);
    });
  }

  // 7. 停跑一週以上：跑量約原本的一半，先不排強度課
  const last = [...before].sort((a, b) => b.date.localeCompare(a.date))[0];
  if (last && daysBetween(last.date, ctx.weekStart) >= 8) {
    const preBreak = before.filter((w) => daysBetween(w.date, last.date) < 28).reduce((sum, w) => sum + (w.distance_km ?? 0), 0) / 4;
    if (quality.length) warn("after_break", `最近停跑了 ${daysBetween(last.date, ctx.weekStart) - 1} 天，先只排輕鬆跑，跑得穩定後再恢復強度課。`);
    if (preBreak > 0 && weekKm > preBreak * 0.5 + 0.05) warn("after_break", `停跑後第一週的跑量約原本的一半（約 ${round1(preBreak * 0.5)} km），這週約 ${round1(weekKm)} km。`);
  }

  // 8. 三週內有比賽：減量
  const weekEnd = addDays(ctx.weekStart, 6);
  const race = ctx.races
    // 考慮中的比賽不要求減量（規格 12.15）：排課時另外提醒
    .filter((r) => r.confirmed && raceOutcome(r) === null && r.date >= ctx.weekStart && r.date <= addDays(weekEnd, 14))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (race && peak > 0) {
    const raceWeek = race.date <= weekEnd;
    const limit = peak * (raceWeek ? 0.6 : 0.7);
    if (weekKm > limit + 0.05) warn("taper", `${race.date} 有比賽「${race.name}」，${raceWeek ? "比賽這週" : "賽前"}的跑量要減少（約 ${round1(limit)} km 以下，最近四週最高 ${round1(peak)} km），這週約 ${round1(weekKm)} km。`);
  }

  // 9. 選手的偏好：每週次數、每次最多多久、休息日、長跑日
  const perWeek = intOf(ctx.profile.pref_runs_per_week);
  if (perWeek !== null && runs.length > perWeek) warn("preference", `選手每週最多跑 ${perWeek} 次，排了 ${runs.length} 次。`);
  const maxMinutes = intOf(ctx.profile.pref_max_minutes);
  if (maxMinutes !== null) {
    sessions.forEach((s, i) => {
      if (s.kind !== "race" && estimates[i]!.minutes > maxMinutes + 1) warn("preference", `${label(s, i)} 約 ${Math.round(estimates[i]!.minutes)} 分鐘，選手每次最多 ${maxMinutes} 分鐘。`);
    });
  }
  if (ctx.style === "fixed") {
    const restDays = parseWeekdays(ctx.profile.pref_rest_days);
    sessions.forEach((s, i) => {
      if (s.date && !NON_RUN_KINDS.has(s.kind) && restDays.includes(weekdayIndex(s.date))) warn("preference", `${label(s, i)} 排在選手的休息日。`);
    });
    const longDays = parseWeekdays(ctx.profile.pref_long_run_day);
    sessions.forEach((s, i) => {
      if (s.kind === "long" && s.date && longDays.length && !longDays.includes(weekdayIndex(s.date))) warn("preference", `${label(s, i)} 不在選手的長跑日（${ctx.profile.pref_long_run_day}）。`);
    });
  }

  // 10. 今天的狀況不好：今天不排強度課
  const flags = [...(ctx.recovery?.selfFlags ?? []), ...(ctx.recovery?.watchFlags ?? [])];
  sessions.forEach((s, i) => {
    if (s.date === ctx.today && QUALITY_KINDS.has(s.kind) && flags.length) warn("today", `今天${flags.join("、")}，今天不要排強度課（${label(s, i)}）。`);
  });

  // 11. 肌力訓練不排在強度課前一天；前一天騎很久或很硬（已經做的或排進課表的），隔天不排強度課
  for (const { s, i } of quality) {
    if (!s.date) continue;
    const before = addDays(s.date, -1);
    if (sessions.some((x) => x.kind === "strength" && x.date === before)) {
      warn("strength_timing", `${label(s, i)} 的前一天排了肌力訓練；肌力訓練放在強度課當天（課後）或輕鬆日。`);
    }
    const heavyPlanned = sessions.some((x, j) => x.kind === "cross" && x.date === before && estimates[j]!.minutes >= HEAVY_OTHER.minutes);
    const heavyDone = ctx.others.find(
      (a) => (a.date === before || a.date === s.date) && ((a.duration_min ?? 0) >= HEAVY_OTHER.minutes || (a.training_load ?? 0) >= HEAVY_OTHER.load),
    );
    if (heavyPlanned || heavyDone) {
      warn(
        "cross_fatigue",
        heavyDone
          ? `${heavyDone.date} 有 ${Math.round(heavyDone.duration_min ?? 0)} 分鐘的其他運動（負荷 ${heavyDone.training_load ?? "?"}），${label(s, i)} 建議延後或減量。`
          : `${label(s, i)} 的前一天排了很久的交叉訓練，強度課建議延後或減量。`,
      );
    }
  }

  // 沒有配速依據：配速的目標會以體感顯示
  const usesPace = sessions.some((s) => s.steps.some((st) => (isRepeat(st) ? st.steps : [st]).some((x) => x.target && "pace" in x.target)));
  if (usesPace && !ctx.values.paces) warn("no_paces", "還沒有可以推算 VDOT 的成績，配速的目標會以體感顯示；可以請選手回報比賽成績或做一次計時跑。");

  return warnings;
}

// ---------------------------------------------------------------------------
// 顯示
// ---------------------------------------------------------------------------

export const STYLE_LABELS: Record<PlanStyle, string> = { fixed: "固定", flexible: "彈性（這週的菜單，哪天跑都可以）" };
export const STATUS_LABELS: Record<SessionStatus, string> = { planned: "", skipped: "已跳過", fallback: "改用替代" };

export interface SessionView {
  id: number | null;
  date: string | null;
  /** 例：10-21（星期二） */
  when: string;
  kind: SessionKind;
  kindLabel: string;
  title: string;
  steps: string;
  km: number;
  minutes: number;
  purpose: string;
  success: string;
  fallback: string | null;
  status: SessionStatus;
  note: string | null;
}

export function sessionView(session: SessionDraft & Partial<Pick<PlannedSession, "id" | "status" | "note">>, ctx: TargetContext): SessionView {
  const e = estimateSession(session, ctx);
  return {
    id: session.id ?? null,
    date: session.date,
    when: session.date ? `${session.date.slice(5)}（${weekdayName(session.date)}）` : "這週任一天",
    kind: session.kind,
    kindLabel: SESSION_KINDS[session.kind],
    title: session.title,
    steps: stepsText(session, ctx),
    km: round1(e.km),
    minutes: Math.round(e.minutes),
    purpose: session.purpose,
    success: session.success,
    fallback: session.fallback,
    status: session.status ?? "planned",
    note: session.note ?? null,
  };
}

/** 依日期排序；彈性的（沒有日期）照原本的順序放在後面 */
export function sortSessions<T extends { date: string | null }>(sessions: T[]): T[] {
  return sessions
    .map((s, i) => ({ s, i }))
    .sort((a, b) => (a.s.date ?? "9999").localeCompare(b.s.date ?? "9999") || a.i - b.i)
    .map(({ s }) => s);
}

/** 課表的 Markdown（存在 training_plans.content：v1 與 Discord 的 /plan 讀得到；工具與網頁版另外即時換算） */
export function planMarkdown(
  plan: { weekLabel: string; weekStart: string; style: PlanStyle; reason: string; outline: string | null; notes: string | null },
  sessions: (SessionDraft & Partial<Pick<PlannedSession, "id" | "status" | "note">>)[],
  ctx: TargetContext,
): string {
  const views = sortSessions(sessions).map((s) => sessionView(s, ctx));
  const total = views.reduce((sum, v) => sum + v.km, 0);
  const lines = [`**${plan.weekLabel}（${plan.weekStart.slice(5)} 起）｜${STYLE_LABELS[plan.style]}｜約 ${round1(total)} km**`];
  if (plan.reason) lines.push(`原因：${plan.reason}`);
  lines.push("");
  for (const v of views) {
    const status = STATUS_LABELS[v.status];
    lines.push(`- ${v.when}｜${v.kindLabel}：${v.title}${status ? `（${status}）` : ""}`);
    if (v.steps) lines.push(`  - ${v.steps}（約 ${v.km} km、${v.minutes} 分鐘）`);
    const detail = [v.purpose && `目的：${v.purpose}`, v.success && `完成的標準：${v.success}`, v.fallback && `狀況不好時：${v.fallback}`].filter(Boolean);
    if (detail.length) lines.push(`  - ${detail.join("；")}`);
  }
  if (plan.notes) lines.push("", `檢查器的提醒與理由：${plan.notes}`);
  if (plan.outline) lines.push("", "**之後幾週**", plan.outline);
  return lines.join("\n");
}

/** 最近輕鬆跑的平均配速，沒有配速依據時估算距離用；沒有紀錄時用 7:00/km */
export function typicalPaceSec(workouts: Workout[]): number {
  const paces = workouts.flatMap((w) => {
    const p = w.avg_pace ? parsePace(w.avg_pace) : null;
    return p ? [p] : [];
  });
  if (!paces.length) return 420;
  const sorted = [...paces].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}
