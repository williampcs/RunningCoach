/**
 * 結構化課表（規格 12.8 的第三步 3a）：一堂一堂的課、以代號寫的目標、檢查器.
 *
 * - 目標寫代號（Daniels 的 E/M/T/I/R 配速、輕鬆跑的心率上限、心率區間、體感），由程式依訓練數值換算，
 *   模型寫不出自己編的配速；VDOT 更新後，還沒跑的課跟著更新。
 * - 強度課的配速先取保守的一端：範圍是 Daniels 的配速到慢 6 秒（想要挑戰的人改為前後 3 秒）。
 * - 檢查器依教練方法（coaching-method.ts）與最近的訓練紀錄檢查，只警告、不硬擋：
 *   教練要修改，或寫出理由後才能存。例外是傷病（規格 12.33）：會痛的運動的強度課與長課、有紅旗時的所有課
 *   是「不能保留」的（blocking），寫理由也不能存。
 */
import { addDays, daysBetween, weekdayIndex, weekdayName } from "./dates";
import { formatPace, parsePace } from "./fake-activities";
import type { RecoverySignals } from "./recovery";
import { ALLOCATION_RULES, type WeekAllocation } from "./allocation";
import { raceOutcome } from "./races";
import { hardBlockReason, injuryAffects, injuryName, injurySportsText, isOpen, PAIN_LIMIT, type Injury } from "./injuries";
import type { TrainingValues } from "./training-values";
import {
  athleteSports,
  CROSS_SPORTS,
  DEFAULT_RIDE_KMH,
  missingSettingsHint,
  powerRange,
  SHORT_INTERVAL_MIN,
  sportOfType,
  SPORT_LABELS,
  SWEET_SPOT,
  sweetSpotHr,
  sweetSpotPower,
  zoneLevel,
  zoneRpe,
  type SportTargets,
} from "./sports";
import type { OtherActivity, Race, Sport, Workout } from "./types";

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
  // 單車的課（多運動的開關開著時，規格 12.24 的第 3 階段；doc/coaching-method-cycling.md）
  ride_recovery: "恢復騎",
  ride_endurance: "耐力騎",
  ride_long: "長騎",
  ride_tempo: "節奏騎",
  ride_sweetspot: "甜蜜點",
  ride_threshold: "閾值騎",
  ride_vo2: "最大攝氧間歇",
  ride_anaerobic: "無氧與衝刺",
} as const;
export type SessionKind = keyof typeof SESSION_KINDS;

/** 跑步的強度課：一週最多兩堂、不連排兩天，要附狀況不好時的替代 */
export const QUALITY_KINDS: ReadonlySet<SessionKind> = new Set(["marathon", "threshold", "interval", "repetition"]);
/** 單車的課（sport 是 ride） */
export const RIDE_KINDS: ReadonlySet<SessionKind> = new Set([
  "ride_recovery",
  "ride_endurance",
  "ride_long",
  "ride_tempo",
  "ride_sweetspot",
  "ride_threshold",
  "ride_vo2",
  "ride_anaerobic",
]);
/** 單車的強度課（節奏以上）：和跑步的強度課合計數量與間隔 */
export const RIDE_QUALITY_KINDS: ReadonlySet<SessionKind> = new Set(["ride_tempo", "ride_sweetspot", "ride_threshold", "ride_vo2", "ride_anaerobic"]);
/** 不是跑步的課：不算跑量 */
export const NON_RUN_KINDS: ReadonlySet<SessionKind> = new Set(["rest", "cross", "strength", ...RIDE_KINDS]);

/** 跑步或單車的強度課：要附狀況不好時的替代 */
export const isQualityKind = (kind: SessionKind) => QUALITY_KINDS.has(kind) || RIDE_QUALITY_KINDS.has(kind);

/** 一堂課的運動：跑步的課是 run，單車的課是 ride，交叉訓練看 sport（沒寫的舊課是 null），肌力是 strength，休息是 null */
export function sessionSport(s: Pick<SessionDraft, "kind" | "sport">): Sport | null {
  if (RIDE_KINDS.has(s.kind)) return "ride";
  if (s.kind === "cross") return s.sport ?? null;
  if (s.kind === "strength") return "strength";
  if (s.kind === "rest") return null;
  return "run";
}

/** 目標用哪項運動的區間換算：單車的課與寫了運動的交叉訓練用那項運動的；其他（跑步、沒寫運動的舊課）用跑步的 */
const targetSport = (s: Pick<SessionDraft, "kind" | "sport">): Sport | null => (RIDE_KINDS.has(s.kind) ? "ride" : s.kind === "cross" ? (s.sport ?? null) : null);

export type PaceCode = "E" | "M" | "T" | "I" | "R";
const PACE_CODES: readonly PaceCode[] = ["E", "M", "T", "I", "R"];

/**
 * 一步的目標：Daniels 配速、輕鬆跑的心率上限、心率區間（例：Z2）、功率區間（騎車，例：Z2）或體感（1–10）.
 * 心率與功率依那堂課的運動換算（交叉訓練的 sport，規格 12.24）
 */
export type Target = { pace: PaceCode } | { hr: "easy" } | { zone: string } | { power: string } | { rpe: [number, number] };

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
  /** 交叉訓練是哪種運動（ride、swim、other；規格 12.24）：心率與功率的目標用那項運動的設定換算。沒有時（舊的課）照跑步 */
  sport?: Sport | null;
}

export type SessionStatus = "planned" | "skipped" | "fallback";

export interface PlannedSession extends SessionDraft {
  id: number;
  plan_id: number;
  status: SessionStatus;
  /** 跳過、改用替代或移動的原因 */
  note: string | null;
  /** 選手在 App 裡回報做完的時間（肌力等沒有手錶紀錄的課，規格 12.24）；沒有回報時為 null */
  done_at?: string | null;
  /** 教練改過這堂課的內容的時間（edit_planned_session，規格 12.31）；沒改過時為 null */
  edited_at?: string | null;
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
  ride_recovery: [1, 2],
  ride_endurance: [2, 4],
  ride_long: [3, 5],
  ride_tempo: [5, 6],
  ride_sweetspot: [6, 7],
  ride_threshold: [6, 7],
  ride_vo2: [8, 9],
  ride_anaerobic: [8, 10],
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

function parseTarget(value: unknown, where: string, ride = false): Target | undefined {
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
  if (typeof t.power === "string" && /^Z\d$/i.test(t.power)) return { power: t.power.toUpperCase() };
  // 甜蜜點（FTP 的 88–94%）只給騎車
  for (const key of ["zone", "power"] as const) {
    if (typeof t[key] === "string" && (t[key] as string).toUpperCase() === SWEET_SPOT) {
      if (!ride) throw new Error(`${where} 的甜蜜點（SS）只能用在騎車的課`);
      return key === "zone" ? { zone: SWEET_SPOT } : { power: SWEET_SPOT };
    }
  }
  if (Array.isArray(t.rpe) && t.rpe.length === 2) {
    const [lo, hi] = t.rpe.map(Number) as [number, number];
    if (lo >= 1 && hi <= 10 && lo <= hi) return { rpe: [lo, hi] };
  }
  throw new Error(`${where} 的 target 要寫代號：{"pace":"T"}、{"hr":"easy"}、{"zone":"Z2"} 或 {"rpe":[6,7]}，不要寫數字的配速`);
}

function parseStep(value: unknown, where: string, power = false): Step {
  if (typeof value !== "object" || value === null) throw new Error(`${where} 格式不對`);
  const s = value as Record<string, unknown>;
  const step: Step = {
    distance_km: positive(s.distance_km, `${where} 的 distance_km`),
    duration_min: positive(s.duration_min, `${where} 的 duration_min`),
    target: parseTarget(s.target, where, power),
    note: typeof s.note === "string" && s.note.trim() ? s.note.trim() : undefined,
  };
  if (step.distance_km === undefined && step.duration_min === undefined) throw new Error(`${where} 要有 distance_km 或 duration_min`);
  if (step.target && "power" in step.target && !power) throw new Error(`${where} 的功率目標（power）只能用在騎車的課（單車的課或 sport=ride 的交叉訓練）`);
  return step;
}

function parseSteps(value: unknown, where: string, power = false): PlanStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw, i) => {
    const at = `${where}第 ${i + 1} 步`;
    if (typeof raw === "object" && raw !== null && "repeat" in raw) {
      const r = raw as Record<string, unknown>;
      const times = Number(r.repeat);
      if (!Number.isInteger(times) || times < 1 || times > 30) throw new Error(`${at} 的 repeat 要是 1–30 的整數`);
      const inner = Array.isArray(r.steps) ? r.steps.map((x, j) => parseStep(x, `${at}的第 ${j + 1} 段`, power)) : [];
      if (!inner.length) throw new Error(`${at} 的重複組沒有內容`);
      return { repeat: times, steps: inner };
    }
    return parseStep(raw, at, power);
  });
}

/**
 * 工具輸入的 sessions → 課的草稿；固定的課表每堂都要有這週的日期.
 * multisport（功能開關，規格 12.24）：交叉訓練要寫 sport，目標依那項運動的設定換算
 */
export function parseSessions(value: unknown, weekStart: string, style: PlanStyle, options: { multisport?: boolean } = {}): SessionDraft[] {
  if (!Array.isArray(value) || !value.length) throw new Error("sessions 至少要有一堂課");
  const weekEnd = addDays(weekStart, 6);
  return value.map((raw, i) => {
    const where = `第 ${i + 1} 堂課`;
    if (typeof raw !== "object" || raw === null) throw new Error(`${where} 格式不對`);
    const s = raw as Record<string, unknown>;
    const kind = String(s.kind ?? "") as SessionKind;
    const kinds = Object.keys(SESSION_KINDS).filter((k) => options.multisport || !RIDE_KINDS.has(k as SessionKind));
    if (!kinds.includes(kind)) throw new Error(`${where} 的 kind 只能是 ${kinds.join("、")}`);
    const date = typeof s.date === "string" && s.date ? s.date : null;
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`${where} 的 date 格式要是 YYYY-MM-DD`);
    if (style === "fixed" && !date) throw new Error(`${where} 沒有日期；固定的課表每堂都要有日期（彈性的才可以不填）`);
    if (date && (date < weekStart || date > weekEnd)) throw new Error(`${where} 的日期 ${date} 不在這週（${weekStart}～${weekEnd}）`);
    let sport: Sport | null = null;
    if (options.multisport && kind === "cross") {
      const value = typeof s.sport === "string" ? s.sport.trim().toLowerCase() : "";
      if (!(CROSS_SPORTS as string[]).includes(value)) throw new Error(`${where} 是交叉訓練，要寫 sport：${CROSS_SPORTS.join("、")}`);
      sport = value as Sport;
    }
    if (RIDE_KINDS.has(kind)) sport = "ride";
    const steps = parseSteps(s.steps, `${where}的`, sport === "ride");
    if (!NON_RUN_KINDS.has(kind) && !steps.length) throw new Error(`${where} 沒有 steps`);
    const text = (key: string) => (typeof s[key] === "string" ? (s[key] as string).trim() : "");
    return {
      ...(sport ? { sport } : {}),
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
  /** 跑步以外的運動的目標換算依據（規格 12.24）；交叉訓練與單車的課用 */
  sports?: Partial<Record<Sport, SportTargets>>;
  /** 估算騎車時間與距離的均速（km/h）：最近騎車的平均；沒有時用 DEFAULT_RIDE_KMH */
  rideKmh?: number;
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

const hrRange = (z: { min: number | null; max: number | null }) => (z.min === null ? `≤${z.max}` : `${z.min}–${z.max}`);

/**
 * 跑步以外的運動（交叉訓練的 sport、單車的課）：用那項運動自己的心率與功率區間；沒有設定時不拿跑步的硬套，改成體感並說明.
 * 例：「心率 Z2（121–135）」「功率 Z2（130–173 W）」「體感 2–4/10（Z2；騎車的心率區間還沒在 Intervals.icu 設定）」.
 * minutes：這一步的長度；沒有功率時，5 分鐘以內、Z5 以上的短間歇心率跟不上，改看體感
 */
function sportTargetText(target: Target, sport: Sport, ctx: TargetContext, minutes?: number): string {
  const t = ctx.sports?.[sport];
  if ("rpe" in target) return `體感 ${target.rpe[0]}–${target.rpe[1]}/10`;
  if ("pace" in target) {
    const [lo, hi] = PACE_RPE[target.pace];
    return `體感 ${lo}–${hi}/10`;
  }
  const code = "zone" in target ? target.zone : "power" in target ? target.power : "Z2";
  const sweet = code === SWEET_SPOT;
  const name = sweet ? "甜蜜點" : code;
  if ("power" in target) {
    const watts = sweet ? sweetSpotPower(t) : null;
    if (watts) return `功率 甜蜜點（${watts[0]}–${watts[1]} W）`;
    const zone = t?.power?.find((z) => z.name === code);
    if (zone) return `功率 ${zone.name}（${powerRange(zone)}）`;
  }
  // 沒有功率：心率跟不上短的高強度間歇，看體感
  if (minutes !== undefined && minutes <= SHORT_INTERVAL_MIN && zoneLevel(code) >= 5) {
    const [lo, hi] = zoneRpe(code);
    return `體感 ${lo}–${hi}/10（短間歇，心率跟不上；後段心率到 ${code}）`;
  }
  const noPower = "power" in target ? `${missingSettingsHint(sport, "power")}，改看心率` : "";
  if (t?.hr) {
    if ("hr" in target) return `心率 ≤${t.hr.easyMax}`;
    const bpm = sweet ? sweetSpotHr(t) : null;
    if (bpm) return `心率 甜蜜點（${bpm[0]}–${bpm[1]}${noPower ? `；${noPower}` : ""}）`;
    const zone = t.hr.zones.find((z) => z.name === code);
    if (zone) return `心率 ${zone.name}（${hrRange(zone)}${noPower ? `；${noPower}` : ""}）`;
  }
  const [lo, hi] = "hr" in target ? [2, 4] : zoneRpe(code);
  const missing = "power" in target ? `${missingSettingsHint(sport, "power")}，${missingSettingsHint(sport, "hr")}` : missingSettingsHint(sport, "hr");
  return `體感 ${lo}–${hi}/10（${"hr" in target ? "輕鬆" : name}；${missing}）`;
}

/**
 * 目標的文字，例：「5:05–5:11/km（T）」「心率 ≤153」「體感 6–7/10」；sport 是課的運動（跑步以外時用那項運動的區間）.
 * minutes：這一步的長度（單車的短間歇看體感）
 */
export function targetText(target: Target | undefined, ctx: TargetContext, sport?: Sport | null, minutes?: number): string {
  if (!target) return "";
  if (sport && sport !== "run") return sportTargetText(target, sport, ctx, minutes);
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
    return zone ? `心率 ${zone.name}（${hrRange(zone)}）` : `心率 ${target.zone}`;
  }
  if ("power" in target) return `功率 ${target.power}`;
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

function stepEstimate(step: Step, ctx: TargetContext, sport?: Sport | null): { km: number; minutes: number } {
  if (sport === "ride") {
    // 騎車：以時間為主；寫距離時用最近騎車的均速估算
    const kmh = ctx.rideKmh ?? DEFAULT_RIDE_KMH;
    const minutes = step.duration_min ?? ((step.distance_km ?? 0) / kmh) * 60;
    return { km: step.distance_km ?? (minutes / 60) * kmh, minutes };
  }
  const pace = paceSecOf(step.target, ctx);
  const km = step.distance_km ?? ((step.duration_min ?? 0) * 60) / pace;
  const minutes = step.duration_min ?? (km * pace) / 60;
  return { km, minutes };
}

export function estimateSession(session: SessionDraft, ctx: TargetContext): SessionEstimate {
  const out: SessionEstimate = { km: 0, minutes: 0, qualityKm: { M: 0, T: 0, I: 0, R: 0 } };
  const sport = sessionSport(session);
  const add = (step: Step, times: number) => {
    const e = stepEstimate(step, ctx, sport);
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

/** 時間的文字：不到一分鐘寫秒（20 秒），十分鐘內有零頭寫「1 分 30 秒」，其他寫分鐘 */
export function minutesText(minutes: number): string {
  const sec = Math.round(minutes * 60);
  if (sec < 60) return `${sec} 秒`;
  if (sec % 60 && minutes < 10) return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return `${Math.round(minutes)} 分鐘`;
}

function lengthText(step: Step): string {
  if (step.distance_km !== undefined) return `${round1(step.distance_km)} km`;
  return minutesText(step.duration_min ?? 0);
}

function stepText(step: Step, ctx: TargetContext, sport?: Sport | null): string {
  const target = targetText(step.target, ctx, sport, step.duration_min);
  return [lengthText(step), target, step.note ? `（${step.note}）` : ""].filter(Boolean).join(" ");
}

/** 一堂課的步驟，例：「15 分鐘 心率 ≤153｜5 ×（1 km 5:05–5:11/km（T）＋ 2 分鐘 能聊天）｜10 分鐘 心率 ≤153」 */
export function stepsText(session: SessionDraft, ctx: TargetContext): string {
  const sport = targetSport(session);
  return session.steps
    .map((step) =>
      isRepeat(step) ? `${step.repeat} ×（${step.steps.map((s) => stepText(s, ctx, sport)).join(" ＋ ")}）` : stepText(step, ctx, sport),
    )
    .join("｜");
}

type Raw = Record<string, unknown>;
function rawOf(json: string | null | undefined): Raw {
  try {
    const value: unknown = json ? JSON.parse(json) : null;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Raw) : {};
  } catch {
    return {};
  }
}
const nums = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);

/**
 * 依心率區間的時間：低強度與以上的分鐘（閾值心率 90% 以下為低）；沒有資料時為 null.
 * 跑步以外的運動也適用：Intervals.icu 每筆活動的區間與閾值心率是那項運動自己的設定
 */
export function intensityMinutes(w: { raw_json?: string | null }, fallbackLthr: number | null): { low: number; above: number } | null {
  const r = rawOf(w.raw_json);
  const times = nums(r.icu_hr_zone_times);
  const bounds = nums(r.icu_hr_zones);
  const lthr = typeof r.lthr === "number" ? r.lthr : fallbackLthr;
  if (!times?.length || !bounds?.length || !lthr) return null;
  let low = 0;
  let above = 0;
  times.forEach((secs, i) => {
    const upper = bounds[i];
    if (upper !== undefined && upper <= lthr * 0.9) low += secs;
    else above += secs;
  });
  return { low: low / 60, above: above / 60 };
}

// ---------------------------------------------------------------------------
// 檢查器
// ---------------------------------------------------------------------------

export interface PlanWarning {
  rule: string;
  message: string;
  /** 不能保留（傷病，規格 12.33）：寫理由也不能存，一定要改 */
  blocking?: boolean;
  /** 和哪一堂課有關（sessions 的索引）；只改一堂課時用來判斷是不是這一堂 */
  session?: number;
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
  /**
   * 多運動（功能開關，規格 12.24）：做過或排進課表的高強度交叉訓練，也算進強度課的數量與間隔，
   * 課表外的運動之後重排（A → A'）時檢查得到
   */
  multisport?: boolean;
  /** 這週的額度（練騎車的人，allocation.ts）；沒有時照強度偏好檢查 */
  allocation?: WeekAllocation | null;
  /** 還沒好的傷病（規格 12.33）：會痛的運動的強度課與長課不能排、有紅旗時都不排 */
  injuries?: Injury[];
}

/** 其他運動算「很久或很硬」的門檻：隔天不排強度課 */
const HEAVY_OTHER = { minutes: 90, load: 60 };
/** 交叉訓練算「強度課」：中強度以上（閾值心率的 90% 以上）15 分鐘以上，和配對跑步時「像強度課」的門檻一樣（規格 12.24） */
const HARD_CROSS_MINUTES = 15;

/** 做過的其他運動像不像一堂強度課：依它自己的心率區間時間（沒有區間資料時看不出來，不算） */
export function isHardOther(a: OtherActivity): boolean {
  const i = intensityMinutes(a, null);
  return !!i && i.above >= HARD_CROSS_MINUTES;
}

/** 排進課表的交叉訓練像不像一堂強度課：中、高強度的步驟合計 15 分鐘以上 */
export function isHardCross(session: SessionDraft, ctx: TargetContext): boolean {
  if (session.kind !== "cross") return false;
  let minutes = 0;
  const add = (step: Step, times: number) => {
    const level = intensityOf(step.target, session.kind);
    if (level === "moderate" || level === "high") minutes += stepEstimate(step, ctx, session.sport).minutes * times;
  };
  for (const step of session.steps) {
    if (isRepeat(step)) for (const inner of step.steps) add(inner, step.repeat);
    else add(step, 1);
  }
  return minutes >= HARD_CROSS_MINUTES;
}

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

/** 傷病時不能排的「強度課與長課」：跑步與單車的強度課、長跑、長騎、比賽、高強度的交叉訓練 */
export function isHardSession(session: SessionDraft, ctx: TargetContext): boolean {
  return isQualityKind(session.kind) || ["long", "ride_long", "race"].includes(session.kind) || isHardCross(session, ctx);
}

/**
 * 傷病的規則（規格 12.33 第 3 點）. 只看今天以後（含沒有日期的菜單）的課，休息不算：
 * - 有紅旗、還沒經醫師排除：所有運動的課都不能排（不能保留）。
 * - 會痛的運動（不知道時是全部）：疼痛超過 3/10 或超過 3 天沒有回報分數時，強度課與長課不能排（不能保留）；
 *   其他的課照疼痛規則提醒，教練要確認選手的狀況、寫理由才能保留。
 */
export function injuryWarnings(sessions: SessionDraft[], ctx: Pick<CheckContext, "today" | "injuries"> & TargetContext): PlanWarning[] {
  const open = (ctx.injuries ?? []).filter(isOpen);
  if (!open.length) return [];
  const upcoming = sessions.map((s, i) => ({ s, i })).filter(({ s }) => s.kind !== "rest" && (!s.date || s.date >= ctx.today));
  const out: PlanWarning[] = [];
  const flagged = open.filter((x) => x.red_flag);
  if (flagged.length) {
    const names = flagged.map(injuryName).join("、");
    for (const { s, i } of upcoming) {
      out.push({
        rule: "injury_red_flag",
        blocking: true,
        session: i,
        message: `${label(s, i)}：${names}有需要就醫的警訊、還沒經醫師排除，所有運動都先不排（不能保留）。請選手先就醫；醫師說可以運動後，再取消紅旗。`,
      });
    }
    return out;
  }
  const painful: string[] = [];
  const affectedBy = new Set<Injury>();
  for (const { s, i } of upcoming) {
    const affecting = open.filter((x) => injuryAffects(x, sessionSport(s)));
    if (!affecting.length) continue;
    const blockers = affecting.flatMap((x) => hardBlockReason(x, ctx.today) ?? []);
    if (isHardSession(s, ctx) && blockers.length) {
      out.push({
        rule: "injury_block",
        blocking: true,
        session: i,
        message: `${label(s, i)}：${blockers.join("；")}，會痛的運動的強度課與長課不能排（不能保留）；改成不痛的運動、很輕鬆的課或休息。`,
      });
    } else {
      painful.push(label(s, i));
      for (const x of affecting) affectedBy.add(x);
    }
  }
  if (painful.length) {
    const which = [...affectedBy].map((x) => `${injuryName(x)}（會痛的運動：${injurySportsText(x)}）`).join("、");
    out.push({
      rule: "injury_pain",
      message:
        `${painful.join("、")} 是會痛的運動，${which}還沒好。照疼痛規則：運動中不超過 ${PAIN_LIMIT}/10、隔天早上回到平常、沒有越來越痛才可以做，量要降低；` +
        "先問過選手現在的分數，寫理由才能保留，不然改成不痛的運動或休息。",
    });
  }
  return out;
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

  // 1. 每週至少一天休息或很輕鬆（多運動：跑步與騎車一起算，恢復騎與肌力算輕鬆）
  const training = ctx.multisport ? sessions.filter((s) => !["rest", "strength", "ride_recovery"].includes(s.kind)) : runs;
  if (ctx.multisport && training.length > runs.length) {
    if (ctx.style === "fixed") {
      if (new Set(training.map((s) => s.date)).size >= 7) warn("rest_day", "這週每天都有跑步或騎車，至少要有一天休息或恢復騎。");
    } else if (training.length >= 7) warn("rest_day", "菜單有 7 堂以上的跑步與騎車，至少要有一天休息或恢復騎。");
  } else if (ctx.style === "fixed") {
    const runDays = new Set(runs.map((s) => s.date));
    if (runDays.size >= 7) warn("rest_day", "這週每天都有跑，至少要有一天休息或很輕鬆。");
  } else if (runs.length >= 7) {
    warn("rest_day", "菜單有 7 堂以上的跑步，至少要有一天休息。");
  }

  // 2. 強度課一週最多兩堂，不連排兩天
  const intensity = ctx.profile.pref_intensity;
  const maxQuality = intensity === "easy" ? 0 : intensity === "moderate" ? 1 : 2;
  // 單車的強度課（多運動）：騎車的強度偏好是輕鬆就好時，可以有一堂少量的節奏騎，不算
  const rideQualityAll = sessions.map((s, i) => ({ s, i })).filter(({ s }) => RIDE_QUALITY_KINDS.has(s.kind));
  const rideIntensity = ctx.profile.pref_intensity_ride || intensity;
  const tempoFree = rideIntensity === "easy" && rideQualityAll.filter(({ s }) => s.kind === "ride_tempo").length === 1 ? 1 : 0;
  const rideQuality = tempoFree ? rideQualityAll.filter(({ s }) => s.kind !== "ride_tempo") : rideQualityAll;
  const cycling = !!ctx.multisport && (athleteSports(ctx.profile).includes("ride") || rideQualityAll.length > 0);
  // 練騎車的人：強度課與時間照這週的額度（allocation.ts，規格 12.26 第 4 點）
  const allocation = cycling ? (ctx.allocation ?? null) : null;
  if (!allocation && quality.length > maxQuality) {
    warn(
      "quality_count",
      intensity === "easy" || intensity === "moderate"
        ? `選手的強度偏好是「${intensity === "easy" ? "輕鬆就好" : "適度"}」，這週最多 ${maxQuality} 堂強度課，排了 ${quality.length} 堂。`
        : `強度課一週最多兩堂，排了 ${quality.length} 堂。`,
    );
  }
  // 多運動：這週已經做過的高強度交叉訓練（今天以前、沒有排進課表的那天）與排進課表的，一起算（規格 12.24）
  const weekEnd = addDays(ctx.weekStart, 6);
  const rideSessionDates = new Set(sessions.flatMap((x) => (x.date && RIDE_KINDS.has(x.kind) ? [x.date] : [])));
  const hardDone = ctx.multisport
    ? ctx.others.filter(
        (a) => a.date >= ctx.weekStart && a.date <= weekEnd && a.date < ctx.today && isHardOther(a) && !(cycling && rideSessionDates.has(a.date) && sportOfType(a.type) === "ride"),
      )
    : [];
  const hardPlanned = ctx.multisport ? sessions.filter((x) => isHardCross(x, ctx) && !(x.date && x.date < ctx.today)) : [];
  const hardCross = hardDone.length + hardPlanned.length;
  if (cycling) {
    const runQ = quality.length;
    const rideQ = rideQuality.length + hardCross;
    const cap = allocation?.qualityCap ?? ALLOCATION_RULES.qualityCap;
    const reason = allocation?.reasons[0] ? `（${allocation.reasons[0]}）` : "";
    const allowed = (sport: "run" | "ride") => allocation?.sports.find((x) => x.sport === sport)?.quality ?? null;
    const runAllowed = allowed("run");
    const rideAllowed = allowed("ride");
    if (runAllowed !== null && runQ > runAllowed) warn("allocation", `跑步的強度課這週的額度是 ${runAllowed} 堂，排了 ${runQ} 堂${reason}。`);
    if (rideAllowed !== null && rideQ > rideAllowed) {
      warn("allocation", `騎車（含高強度的交叉訓練）的強度課這週的額度是 ${rideAllowed} 堂，排了 ${rideQ} 堂${reason}。`);
    }
    if (runQ + rideQ > cap) {
      const parts = [runQ ? `跑步 ${runQ} 堂` : null, rideQuality.length ? `騎車 ${rideQuality.length} 堂` : null, hardCross ? `高強度的交叉訓練 ${hardCross} 堂` : null].filter(Boolean);
      warn("quality_count", `跑步與騎車的強度課兩項合計這週最多 ${cap} 堂，排了 ${parts.join("、")}，共 ${runQ + rideQ} 堂；少排一堂，或改成耐力騎、輕鬆跑。`);
    }
    if (allocation) {
      // 時間：騎車照額度（多 15% 以內不提醒）；跑步只在被主要運動減少時檢查（次數照「每週跑幾次」另外檢查）
      const minutesOf = (pred: (x: SessionDraft) => boolean) =>
        sessions.reduce((sum, x, j) => sum + (pred(x) && (!x.date || x.date >= ctx.today) ? estimates[j]!.minutes : 0), 0);
      const doneRide = ctx.others
        .filter((a) => a.date >= ctx.weekStart && a.date < ctx.today && sportOfType(a.type) === "ride")
        .reduce((sum, a) => sum + (a.duration_min ?? 0), 0);
      const ride = allocation.sports.find((x) => x.sport === "ride");
      const rideMinutes = minutesOf((x) => RIDE_KINDS.has(x.kind) || (x.kind === "cross" && x.sport === "ride")) + doneRide;
      if (ride && rideMinutes > ride.minutes * 1.15 + 1) {
        warn("allocation", `這週騎車約 ${Math.round(rideMinutes)} 分鐘，額度約 ${Math.round(ride.minutes)} 分鐘${reason}。`);
      }
      const run = allocation.sports.find((x) => x.sport === "run");
      const doneRun = ctx.workouts.filter((w) => w.date >= ctx.weekStart && w.date < ctx.today).reduce((sum, w) => sum + (w.duration_min ?? 0), 0);
      const runMinutes = minutesOf((x) => !NON_RUN_KINDS.has(x.kind)) + doneRun;
      if (run && run.minutes < run.wanted.minutes && runMinutes > run.minutes * 1.25 + 1) {
        warn("allocation", `這週跑步約 ${Math.round(runMinutes)} 分鐘，額度約 ${Math.round(run.minutes)} 分鐘${reason}。`);
      }
    }
  } else if (hardCross && quality.length <= maxQuality && quality.length + hardCross > maxQuality) {
    warn(
      "quality_count",
      `這週有 ${hardCross} 堂高強度的交叉訓練（${[...hardDone.map((a) => `${a.date.slice(5)} 已做`), ...hardPlanned.map((x) => (x.date ? x.date.slice(5) : x.title))].join("、")}），` +
        `加上 ${quality.length} 堂強度課共 ${quality.length + hardCross} 堂，超過這週的上限 ${maxQuality} 堂；交叉訓練改輕鬆，或少排一堂強度課。`,
    );
  }
  const hardDates = [...hardDone.map((a) => a.date), ...hardPlanned.flatMap((x) => (x.date ? [x.date] : []))];
  const rideDates = rideQualityAll.flatMap(({ s }) => (s.date ? [s.date] : []));
  const sessionQualityDates = [...new Set([...quality.flatMap(({ s }) => (s.date ? [s.date] : [])), ...rideDates])];
  const qualityDates = [...sessionQualityDates, ...new Set(hardDates.filter((d) => !sessionQualityDates.includes(d)))].sort();
  for (let i = 1; i < qualityDates.length; i++) {
    const [prev, day] = [qualityDates[i - 1]!, qualityDates[i]!];
    if (daysBetween(prev, day) > 1) continue;
    const cross = hardDates.includes(prev) || hardDates.includes(day);
    const rode = rideDates.includes(prev) || rideDates.includes(day);
    // 含交叉訓練、兩天都已經過去時，課表改不了，不提醒
    if (cross && day < ctx.today) continue;
    warn("quality_spacing", `強度課不要連排兩天：${prev} 與 ${day}${cross ? "（含高強度的交叉訓練）" : rode ? "（跑步與騎車的強度課一起算）" : ""}。`);
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
  const race = ctx.races
    // 考慮中的比賽不要求減量（規格 12.15）：排課時另外提醒
    .filter((r) => r.confirmed && raceOutcome(r) === null && (r.sport ?? "run") === "run" && r.date >= ctx.weekStart && r.date <= addDays(weekEnd, 14))
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (race && peak > 0) {
    const raceWeek = race.date <= weekEnd;
    const limit = peak * (raceWeek ? 0.6 : 0.7);
    if (weekKm > limit + 0.05) warn("taper", `${race.date} 有比賽「${race.name}」，${raceWeek ? "比賽這週" : "賽前"}的跑量要減少（約 ${round1(limit)} km 以下，最近四週最高 ${round1(peak)} km），這週約 ${round1(weekKm)} km。`);
  }

  // 9. 選手的偏好：每週次數、每次最多多久、休息日、長跑日
  const perWeek = intOf(ctx.profile.pref_runs_per_week);
  if (perWeek !== null && runs.length > perWeek) warn("preference", `選手每週最多跑 ${perWeek} 次，排了 ${runs.length} 次。`);
  // 練騎車的人：每次最多多久分跑步與騎車（各自的卡），跑步的那個只看跑步的課
  const maxMinutes = intOf(ctx.profile.pref_max_minutes);
  const rideMaxMinutes = cycling ? intOf(ctx.profile.pref_ride_max_minutes) : null;
  sessions.forEach((s, i) => {
    if (s.kind === "race") return;
    const minutes = estimates[i]!.minutes;
    const isRide = RIDE_KINDS.has(s.kind) || (s.kind === "cross" && s.sport === "ride");
    const limit = cycling ? (isRide ? rideMaxMinutes : NON_RUN_KINDS.has(s.kind) ? null : maxMinutes) : maxMinutes;
    if (limit !== null && minutes > limit + 1) {
      warn("preference", `${label(s, i)} 約 ${Math.round(minutes)} 分鐘，選手${cycling ? (isRide ? "騎車" : "跑步") : ""}每次最多 ${limit} 分鐘。`);
    }
  });
  // 多運動：每週最多練幾天（跑步、騎車與交叉訓練一起算；休息與肌力不算）
  const daysLimit = ctx.multisport ? intOf(ctx.profile.pref_days_per_week) : null;
  if (daysLimit !== null && ctx.style === "fixed") {
    const days = new Set(sessions.flatMap((s) => (s.date && !["rest", "strength"].includes(s.kind) ? [s.date] : []))).size;
    if (days > daysLimit) warn("preference", `選手每週最多練 ${daysLimit} 天，排了 ${days} 天。`);
  }
  if (ctx.style === "fixed") {
    const restDays = parseWeekdays(ctx.profile.pref_rest_days);
    sessions.forEach((s, i) => {
      const training = !NON_RUN_KINDS.has(s.kind) || (ctx.multisport && (RIDE_KINDS.has(s.kind) || s.kind === "cross"));
      if (s.date && training && restDays.includes(weekdayIndex(s.date))) warn("preference", `${label(s, i)} 排在選手的休息日。`);
    });
    const longDays = parseWeekdays(ctx.profile.pref_long_run_day);
    sessions.forEach((s, i) => {
      if (s.kind === "long" && s.date && longDays.length && !longDays.includes(weekdayIndex(s.date))) warn("preference", `${label(s, i)} 不在選手的長跑日（${ctx.profile.pref_long_run_day}）。`);
    });
    const longRideDays = cycling ? parseWeekdays(ctx.profile.pref_long_ride_day) : [];
    sessions.forEach((s, i) => {
      if (s.kind === "ride_long" && s.date && longRideDays.length && !longRideDays.includes(weekdayIndex(s.date))) {
        warn("preference", `${label(s, i)} 不在選手的長騎日（${ctx.profile.pref_long_ride_day}）。`);
      }
    });
  }

  // 10. 今天的狀況不好：今天不排強度課
  const flags = [...(ctx.recovery?.selfFlags ?? []), ...(ctx.recovery?.watchFlags ?? [])];
  sessions.forEach((s, i) => {
    if (s.date === ctx.today && isQualityKind(s.kind) && flags.length) warn("today", `今天${flags.join("、")}，今天不要排強度課（${label(s, i)}）。`);
  });

  // 11. 肌力訓練不排在強度課前一天；前一天騎很久或很硬（已經做的或排進課表的），隔天不排強度課
  for (const { s, i } of [...quality, ...rideQualityAll]) {
    if (!s.date) continue;
    const before = addDays(s.date, -1);
    if (QUALITY_KINDS.has(s.kind) && sessions.some((x) => x.kind === "strength" && x.date === before)) {
      warn("strength_timing", `${label(s, i)} 的前一天排了肌力訓練；肌力訓練放在強度課當天（課後）或輕鬆日。`);
    }
    const heavyPlanned = sessions.some((x, j) => (x.kind === "cross" || RIDE_KINDS.has(x.kind)) && x.date === before && estimates[j]!.minutes >= HEAVY_OTHER.minutes);
    const heavyDone = ctx.others.find(
      (a) => (a.date === before || a.date === s.date) && ((a.duration_min ?? 0) >= HEAVY_OTHER.minutes || (a.training_load ?? 0) >= HEAVY_OTHER.load),
    );
    if (heavyPlanned || heavyDone) {
      warn(
        "cross_fatigue",
        heavyDone
          ? `${heavyDone.date} 有 ${Math.round(heavyDone.duration_min ?? 0)} 分鐘的其他運動（負荷 ${heavyDone.training_load ?? "?"}），${label(s, i)} 建議延後或減量。`
          : `${label(s, i)} 的前一天排了很久的${RIDE_KINDS.has(s.kind) || sessions.some((x) => RIDE_KINDS.has(x.kind) && x.date === before) ? "騎車" : "交叉訓練"}，強度課建議延後或減量。`,
      );
    }
  }

  // 12. 單車與跨運動的規則（多運動，doc/coaching-method-cycling.md）
  if (ctx.multisport) checkRides(sessions, estimates, ctx, warn, { rideQualityAll, cycling });

  // 13. 傷病（規格 12.33）
  warnings.push(...injuryWarnings(sessions, ctx));

  // 沒有配速依據：配速的目標會以體感顯示
  const usesPace = sessions.some((s) => s.steps.some((st) => (isRepeat(st) ? st.steps : [st]).some((x) => x.target && "pace" in x.target)));
  if (usesPace && !ctx.values.paces) warn("no_paces", "還沒有可以推算 VDOT 的成績，配速的目標會以體感顯示；可以請選手回報比賽成績或做一次計時跑。");

  return warnings;
}

/** 單車的規則用的門檻（doc/coaching-method-cycling.md） */
const RIDE_RULES = {
  /** 長騎每次比最近 30 天最長的一趟多不超過這麼多分鐘 */
  longRideStepMin: 20,
  /** 最近 30 天沒有騎車時，一趟的上限（我們的保守做法） */
  firstRideMaxMin: 90,
  /** 體能（CTL）每週上升的上限 */
  ctlRampMax: 5,
  /** 做過的騎車算「長騎」（長跑與長騎不連兩天） */
  doneLongRideMin: 120,
  /** 賽前減量：比賽這週、比賽前一週（比賽在下週的前 3 天）的騎車時間上限（最近四週最高的一週的比例） */
  taperRaceWeek: 0.6,
  taperWeekBefore: 0.8,
  /** 恢復週：最近三週都沒有比最高的一週少 20% 以上，這週又接近最高時提醒 */
  recoveryLighter: 0.8,
  recoveryNear: 0.9,
};

/** 估算負荷用的強度係數（約略的 IF，我們的對照）：程式估的負荷 = 小時 × 係數² × 100，只拿來比較 CTL 的上升 */
function loadFactor(target: Target | undefined, kind: SessionKind, recovery: boolean): number {
  if (kind === "rest") return 0;
  if (!target) return kind === "strength" ? 0.6 : recovery ? 0.6 : RIDE_KINDS.has(kind) || kind === "cross" ? 0.65 : 0.75;
  if ("pace" in target) return { E: 0.75, M: 0.85, T: 0.95, I: 1.05, R: 1.1 }[target.pace];
  if ("hr" in target) return 0.7;
  if ("zone" in target || "power" in target) {
    const n = zoneLevel("zone" in target ? target.zone : target.power);
    return n === 3.5 ? 0.91 : ([0.55, 0.55, 0.7, 0.83, 0.95, 1.05, 1.15, 1.25][Math.round(n)] ?? 0.7);
  }
  const hi = target.rpe[1];
  return hi <= 2 ? 0.55 : hi <= 4 ? 0.7 : hi <= 6 ? 0.83 : hi <= 7 ? 0.93 : 1.05;
}

/** 一堂課約略的負荷（和 Intervals.icu 的訓練負荷同一個尺度，約略） */
export function sessionLoad(session: SessionDraft, ctx: TargetContext): number {
  const sport = sessionSport(session);
  let load = 0;
  const add = (step: Step, times: number, recovery: boolean) => {
    const f = loadFactor(step.target, session.kind, recovery);
    load += (stepEstimate(step, ctx, sport).minutes / 60) * f * f * 100 * times;
  };
  for (const step of session.steps) {
    if (isRepeat(step)) step.steps.forEach((inner, i) => add(inner, step.repeat, i > 0 && !inner.target));
    else add(step, 1, false);
  }
  return load;
}

const isRideActivity = (a: OtherActivity) => sportOfType(a.type) === "ride";

/** 單車與跨運動的規則（多運動的開關開著時） */
function checkRides(
  sessions: SessionDraft[],
  estimates: SessionEstimate[],
  ctx: CheckContext,
  warn: (rule: string, message: string) => void,
  { rideQualityAll, cycling }: { rideQualityAll: { s: SessionDraft; i: number }[]; cycling: boolean },
): void {
  const weekEnd = addDays(ctx.weekStart, 6);
  const rideOthers = ctx.others.filter(isRideActivity);
  const rides = sessions.map((s, i) => ({ s, i })).filter(({ s }) => RIDE_KINDS.has(s.kind) || (s.kind === "cross" && s.sport === "ride"));

  // 單車的強度課也要有替代
  for (const { s, i } of rideQualityAll) if (!s.fallback) warn("fallback", `${label(s, i)} 沒有寫狀況不好時的替代（fallback）。`);

  // 長跑與長騎不排在連續兩天（做過的很長的騎車也算）
  const longRuns = sessions.flatMap((s) => (s.kind === "long" && s.date ? [s.date] : []));
  const longRides = [
    ...sessions.flatMap((s, i) => (s.date && (s.kind === "ride_long" || (RIDE_KINDS.has(s.kind) && estimates[i]!.minutes >= RIDE_RULES.doneLongRideMin)) ? [s.date] : [])),
    ...rideOthers.filter((a) => a.date >= ctx.weekStart && a.date < ctx.today && (a.duration_min ?? 0) >= RIDE_RULES.doneLongRideMin).map((a) => a.date),
  ];
  for (const run of longRuns) {
    const near = longRides.find((d) => Math.abs(daysBetween(run, d)) === 1);
    if (near && (run >= ctx.today || near >= ctx.today)) warn("long_back_to_back", `長跑與長騎不要排在連續兩天：${[run, near].sort().join(" 與 ")}。`);
  }

  // 長騎的增幅：比最近 30 天最長的一趟多不超過約 20 分鐘；最近沒有騎車時先 90 分鐘以內
  const recent = rideOthers.filter((a) => a.date < ctx.today && daysBetween(a.date, ctx.today) <= 30);
  const longest = Math.max(0, ...recent.map((a) => a.duration_min ?? 0));
  for (const { s, i } of rides) {
    const minutes = estimates[i]!.minutes;
    if (longest > 0 && minutes > longest + RIDE_RULES.longRideStepMin + 0.5) {
      warn("long_ride", `${label(s, i)} 約 ${Math.round(minutes)} 分鐘，比最近 30 天最長的一趟騎車（${Math.round(longest)} 分鐘）多 ${RIDE_RULES.longRideStepMin} 分鐘以上；長騎每次多 15–20 分鐘就好。`);
    } else if (longest === 0 && minutes > RIDE_RULES.firstRideMaxMin + 0.5) {
      warn("long_ride", `最近 30 天沒有騎車的紀錄，${label(s, i)} 約 ${Math.round(minutes)} 分鐘；先從 ${RIDE_RULES.firstRideMaxMin} 分鐘以內開始，之後每次加 15–20 分鐘。`);
    }
  }

  // 停騎一週以上：先只騎耐力
  const lastRide = rideOthers.filter((a) => a.date < ctx.weekStart).map((a) => a.date).sort().pop();
  if (rideQualityAll.length && lastRide && daysBetween(lastRide, ctx.weekStart) >= 8) {
    warn("after_break", `最近停騎了 ${daysBetween(lastRide, ctx.weekStart) - 1} 天，先只排耐力騎，騎得穩定後再恢復強度課。`);
  }

  if (!cycling) return;

  // 這週的負荷：今天以前做過的加上今天起排的（跳過的不算）
  const doneLoad = [...ctx.workouts, ...ctx.others]
    .filter((w) => w.date >= ctx.weekStart && w.date < ctx.today && w.date <= weekEnd)
    .reduce((sum, w) => sum + (w.training_load ?? 0), 0);
  const plannedLoad = sessions.filter((s) => !s.date || s.date >= ctx.today).reduce((sum, s) => sum + sessionLoad(s, ctx), 0);
  const weekLoad = doneLoad + plannedLoad;

  // 體能（CTL）每週上升不超過約 5 點：一週的平均每日負荷 L，CTL 一週約上升 (L − CTL)(1 − e^(−7/42))
  const f = ctx.values.fitness;
  if (f && daysBetween(f.date, ctx.weekStart) <= 7 && plannedLoad > 0) {
    const rise = (weekLoad / 7 - f.ctl) * (1 - Math.exp(-7 / 42));
    if (rise > RIDE_RULES.ctlRampMax + 0.5) {
      warn("ctl_ramp", `這週的負荷估計約 ${Math.round(weekLoad)}，體能（CTL ${round1(f.ctl)}）約會上升 ${round1(rise)} 點，超過每週約 ${RIDE_RULES.ctlRampMax} 點的上限；減少騎車或跑步的時間。`);
    }
  }

  // 恢復週：每 3–4 週一週，量減約 30–40%
  const loadOfWeek = (start: string) =>
    [...ctx.workouts, ...ctx.others].filter((w) => w.date >= start && w.date <= addDays(start, 6)).reduce((sum, w) => sum + (w.training_load ?? 0), 0);
  const past = [1, 2, 3].map((n) => loadOfWeek(addDays(ctx.weekStart, -7 * n)));
  const peak = Math.max(...past);
  if (past.every((l) => l > 0) && Math.min(...past) > peak * RIDE_RULES.recoveryLighter && weekLoad >= peak * RIDE_RULES.recoveryNear) {
    warn("recovery_week", `已經連續三週沒有減量（最近三週的負荷 ${past.map((l) => Math.round(l)).reverse().join("、")}），這週約 ${Math.round(weekLoad)}；每 3–4 週排一週恢復週，量減約 30–40%。`);
  }

  // 單車賽事的賽前減量：7–10 天，騎車的時間減少 40–60%
  const race = ctx.races
    .filter((r) => r.sport === "ride" && r.confirmed && raceOutcome(r) === null && r.date >= ctx.weekStart && daysBetween(weekEnd, r.date) <= 3)
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (race) {
    const rideMinutesOf = (start: string) =>
      rideOthers.filter((a) => a.date >= start && a.date <= addDays(start, 6)).reduce((sum, a) => sum + (a.duration_min ?? 0), 0);
    const ridePeak = Math.max(0, ...[1, 2, 3, 4].map((n) => rideMinutesOf(addDays(ctx.weekStart, -7 * n))));
    const thisWeek =
      rideOthers.filter((a) => a.date >= ctx.weekStart && a.date < ctx.today).reduce((sum, a) => sum + (a.duration_min ?? 0), 0) +
      rides.filter(({ s }) => !s.date || s.date >= ctx.today).reduce((sum, { i }) => sum + estimates[i]!.minutes, 0);
    const raceWeek = race.date <= weekEnd;
    const limit = ridePeak * (raceWeek ? RIDE_RULES.taperRaceWeek : RIDE_RULES.taperWeekBefore);
    if (ridePeak > 0 && thisWeek > limit + 1) {
      warn("taper", `${race.date} 有單車賽事「${race.name}」，${raceWeek ? "比賽這週" : "賽前"}騎車的時間要減少（約 ${Math.round(limit)} 分鐘以下，最近四週最高 ${Math.round(ridePeak)} 分鐘），這週約 ${Math.round(thisWeek)} 分鐘；保留少量強度。`);
    }
  }
}

// ---------------------------------------------------------------------------
// 顯示
// ---------------------------------------------------------------------------

export const STYLE_LABELS: Record<PlanStyle, string> = { fixed: "固定", flexible: "彈性（這週的菜單，哪天跑都可以）" };
export const STATUS_LABELS: Record<SessionStatus, string> = { planned: "", skipped: "已跳過", fallback: "改用替代" };
/** 教練改過內容的課（edit_planned_session，規格 12.31）；照計畫的課才顯示（跳過、改用替代的照原本的狀態） */
export const EDITED_LABEL = "已調整";

/** 步驟的強度：顏色和紀錄頁的強度橫條同一套；other 是不算強度的（肌力、交叉訓練沒有目標時） */
export type StepIntensity = "low" | "moderate" | "high" | "other";

/** 直列的一步；重複組是一列標題加上內層的幾步 */
export type StepRow =
  | { type: "step"; name: string; target: string; length: string; intensity: StepIntensity }
  | { type: "repeat"; times: number; steps: { name: string; target: string; length: string; intensity: StepIntensity }[] };

const PACE_INTENSITY: Record<PaceCode, StepIntensity> = { E: "low", M: "moderate", T: "moderate", I: "high", R: "high" };
const PACE_NAMES: Record<PaceCode, string> = { E: "輕鬆", M: "M 配速", T: "T 配速", I: "I 配速", R: "R 配速" };

const STEP_ORDER: Record<StepIntensity, number> = { other: 0, low: 1, moderate: 2, high: 3 };

/** 一步的強度（低、中、高；沒有目標的非跑步課是 other） */
export const stepIntensity = (target: Target | undefined, kind: SessionKind) => intensityOf(target, kind);

function intensityOf(target: Target | undefined, kind: SessionKind): StepIntensity {
  if (!target) return NON_RUN_KINDS.has(kind) ? "other" : "low";
  if ("pace" in target) return PACE_INTENSITY[target.pace];
  if ("hr" in target) return "low";
  if ("zone" in target || "power" in target) {
    const n = zoneLevel("zone" in target ? target.zone : target.power);
    return n <= 2 ? "low" : n <= 4 ? "moderate" : "high";
  }
  return target.rpe[1] <= 4 ? "low" : target.rpe[1] <= 7 ? "moderate" : "high";
}

/** 給選手看的目標：配速不附代號（代號已經在名稱裡） */
function targetShort(target: Target | undefined, ctx: TargetContext, sport?: Sport | null, minutes?: number): string {
  if (target && "pace" in target && !(sport && sport !== "run")) {
    const range = paceRange(target.pace, ctx);
    if (range) return rangeText(range);
  }
  return targetText(target, ctx, sport, minutes);
}

const isSweetSpot = (target: Target | undefined) => !!target && (("zone" in target && target.zone === SWEET_SPOT) || ("power" in target && target.power === SWEET_SPOT));

/** recovery：重複組裡第二段以後沒有目標的，是恢復（慢跑或走） */
function stepRow(step: Step, kind: SessionKind, ctx: TargetContext, recovery = false, sport?: Sport | null) {
  const intensity = intensityOf(step.target, kind);
  const ride = RIDE_KINDS.has(kind);
  const name =
    step.note ??
    (step.target && "pace" in step.target && !ride
      ? PACE_NAMES[step.target.pace]
      : isSweetSpot(step.target)
        ? "甜蜜點"
        : step.target
          ? { low: "輕鬆", moderate: "中等強度", high: "高強度", other: "" }[intensity]
          : ride
            ? recovery
              ? "輕鬆踩"
              : "騎車"
            : NON_RUN_KINDS.has(kind)
              ? sport && sport !== "other"
                ? SPORT_LABELS[sport]
                : SESSION_KINDS[kind]
              : recovery
                ? "恢復"
                : "跑");
  return { name, target: targetShort(step.target, ctx, sport, step.duration_min), length: lengthText(step), intensity };
}

export function stepRows(session: SessionDraft, ctx: TargetContext): StepRow[] {
  const sport = targetSport(session);
  return session.steps.map((step) =>
    isRepeat(step)
      ? { type: "repeat" as const, times: step.repeat, steps: step.steps.map((s, i) => stepRow(s, session.kind, ctx, i > 0, sport)) }
      : { type: "step" as const, ...stepRow(step, session.kind, ctx, false, sport) },
  );
}

/**
 * 關鍵目標的小標籤（課表頁）：時間（有以時間寫的步驟時）、距離（跑步、有以距離寫的步驟時）、
 * 主要的目標（強度課是強度配速，其他是第一個目標）、第一個重複組的摘要（例：4 × 20 秒）。
 * brief 是小卡片用的一兩個：強度課是距離或時間加配速，長跑是距離，其他是時間。
 */
function sessionChips(session: SessionDraft, e: SessionEstimate, ctx: TargetContext): { chips: string[]; brief: string[]; target: string | null } {
  const flat = session.steps.flatMap((s) => (isRepeat(s) ? s.steps : [s]));
  if (!flat.length) return { chips: [], brief: [], target: null };
  const run = !NON_RUN_KINDS.has(session.kind);
  const time = flat.some((s) => s.distance_km === undefined) || !run ? minutesText(e.minutes) : null;
  const km = run && flat.some((s) => s.distance_km !== undefined) ? `${round1(e.km)} km` : null;
  const quality = flat.find((s) => s.target && "pace" in s.target && s.target.pace !== "E");
  // 單車的強度課：最硬的那一步
  const hardest = [...flat].filter((s) => s.target).sort((a, b) => STEP_ORDER[intensityOf(b.target, session.kind)] - STEP_ORDER[intensityOf(a.target, session.kind)])[0];
  const main = QUALITY_KINDS.has(session.kind) && quality ? quality : RIDE_QUALITY_KINDS.has(session.kind) && hardest ? hardest : flat.find((s) => s.target);
  // 交叉訓練寫了運動與單車的課：目標用那項運動的區間換算，也列出來（規格 12.24）
  const sport = targetSport(session);
  const target = (run || sport) && main ? targetShort(main.target, ctx, sport, main.duration_min) : null;
  const block = session.steps.find(isRepeat);
  const repeat = block ? `${block.repeat} × ${lengthText(block.steps[0]!)}` : null;
  const chips = [time, km, target, repeat].filter((x): x is string => !!x);
  const brief = isQualityKind(session.kind) ? [km ?? time, target] : session.kind === "long" ? [km ?? time] : [time ?? km];
  return { chips, brief: brief.filter((x): x is string => !!x), target };
}

/** 一段：強度、估計的分鐘數、在整堂課裡的位置（暖身、主課、緩和） */
export interface StructureSegment {
  intensity: StepIntensity;
  minutes: number;
  phase: "warmup" | "main" | "cooldown";
}

/**
 * 整堂課的結構（課表頁的強度條，規格 12.28）：每一步一段（重複組展開），長度是估計的時間.
 * 三步以上時第一步是暖身、最後一步是緩和；兩步時，輕鬆的那一步在前是暖身、在後是緩和
 */
export function sessionStructure(session: SessionDraft, ctx: TargetContext): StructureSegment[] {
  const sport = sessionSport(session);
  const top = session.steps;
  const level = (step: PlanStep) =>
    isRepeat(step) ? Math.max(...step.steps.map((s) => STEP_ORDER[intensityOf(s.target, session.kind)])) : STEP_ORDER[intensityOf(step.target, session.kind)];
  const phaseOf = (i: number): StructureSegment["phase"] => {
    if (top.length >= 3) return i === 0 ? "warmup" : i === top.length - 1 ? "cooldown" : "main";
    if (top.length === 2) {
      const [a, b] = [level(top[0]!), level(top[1]!)];
      if (a < b) return i === 0 ? "warmup" : "main";
      if (b < a) return i === 1 ? "cooldown" : "main";
    }
    return "main";
  };
  const out: StructureSegment[] = [];
  top.forEach((step, i) => {
    const phase = phaseOf(i);
    const add = (s: Step) => out.push({ intensity: intensityOf(s.target, session.kind), minutes: stepEstimate(s, ctx, sport).minutes, phase });
    if (isRepeat(step)) for (let n = 0; n < step.repeat; n++) step.steps.forEach(add);
    else add(step);
  });
  return out.filter((seg) => seg.minutes > 0);
}

/** 種類與課名相同（或課名已經包含種類）時只寫課名；不同時另外附種類 */
function kindHint(kind: SessionKind, title: string): string | null {
  const label = SESSION_KINDS[kind];
  const word = label.replace(/^[A-Z] /, "").replace(/訓練$/, "");
  return title === label || title.includes(word) ? null : label;
}

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
  /** 跑步的課（算跑量）；休息、肌力、交叉訓練不是 */
  isRun: boolean;
  /** 和課名不同時才有的種類，例：課名「週末慢跑」→「長跑」 */
  kindHint: string | null;
  /** 交叉訓練的運動（規格 12.24）；沒寫的是 null */
  sport: Sport | null;
  /** 選手在 App 裡回報做完的時間（肌力等沒有手錶紀錄的課）；沒有時為 null */
  doneAt: string | null;
  /** 教練改過內容的時間（課表頁顯示「已調整」）；沒改過時為 null */
  editedAt: string | null;
  rows: StepRow[];
  chips: string[];
  brief: string[];
  /** 主要的目標（例：心率 ≤151、5:05–5:11/km）；看板的摘要用 */
  target: string | null;
  /** 整堂課的結構（課表頁的強度條） */
  structure: StructureSegment[];
}

export function sessionView(
  session: SessionDraft & Partial<Pick<PlannedSession, "id" | "status" | "note" | "done_at" | "edited_at">>,
  ctx: TargetContext,
): SessionView {
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
    isRun: !NON_RUN_KINDS.has(session.kind),
    kindHint:
      session.kind === "cross" && session.sport && session.sport !== "other" && !session.title.includes(SPORT_LABELS[session.sport])
        ? `${SESSION_KINDS[session.kind]}・${SPORT_LABELS[session.sport]}`
        : kindHint(session.kind, session.title),
    sport: sessionSport(session) === "ride" ? "ride" : (session.sport ?? null),
    doneAt: session.done_at ?? null,
    editedAt: session.edited_at ?? null,
    rows: stepRows(session, ctx),
    ...sessionChips(session, e, ctx),
    structure: sessionStructure(session, ctx),
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
  sessions: (SessionDraft & Partial<Pick<PlannedSession, "id" | "status" | "note" | "edited_at">>)[],
  ctx: TargetContext,
): string {
  const views = sortSessions(sessions).map((s) => sessionView(s, ctx));
  const total = views.reduce((sum, v) => sum + v.km, 0);
  const lines = [`**${plan.weekLabel}（${plan.weekStart.slice(5)} 起）｜${STYLE_LABELS[plan.style]}｜約 ${round1(total)} km**`];
  if (plan.reason) lines.push(`原因：${plan.reason}`);
  lines.push("");
  for (const v of views) {
    const status = STATUS_LABELS[v.status] || (v.editedAt ? `${EDITED_LABEL}${v.note ? `：${v.note}` : ""}` : "");
    lines.push(`- ${v.when}｜${v.kindLabel}：${v.title}${status ? `（${status}）` : ""}`);
    if (v.steps) lines.push(`  - ${v.steps}（${v.isRun ? `約 ${v.km} km、` : ""}${v.minutes} 分鐘）`);
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
