/**
 * 課表的存檔、檢查與調整：教練的工具與網頁版共用（規格 12.8 的第三步 3a）.
 */
import { addDays, isoWeekLabel, weekdayIndex, weekdayName } from "./dates";
import type { Db } from "./db";
import {
  checkPlan,
  parseSessions,
  planMarkdown,
  QUALITY_KINDS,
  RIDE_KINDS,
  SESSION_KINDS,
  sessionView,
  sortSessions,
  STATUS_LABELS,
  STYLE_LABELS,
  typicalPaceSec,
  type CheckContext,
  type PlannedSession,
  type PlanStyle,
  type PlanWarning,
  type SessionDraft,
  type SessionView,
  type TargetContext,
} from "./plan";
import { DIFFICULTY_LABELS, matchWeek, OUTCOME_LABELS, type SessionResult, type WeekMatch } from "./plan-match";
import { weekAllocation } from "./allocation";
import { analyzeRecovery } from "./recovery";
import { raceOutcome } from "./races";
import { otherActivitiesText } from "./activity-labels";
import { athleteSports, SPORT_LABELS, sportGoalKey, sportTargets } from "./sports";
import { computeTrainingValues, SNAPSHOT_SPORT_SETTINGS } from "./training-values";
import type { OtherActivity, Sport, SportSettings, TrainingPlan } from "./types";

/** 多運動的功能開關（規格 12.24）：開著時，交叉訓練要寫運動、高強度的交叉訓練算進強度課、教練看得到課表外的其他運動 */
export interface PlanOptions {
  multisport?: boolean;
}

/** 訓練偏好（存在選手資料）：排課前由教練在對話中問，之後隨時可改 */
export const PREFERENCE_OPTIONS = {
  pref_goal: { health: "只想運動、養成習慣", speed: "練速度（5–10 km）", distance: "加強長距離（半馬、全馬）", race: "準備特定比賽" },
  pref_intensity: { easy: "輕鬆就好（不排強度課）", moderate: "適度（每週一堂強度課）", challenge: "想要挑戰（每週兩堂）" },
  pref_schedule: { fixed: "固定（照星期排）", flexible: "彈性（一週的菜單，哪天跑都可以）" },
  // 多運動（規格 12.26 第 4 點）：主要運動、騎車的卡
  pref_primary_sport: { run: "跑步", ride: "騎車" },
  pref_goal_ride: { health: "保持健康、養成習慣", ftp: "提升 FTP（爬坡、速度）", distance: "長距離（百公里、長途）", race: "準備比賽" },
  pref_intensity_ride: { easy: "輕鬆就好（不排強度課）", moderate: "適度（每週一堂強度課）", challenge: "想要挑戰（每週兩堂）" },
} as const;

/** 沒填偏好時的預設（規格 12.8 的決定）：強度適度、節奏固定、每週次數用最近四週的平均 */
export const DEFAULT_PREFERENCES = "強度適度、節奏固定、每週次數用最近四週的平均";

/**
 * 選手資料中訓練偏好的說明，例：「目標：練速度（5–10 km）｜強度：適度（每週一堂強度課）」.
 * multisport：加上練哪些運動與各自的目標（規格 12.24）
 */
export function preferenceText(profile: Record<string, string>, options: PlanOptions = {}): string[] {
  const out: string[] = [];
  const text = <K extends keyof typeof PREFERENCE_OPTIONS>(key: K): string | null => {
    const value = profile[key];
    if (!value) return null;
    return (PREFERENCE_OPTIONS[key] as Record<string, string>)[value] ?? value;
  };
  const pick = <K extends keyof typeof PREFERENCE_OPTIONS>(key: K, label: string) => {
    const value = text(key);
    if (value) out.push(`${label}：${value}`);
  };
  // 多運動：共通的設定與每項運動的卡（規格 12.26 第 4 點）
  if (options.multisport && profile.pref_sports) {
    const sports = athleteSports(profile);
    out.push(`練的運動：${sports.map((s) => SPORT_LABELS[s]).join("、")}${sports.includes("run") ? "" : "（不跑步）"}`);
    pick("pref_primary_sport", "主要運動");
    pick("pref_schedule", "節奏");
    if (profile.pref_days_per_week) out.push(`每週最多練 ${profile.pref_days_per_week} 天`);
    if (profile.pref_other) out.push(`其他活動（不排課，只讓教練知道）：${profile.pref_other}`);
    if (sports.includes("run")) {
      const run = [
        text("pref_goal") && `目標 ${text("pref_goal")}`,
        text("pref_intensity") && `強度 ${text("pref_intensity")}`,
        profile.pref_runs_per_week && `每週最多 ${profile.pref_runs_per_week} 次`,
        profile.pref_max_minutes && `每次最多 ${profile.pref_max_minutes} 分鐘`,
      ].filter(Boolean);
      if (run.length) out.push(`跑步：${run.join("、")}`);
    }
    if (sports.includes("ride")) {
      const ride = [
        text("pref_goal_ride") && `目標 ${text("pref_goal_ride")}`,
        text("pref_intensity_ride") && `強度 ${text("pref_intensity_ride")}`,
        profile.pref_ride_hours && `每週約 ${profile.pref_ride_hours} 小時`,
        profile.pref_ride_max_minutes && `每次最多 ${profile.pref_ride_max_minutes} 分鐘`,
        profile.pref_long_ride_day && `長騎日 ${profile.pref_long_ride_day}`,
      ].filter(Boolean);
      if (ride.length) out.push(`騎車：${ride.join("、")}`);
    }
    for (const sport of sports.filter((s) => s !== "run" && s !== "ride")) {
      const goal = profile[sportGoalKey(sport)];
      if (goal) out.push(`${SPORT_LABELS[sport]}的目標：${goal}`);
    }
    return out;
  }
  pick("pref_goal", "目標");
  pick("pref_intensity", "強度");
  if (profile.pref_runs_per_week) out.push(`每週最多 ${profile.pref_runs_per_week} 次`);
  if (profile.pref_max_minutes) out.push(`每次最多 ${profile.pref_max_minutes} 分鐘`);
  pick("pref_schedule", "節奏");
  if (profile.pref_other) out.push(`其他運動：${profile.pref_other}`);
  return out;
}

const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

/** 交叉訓練的目標換算用的運動（跑步用訓練數值） */
const TARGET_SPORTS: Sport[] = ["ride", "swim"];

async function contextFor(db: Db, today: string, weekStart: string, style: PlanStyle, options: PlanOptions = {}): Promise<CheckContext> {
  const [values, profile, workouts, races, wellness, checkins, others, sportSettings] = await Promise.all([
    computeTrainingValues(db, today),
    db.getProfile(),
    db.getRecentWorkouts(70),
    db.getAllRaces(),
    db.getWellness(36),
    db.getCheckins(1),
    // 單車的規則看最近四週的騎車（長騎的增幅、恢復週、賽前減量）；額度看最近 8 週
    db.getOtherActivities(70),
    db.getSnapshot<SportSettings[] | null>(SNAPSHOT_SPORT_SETTINGS),
  ]);
  return {
    sports: Object.fromEntries(TARGET_SPORTS.map((sport) => [sport, sportTargets(sportSettings?.value, sport, today)])),
    multisport: options.multisport,
    // 練騎車的人：這週（排課的那週）的額度
    allocation: options.multisport ? weekAllocation(profile, races, weekStart, today, workouts, others) : null,
    rideKmh: values.ride.kmh,
    values,
    challenge: profile.pref_intensity === "challenge",
    fallbackPaceSec: typicalPaceSec(workouts),
    weekStart,
    style,
    today,
    profile,
    workouts,
    races,
    recovery: analyzeRecovery(wellness, checkins, today),
    others,
  };
}

function warningList(warnings: PlanWarning[]): string {
  return warnings.map((w, i) => `${i + 1}. ${w.message}`).join("\n");
}

/** save_training_plan：檢查後儲存；有問題且教練沒有寫理由時不存，把問題回給教練 */
export async function savePlanFromTool(db: Db, today: string, input: Record<string, unknown>, options: PlanOptions = {}): Promise<string> {
  const style: PlanStyle = input.style === "flexible" ? "flexible" : "fixed";
  const requested = typeof input.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.week_start) ? input.week_start : today;
  const weekStart = mondayOf(requested);
  const sessions = parseSessions(input.sessions, weekStart, style, options);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Error("缺少 reason：寫明這次排或改課表的原因");

  const ctx = await contextFor(db, today, weekStart, style, options);
  const warnings = checkPlan(sessions, ctx);
  const past = sessions.filter((s) => s.date && s.date < today);
  if (past.length) {
    warnings.push({
      rule: "past_date",
      message: `${past.map((s) => s.date!.slice(5)).join("、")} 的課排在今天以前；已經跑過的紀錄會自動配對，只排剩下的日子就好。`,
    });
  }
  const notesInput = typeof input.warning_notes === "string" ? input.warning_notes.trim() : "";
  if (warnings.length && input.accept_warnings !== true) {
    return (
      `尚未儲存：檢查器發現以下問題（教練方法的規則）：\n${warningList(warnings)}\n\n` +
      "請修改後再存；如果有理由保留，再呼叫一次並設 accept_warnings=true，在 warning_notes 寫出理由，並把問題與理由告訴選手。"
    );
  }
  if (warnings.length && !notesInput) throw new Error("accept_warnings=true 時要在 warning_notes 寫出保留的理由");

  const outline = typeof input.outline === "string" && input.outline.trim() ? input.outline.trim() : null;
  const notes = warnings.length ? `${warnings.map((w) => w.message).join(" ")} ${COACH_NOTE_MARK}${notesInput}` : null;
  const meta = { weekLabel: isoWeekLabel(weekStart), weekStart, style, reason, outline, notes };
  const content = planMarkdown(meta, sessions, ctx);
  const planId = await db.saveStructuredPlan({ ...meta, content }, sessions);
  const saved = await db.getPlannedSessions(planId);
  // 考慮中的比賽不要求減量，只提醒（規格 12.15）
  const maybe = ctx.races.filter((r) => !r.confirmed && raceOutcome(r) === null && r.date >= weekStart && r.date <= addDays(weekStart, 20));
  const maybeNote = maybe.length
    ? `\n\n提醒：考慮中的比賽 ${maybe.map((r) => `「${r.name}」（${r.date}）`).join("、")} 在三週內；確定報名的話要開始減量，請和選手確認。`
    : "";
  return `課表已儲存（${meta.weekLabel}）。\n\n${sessionsText(saved, ctx)}${maybeNote}`;
}

/** 結果的一行，例：「→ 部分達成：強度課的時間比計畫少｜實際：8.1 km、50 分鐘、心率 158、體感 8｜體感偏難」 */
export function resultText(r: SessionResult | undefined): string {
  if (!r || r.outcome === "pending") return "";
  const label = OUTCOME_LABELS[r.outcome];
  const parts = [`→ ${label}${r.reasons.length ? `：${r.reasons.join("、")}` : ""}`];
  if (r.actual) parts.push(`實際：${r.actual}`);
  if (r.difficulty) parts.push(DIFFICULTY_LABELS[r.difficulty]);
  return parts.join("｜");
}

function extrasText(match: WeekMatch): string[] {
  return match.extraRuns.map((w) => `${w.date.slice(5)}（${weekdayName(w.date)}）${w.distance_km ?? "?"} km、${Math.round(w.duration_min ?? 0)} 分鐘`);
}

function sessionsText(sessions: PlannedSession[], ctx: TargetContext, match?: WeekMatch): string {
  return sortSessions(sessions)
    .map((s) => {
      const v = sessionView(s, ctx);
      const result = resultText(match?.results.get(s.id));
      const status = STATUS_LABELS[v.status];
      const detail = [v.purpose && `目的：${v.purpose}`, v.success && `完成的標準：${v.success}`, v.fallback && `狀況不好時：${v.fallback}`]
        .filter(Boolean)
        .join("；");
      return (
        `[session_id=${v.id}] ${v.when}｜${v.kindLabel}：${v.title}${status ? `（${status}${v.note ? `：${v.note}` : ""}）` : ""}\n` +
        (v.steps ? `  ${v.steps}（${v.isRun ? `約 ${v.km} km、` : ""}${v.minutes} 分鐘）\n` : "") +
        (detail ? `  ${detail}\n` : "") +
        (result ? `  ${result}` : "")
      ).trimEnd();
    })
    .join("\n");
}

export interface ActivePlan {
  plan: TrainingPlan;
  /** 結構化的課表才有；舊的文字課表是空的 */
  sessions: (SessionView & { result: SessionResult | null })[];
  styleLabel: string | null;
  totalKm: number;
  /** 這週的跑步次數（不含跳過的、不是跑步的課） */
  runCount: number;
  /** 這週的單車的課（不含跳過的）：堂數與分鐘（多運動） */
  rideCount: number;
  rideMinutes: number;
  /** 教練蓋過檢查器的警告時寫的理由（給選手看）；檢查器的警告本身只給教練看 */
  coachNote: string | null;
  /** 這週沒有配到課的跑步（排課前已跑、課表外多跑的） */
  extras: string[];
  /** 這週沒有配到課的其他運動（課表外的騎車等，規格 12.24） */
  extraOthers: OtherActivity[];
}

/** 目前的課表（今天所在那週的優先），目標依現在的訓練數值換算 */
export async function activePlan(db: Db, today: string): Promise<ActivePlan | null> {
  const plan = await db.getActiveTrainingPlan();
  return plan ? planView(db, today, plan) : null;
}

/** 已經排好的下一週課表（週日先排好下週時）；和目前的是同一份時為 null */
export async function nextPlan(db: Db, today: string): Promise<ActivePlan | null> {
  const [current, next] = await Promise.all([db.getActiveTrainingPlan(), db.getNextTrainingPlan()]);
  return next && next.id !== current?.id ? planView(db, today, next) : null;
}

async function planView(db: Db, today: string, plan: TrainingPlan): Promise<ActivePlan> {
  if (!plan.week_start) return { plan, sessions: [], styleLabel: null, totalKm: 0, runCount: 0, rideCount: 0, rideMinutes: 0, coachNote: null, extras: [], extraOthers: [] };
  const style = (plan.style ?? "fixed") as PlanStyle;
  const ctx = await contextFor(db, today, plan.week_start, style);
  const planned = await db.getPlannedSessions(plan.id);
  const match = matchWeek(planned, ctx.workouts, ctx.others, plan.week_start, today, ctx);
  const sessions = sortSessions(planned).map((s) => ({ ...sessionView(s, ctx), result: match.results.get(s.id) ?? null }));
  const totalKm = Math.round(sessions.filter((s) => s.status !== "skipped").reduce((sum, s) => sum + s.km, 0) * 10) / 10;
  const runCount = sessions.filter((s) => s.isRun && s.status !== "skipped").length;
  const rides = sessions.filter((s) => RIDE_KINDS.has(s.kind) && s.status !== "skipped");
  return {
    plan,
    sessions,
    styleLabel: STYLE_LABELS[style],
    totalKm,
    runCount,
    rideCount: rides.length,
    rideMinutes: rides.reduce((sum, s) => sum + s.minutes, 0),
    coachNote: coachNoteOf(plan.notes),
    extras: extrasText(match),
    extraOthers: match.extraOthers,
  };
}

const COACH_NOTE_MARK = "教練的理由：";

/** plan.notes 是「檢查器的警告 … 教練的理由：…」：只取教練的理由給選手看（舊的課表也是這個格式） */
export function coachNoteOf(notes: string | null | undefined): string | null {
  if (!notes) return null;
  const at = notes.lastIndexOf(COACH_NOTE_MARK);
  const note = at >= 0 ? notes.slice(at + COACH_NOTE_MARK.length).trim() : "";
  return note || null;
}

/** get_training_plan 的內容 */
export async function planTextForTool(db: Db, today: string, options: PlanOptions = {}): Promise<string> {
  const [plan, next] = await Promise.all([db.getActiveTrainingPlan(), db.getNextTrainingPlan()]);
  if (!plan) return "目前沒有啟用中的訓練計畫。";
  const text = await planText(db, today, plan, "當前訓練計畫", options);
  if (!next || next.id === plan.id) return text;
  return `${text}\n\n---\n\n${await planText(db, today, next, "已經排好的下週課表", options)}`;
}

async function planText(db: Db, today: string, plan: TrainingPlan, heading: string, options: PlanOptions): Promise<string> {
  if (!plan.week_start) return `${heading}（${plan.week_label}，文字版）：\n\n${plan.content}`;
  const style = (plan.style ?? "fixed") as PlanStyle;
  const ctx = await contextFor(db, today, plan.week_start, style);
  const sessions = await db.getPlannedSessions(plan.id);
  const match = matchWeek(sessions, ctx.workouts, ctx.others, plan.week_start, today, ctx);
  const lines = [`${heading}（${plan.week_label}，${plan.week_start} 起，${STYLE_LABELS[style]}）`];
  if (plan.reason) lines.push(`排課的原因：${plan.reason}`);
  if (plan.notes) lines.push(`檢查器的提醒與理由：${plan.notes}`);
  lines.push("", sessionsText(sessions, ctx, match));
  const extras = extrasText(match);
  if (extras.length) lines.push("", `課表外的跑步（排課前已跑或額外多跑的，算進這週的跑量）：${extras.join("；")}`);
  if (options.multisport && match.extraOthers.length) {
    lines.push(
      "",
      otherActivitiesText(
        match.extraOthers,
        "課表外的其他運動（不算跑量，但會累積疲勞；調整接下來的課時要算進去，例如隔天的強度課延後或減量、用騎車取代了的課不必補）：",
      ),
    );
  }
  lines.push("（→ 後面是程式依實際紀錄的判斷；跑了不一樣的課、沒跑的課都不是失敗，沒跑的跳過即可，不要補）");
  if (plan.outline) lines.push("", "之後幾週：", plan.outline);
  lines.push("", "目標由程式依目前的訓練數值換算；單堂調整用 update_planned_session，整週重排用 save_training_plan。");
  return lines.join("\n");
}

/** done、undone：選手回報做完了（肌力等沒有手錶紀錄的課）與取消回報（規格 12.24） */
export type SessionAction = "move" | "skip" | "fallback" | "restore" | "done" | "undone";

/** 單堂課的調整（教練的工具與網頁版）；調整後重新檢查整週，有問題時附在結果後面（不擋） */
export async function changeSession(
  db: Db,
  today: string,
  id: number,
  action: SessionAction,
  options: { date?: string | null; reason?: string } & PlanOptions = {},
): Promise<string> {
  const session = await db.getPlannedSession(id);
  if (!session) throw new Error(`找不到 session_id=${id} 的課`);
  // 目前這週的，或已經排好的下週的
  const plan = await db.getTrainingPlan(session.plan_id);
  if (!plan?.is_active || !plan.week_start) throw new Error("這堂課不在目前啟用的課表裡");
  const style = (plan.style ?? "fixed") as PlanStyle;
  const reason = options.reason?.trim() || null;

  switch (action) {
    case "move": {
      const date = options.date ?? null;
      const weekEnd = addDays(plan.week_start, 6);
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < plan.week_start || date > weekEnd)) {
        throw new Error(`只能移到同一週（${plan.week_start}～${weekEnd}）`);
      }
      if (!date && style === "fixed") throw new Error("固定的課表要指定日期");
      await db.updatePlannedSession(id, { date, note: reason });
      break;
    }
    case "skip":
      await db.updatePlannedSession(id, { status: "skipped", note: reason });
      break;
    case "fallback":
      if (!session.fallback) throw new Error("這堂課沒有替代的課");
      await db.updatePlannedSession(id, { status: "fallback", note: reason });
      break;
    case "restore":
      await db.updatePlannedSession(id, { status: "planned", note: null });
      break;
    case "done":
      // 跑步的課以手錶的紀錄為準；回報只給沒有紀錄的（肌力、交叉訓練）
      if (session.kind !== "strength" && session.kind !== "cross") throw new Error("只有肌力與交叉訓練的課可以回報做完了；跑步以手錶的紀錄為準");
      if (session.date && session.date > today) throw new Error("還沒到的課不能回報做完了");
      // 不是調整：原因不寫進課的備註（課表頁會顯示成「調整的原因」）
      await db.updatePlannedSession(id, { done_at: new Date().toISOString(), status: "planned" });
      break;
    case "undone":
      await db.updatePlannedSession(id, { done_at: null });
      break;
  }

  const ctx = await contextFor(db, today, plan.week_start, style, options);
  const sessions = await db.getPlannedSessions(plan.id);
  const meta = {
    weekLabel: plan.week_label,
    weekStart: plan.week_start,
    style,
    reason: plan.reason ?? "",
    outline: plan.outline ?? null,
    notes: plan.notes ?? null,
  };
  await db.updatePlanContent(plan.id, planMarkdown(meta, sessions, ctx));
  // 跳過的不算；改用替代的當成輕鬆跑，不算強度課
  const counted: SessionDraft[] = sessions
    .filter((s) => s.status !== "skipped")
    .map((s) => (s.status === "fallback" && QUALITY_KINDS.has(s.kind) ? { ...s, kind: "easy" as const, steps: [] } : s));
  const warnings = checkPlan(counted, ctx);
  const done = {
    move: "已移動",
    skip: "已跳過",
    fallback: "已改用替代的課",
    restore: "已恢復原本的課",
    done: "已記下做完了",
    undone: "已取消做完了的回報",
  }[action];
  // 回報做完了不是調整，不附整週的檢查
  const recheck = action !== "done" && action !== "undone" && warnings.length;
  return `${done}（session_id=${id}）。` + (recheck ? `\n調整後的檢查：\n${warningList(warnings)}` : "");
}

/** 一趟跑步在課表上的位置：對應的課與程式的判斷（紀錄頁用） */
export interface RunPlanResult {
  kind: SessionView["kind"];
  kindLabel: string;
  title: string;
  result: SessionResult;
}

/**
 * since 以後每週的結構化課表與實際的對照，依跑步的 id 列出（騎車等其他運動依 intervals_id，byOther）。
 * inPlannedWeek：落在有課表的週、但沒有配到課的跑步（課表外的跑步）；othersInPlannedWeek 是其他運動的.
 */
export async function planResultsSince(
  db: Db,
  today: string,
  since: string,
): Promise<{ byWorkout: Map<number, RunPlanResult>; inPlannedWeek: Set<number>; byOther: Map<string, RunPlanResult>; othersInPlannedWeek: Set<string> }> {
  const byWorkout = new Map<number, RunPlanResult>();
  const inPlannedWeek = new Set<number>();
  const byOther = new Map<string, RunPlanResult>();
  const othersInPlannedWeek = new Set<string>();
  const plans = await db.getWeeklyPlansSince(addDays(since, -6));
  if (!plans.length) return { byWorkout, inPlannedWeek, byOther, othersInPlannedWeek };
  const ctx = await contextFor(db, today, plans[0]!.week_start!, "fixed");
  for (const plan of plans) {
    const sessions = await db.getPlannedSessions(plan.id);
    const match = matchWeek(sessions, ctx.workouts, ctx.others, plan.week_start!, today, ctx);
    for (const s of sessions) {
      const result = match.results.get(s.id);
      if (result?.activityId) byOther.set(result.activityId, { kind: s.kind, kindLabel: SESSION_KINDS[s.kind], title: s.title, result });
      if (result?.workoutId == null) continue;
      const v = sessionView(s, ctx);
      byWorkout.set(result.workoutId, { kind: s.kind, kindLabel: v.kindLabel, title: s.title, result });
    }
    for (const w of match.extraRuns) inPlannedWeek.add(w.id);
    for (const a of match.extraOthers) othersInPlannedWeek.add(a.intervals_id);
  }
  return { byWorkout, inPlannedWeek, byOther, othersInPlannedWeek };
}

/**
 * 跑後分析用：這趟對應課表上的哪一堂課，以及程式的判斷；這週沒有結構化課表時為 null。
 * 例：「這趟對應的課：T 閾值 4×1 km（…）；完成的標準：…；程式的判斷：部分達成（…）」
 */
export async function planNoteFor(db: Db, today: string, workoutId: number): Promise<string | null> {
  const plan = await db.getActiveTrainingPlan();
  const workout = await db.getWorkout(workoutId);
  if (!plan?.week_start || !workout) return null;
  if (workout.date < plan.week_start || workout.date > addDays(plan.week_start, 6)) return null;
  const style = (plan.style ?? "fixed") as PlanStyle;
  const ctx = await contextFor(db, today, plan.week_start, style);
  const sessions = await db.getPlannedSessions(plan.id);
  const match = matchWeek(sessions, ctx.workouts, ctx.others, plan.week_start, today, ctx);
  const session = sessions.find((s) => match.results.get(s.id)?.workoutId === workoutId);
  if (!session) return "這趟不在課表上（課表外的跑步），算進這週的跑量。";
  const v = sessionView(session, ctx);
  const r = match.results.get(session.id)!;
  return (
    `這趟對應的課：${v.kindLabel}「${v.title}」（${v.steps}）` +
    (v.success ? `；完成的標準：${v.success}` : "") +
    `；程式的判斷：${OUTCOME_LABELS[r.outcome]}${r.reasons.length ? `（${r.reasons.join("、")}）` : ""}` +
    (r.difficulty ? `；${DIFFICULTY_LABELS[r.difficulty]}` : "")
  );
}
