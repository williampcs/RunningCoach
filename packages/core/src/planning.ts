/**
 * 課表的存檔、檢查與調整：教練的工具與網頁版共用（規格 12.8 的第三步 3a）.
 */
import { addDays, isoWeekLabel, weekdayIndex } from "./dates";
import type { Db } from "./db";
import {
  checkPlan,
  parseSessions,
  planMarkdown,
  QUALITY_KINDS,
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
import { analyzeRecovery } from "./recovery";
import { computeTrainingValues } from "./training-values";
import type { TrainingPlan } from "./types";

/** 訓練偏好（存在選手資料）：排課前由教練在對話中問，之後隨時可改 */
export const PREFERENCE_OPTIONS = {
  pref_goal: { health: "只想運動、養成習慣", speed: "練速度（5–10 km）", distance: "加強長距離（半馬、全馬）", race: "準備特定比賽" },
  pref_intensity: { easy: "輕鬆就好（不排強度課）", moderate: "適度（每週一堂強度課）", challenge: "想要挑戰（每週兩堂）" },
  pref_schedule: { fixed: "固定（照星期排）", flexible: "彈性（一週的菜單，哪天跑都可以）" },
} as const;

/** 沒填偏好時的預設（規格 12.8 的決定）：強度適度、節奏固定、每週次數用最近四週的平均 */
export const DEFAULT_PREFERENCES = "強度適度、節奏固定、每週次數用最近四週的平均";

/** 選手資料中訓練偏好的說明，例：「目標：練速度（5–10 km）｜強度：適度（每週一堂強度課）」 */
export function preferenceText(profile: Record<string, string>): string[] {
  const out: string[] = [];
  const pick = <K extends keyof typeof PREFERENCE_OPTIONS>(key: K, label: string) => {
    const value = profile[key];
    if (!value) return;
    const options = PREFERENCE_OPTIONS[key] as Record<string, string>;
    out.push(`${label}：${options[value] ?? value}`);
  };
  pick("pref_goal", "目標");
  pick("pref_intensity", "強度");
  if (profile.pref_runs_per_week) out.push(`每週最多 ${profile.pref_runs_per_week} 次`);
  if (profile.pref_max_minutes) out.push(`每次最多 ${profile.pref_max_minutes} 分鐘`);
  pick("pref_schedule", "節奏");
  if (profile.pref_other) out.push(`其他運動：${profile.pref_other}`);
  return out;
}

const mondayOf = (date: string) => addDays(date, -weekdayIndex(date));

async function contextFor(db: Db, today: string, weekStart: string, style: PlanStyle): Promise<CheckContext> {
  const [values, profile, workouts, races, wellness, checkins, others] = await Promise.all([
    computeTrainingValues(db, today),
    db.getProfile(),
    db.getRecentWorkouts(70),
    db.getAllRaces(),
    db.getWellness(36),
    db.getCheckins(1),
    db.getOtherActivities(14),
  ]);
  return {
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
export async function savePlanFromTool(db: Db, today: string, input: Record<string, unknown>): Promise<string> {
  const style: PlanStyle = input.style === "flexible" ? "flexible" : "fixed";
  const requested = typeof input.week_start === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.week_start) ? input.week_start : today;
  const weekStart = mondayOf(requested);
  const sessions = parseSessions(input.sessions, weekStart, style);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new Error("缺少 reason：寫明這次排或改課表的原因");

  const ctx = await contextFor(db, today, weekStart, style);
  const warnings = checkPlan(sessions, ctx);
  const notesInput = typeof input.warning_notes === "string" ? input.warning_notes.trim() : "";
  if (warnings.length && input.accept_warnings !== true) {
    return (
      `尚未儲存：檢查器發現以下問題（教練方法的規則）：\n${warningList(warnings)}\n\n` +
      "請修改後再存；如果有理由保留，再呼叫一次並設 accept_warnings=true，在 warning_notes 寫出理由，並把問題與理由告訴選手。"
    );
  }
  if (warnings.length && !notesInput) throw new Error("accept_warnings=true 時要在 warning_notes 寫出保留的理由");

  const outline = typeof input.outline === "string" && input.outline.trim() ? input.outline.trim() : null;
  const notes = warnings.length ? `${warnings.map((w) => w.message).join(" ")} 教練的理由：${notesInput}` : null;
  const meta = { weekLabel: isoWeekLabel(weekStart), weekStart, style, reason, outline, notes };
  const content = planMarkdown(meta, sessions, ctx);
  const planId = await db.saveStructuredPlan({ ...meta, content }, sessions);
  const saved = await db.getPlannedSessions(planId);
  return `課表已儲存（${meta.weekLabel}）。\n\n${sessionsText(saved, ctx)}`;
}

function sessionsText(sessions: PlannedSession[], ctx: TargetContext): string {
  return sortSessions(sessions)
    .map((s) => {
      const v = sessionView(s, ctx);
      const status = STATUS_LABELS[v.status];
      const detail = [v.purpose && `目的：${v.purpose}`, v.success && `完成的標準：${v.success}`, v.fallback && `狀況不好時：${v.fallback}`]
        .filter(Boolean)
        .join("；");
      return (
        `[session_id=${v.id}] ${v.when}｜${v.kindLabel}：${v.title}${status ? `（${status}${v.note ? `：${v.note}` : ""}）` : ""}\n` +
        (v.steps ? `  ${v.steps}（約 ${v.km} km、${v.minutes} 分鐘）\n` : "") +
        (detail ? `  ${detail}` : "")
      ).trimEnd();
    })
    .join("\n");
}

export interface ActivePlan {
  plan: TrainingPlan;
  /** 結構化的課表才有；舊的文字課表是空的 */
  sessions: SessionView[];
  styleLabel: string | null;
  totalKm: number;
}

/** 啟用中的課表，目標依現在的訓練數值換算 */
export async function activePlan(db: Db, today: string): Promise<ActivePlan | null> {
  const plan = await db.getActiveTrainingPlan();
  if (!plan) return null;
  if (!plan.week_start) return { plan, sessions: [], styleLabel: null, totalKm: 0 };
  const style = (plan.style ?? "fixed") as PlanStyle;
  const ctx = await contextFor(db, today, plan.week_start, style);
  const sessions = sortSessions(await db.getPlannedSessions(plan.id)).map((s) => sessionView(s, ctx));
  const totalKm = Math.round(sessions.filter((s) => s.status !== "skipped").reduce((sum, s) => sum + s.km, 0) * 10) / 10;
  return { plan, sessions, styleLabel: STYLE_LABELS[style], totalKm };
}

/** get_training_plan 的內容 */
export async function planTextForTool(db: Db, today: string): Promise<string> {
  const plan = await db.getActiveTrainingPlan();
  if (!plan) return "目前沒有啟用中的訓練計畫。";
  if (!plan.week_start) return `當前訓練計畫（${plan.week_label}，文字版）：\n\n${plan.content}`;
  const style = (plan.style ?? "fixed") as PlanStyle;
  const ctx = await contextFor(db, today, plan.week_start, style);
  const sessions = await db.getPlannedSessions(plan.id);
  const lines = [`當前訓練計畫（${plan.week_label}，${plan.week_start} 起，${STYLE_LABELS[style]}）`];
  if (plan.reason) lines.push(`排課的原因：${plan.reason}`);
  if (plan.notes) lines.push(`檢查器的提醒與理由：${plan.notes}`);
  lines.push("", sessionsText(sessions, ctx));
  if (plan.outline) lines.push("", "之後幾週：", plan.outline);
  lines.push("", "目標由程式依目前的訓練數值換算；單堂調整用 update_planned_session，整週重排用 save_training_plan。");
  return lines.join("\n");
}

export type SessionAction = "move" | "skip" | "fallback" | "restore";

/** 單堂課的調整（教練的工具與網頁版）；調整後重新檢查整週，有問題時附在結果後面（不擋） */
export async function changeSession(
  db: Db,
  today: string,
  id: number,
  action: SessionAction,
  options: { date?: string | null; reason?: string } = {},
): Promise<string> {
  const session = await db.getPlannedSession(id);
  if (!session) throw new Error(`找不到 session_id=${id} 的課`);
  const plan = await db.getActiveTrainingPlan();
  if (!plan || plan.id !== session.plan_id || !plan.week_start) throw new Error("這堂課不在目前啟用的課表裡");
  const style = (plan.style ?? "fixed") as PlanStyle;
  const reason = options.reason?.trim() || null;

  switch (action) {
    case "move": {
      const date = options.date ?? null;
      const weekEnd = addDays(plan.week_start, 6);
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < plan.week_start || date > weekEnd)) {
        throw new Error(`只能移到這週（${plan.week_start}～${weekEnd}）`);
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
  }

  const ctx = await contextFor(db, today, plan.week_start, style);
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
  const done = { move: "已移動", skip: "已跳過", fallback: "已改用替代的課", restore: "已恢復原本的課" }[action];
  return `${done}（session_id=${id}）。` + (warnings.length ? `\n調整後的檢查：\n${warningList(warnings)}` : "");
}
