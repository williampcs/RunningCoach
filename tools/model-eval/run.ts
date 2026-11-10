/**
 * 跑一個「情境 × 模型」：記憶體裡的資料庫＋假的選手資料，用核心的教練對話一次（含工具迴圈、檢查器、安全規則），
 * 記下回覆、工具呼叫、寫進資料庫的東西、用量、金額與秒數. 只連 AI（provider），不連 Intervals.icu 或天氣.
 */
import {
  addDays,
  Coach,
  detectRedFlags,
  FakeActivitySource,
  fakeActivity,
  fakeRunSettings,
  generateActivities,
  generateWellness,
  isoWeekLabel,
  type Activity,
  type ChatSession,
  type LlmProvider,
  type NextOptions,
  type SqlDriver,
  type ToolCall,
} from "../../packages/core/src";
import { weekdayIndex } from "../../packages/core/src/dates";
import type { SessionDraft } from "../../packages/core/src/plan";
import { savePlanFromTool } from "../../packages/core/src/planning";
import { refreshTrainingSnapshots } from "../../packages/core/src/sync";
import { TOOL_FAILED_PREFIX } from "../../packages/core/src/tools";
import { openNodeSqlite } from "../../packages/sqlite-node/src";

import type { Athlete, ModelConfig, RunRecord, SavedChanges, Scenario, SessionSnapshot, ToolCallRecord } from "./types";

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * 包在 provider 外面、只記錄：每一輪的工具呼叫與送回去的工具結果（對話本身照原本的 provider 送）.
 * 工具結果在下一輪的 next({toolResults}) 才看得到，用 id 對回呼叫
 */
export class RecordingProvider implements LlmProvider {
  readonly calls: ToolCallRecord[] = [];
  private readonly pending = new Map<string, ToolCallRecord>();

  constructor(private readonly inner: LlmProvider) {}

  effortFor(model: string, effort: Parameters<LlmProvider["effortFor"]>[1]) {
    return this.inner.effortFor(model, effort);
  }

  startChat(request: Parameters<LlmProvider["startChat"]>[0]): ChatSession {
    const session = this.inner.startChat(request);
    return {
      next: async (opts: NextOptions = {}) => {
        for (const r of opts.toolResults ?? []) {
          const call = this.pending.get(r.id);
          if (!call) continue;
          call.result = r.content;
          call.failed = r.content.startsWith(TOOL_FAILED_PREFIX);
          this.pending.delete(r.id);
        }
        const turn = await session.next(opts);
        for (const c of turn.toolCalls) this.record(c);
        return turn;
      },
    };
  }

  private record(c: ToolCall): void {
    const call: ToolCallRecord = { name: c.name, input: c.input, result: "", failed: false };
    this.calls.push(call);
    this.pending.set(c.id, call);
  }
}

/** 一堂課粗估的距離：距離直接加，時間以每公里 6 分鐘換算 */
export function roughKm(steps: unknown[]): number {
  let km = 0;
  for (const raw of steps) {
    const step = raw as { repeat?: number; steps?: unknown[]; distance_km?: number; duration_min?: number };
    if (typeof step.repeat === "number" && Array.isArray(step.steps)) km += step.repeat * roughKm(step.steps);
    else km += step.distance_km ?? (step.duration_min ?? 0) / 6;
  }
  return Math.round(km * 10) / 10;
}

interface SessionRow {
  id: number;
  date: string | null;
  kind: string;
  title: string;
  steps: string;
  updated_at: string;
  edited_at: string | null;
}

async function sessionRows(driver: SqlDriver): Promise<SessionRow[]> {
  return (await driver.all("SELECT id, date, kind, title, steps, updated_at, edited_at FROM planned_sessions ORDER BY id")) as unknown as SessionRow[];
}

function snapshot(row: SessionRow): SessionSnapshot {
  let steps: unknown[] = [];
  try {
    steps = JSON.parse(row.steps) as unknown[];
  } catch {
    // 壞掉的 steps 當成沒有
  }
  return { id: Number(row.id), date: row.date, kind: row.kind, title: row.title, steps, km: roughKm(steps) };
}

/** 把情境的選手資料放進資料庫；回傳活動來源 */
export async function seedAthlete(coach: Coach, athlete: Athlete, today: string): Promise<FakeActivitySource> {
  let activities: Activity[] = [];
  let wellness: ReturnType<typeof generateWellness> = [];
  let runSettings = null;
  if (athlete.fake) {
    const spec = { ...athlete.fake, endDate: today };
    activities = generateActivities(spec);
    wellness = generateWellness(spec);
    runSettings = fakeRunSettings(spec);
    if (athlete.keepWeekdays) {
      const keep = new Set(athlete.keepWeekdays);
      activities = activities.filter((a) => keep.has(weekdayIndex(a.date)));
    }
  }
  for (const r of athlete.extraRuns ?? []) {
    activities.push(
      fakeActivity({
        date: addDays(today, -r.daysAgo),
        distanceKm: r.distanceKm,
        durationMin: r.durationMin,
        avgHr: r.avgHr,
        maxHr: r.maxHr ?? null,
        athleteMaxHr: athlete.fake?.maxHr,
      }),
    );
  }
  const source = new FakeActivitySource(activities, () => today, wellness, runSettings);
  coach.configure({ ...currentConfig(coach), activities: source });
  await coach.importHistory();
  await refreshTrainingSnapshots(coach.db, source, quiet);
  await coach.refreshWellness(0);

  for (const [key, value] of Object.entries(athlete.profile ?? {})) await coach.db.setProfileKey(key, value);
  for (const race of athlete.races ?? []) {
    await coach.db.addRace({ name: race.name, date: addDays(today, race.daysAhead), distance_km: race.distanceKm, target_time: race.targetTime, confirmed: 1 });
  }
  for (const m of athlete.memories ?? []) await coach.db.addMemory(m, "user");
  const monday = addDays(today, -weekdayIndex(today));
  for (const past of athlete.pastPlans ?? []) {
    const weekStart = addDays(monday, -7 * past.weeksAgo);
    const drafts = past.sessions.map((s) => ({ date: addDays(weekStart, s.weekday), kind: s.kind, title: s.title, steps: s.steps, purpose: "", success: "", fallback: null })) as SessionDraft[];
    await coach.db.insertPastPlan({ weekLabel: isoWeekLabel(weekStart), weekStart, reason: "（情境的過去課表）", content: "（情境的過去課表）" }, drafts);
  }
  if (athlete.plan?.length) {
    const sessions = athlete.plan.map((s) => ({ date: addDays(today, s.day), kind: s.kind, title: s.title, steps: s.steps, purpose: "情境的課", success: "完成", fallback: "" }));
    const weekStart = sessions.map((s) => s.date).sort()[0]!;
    const result = await savePlanFromTool(coach.db, today, { week_start: weekStart, style: "fixed", reason: "情境的課表", sessions, accept_warnings: true, warning_notes: "情境的課表" });
    if (!result.startsWith("課表已儲存")) throw new Error(`情境的課表存不進去：${result.slice(0, 200)}`);
  }
  // 傷病放在課表之後：課是之前排好的，之後才痛（存課表時檢查器會擋已經記下的傷）
  for (const injury of athlete.injuries ?? []) {
    const id = await coach.db.addInjury({ area: injury.area, side: injury.side ?? "none", started_on: addDays(today, -injury.startedDaysAgo), status: "active", notes: injury.notes ?? null });
    for (const s of injury.scores) await coach.db.addInjuryScore(id, { date: addDays(today, -s.daysAgo), score: s.score, when: s.when });
  }

  return source;
}

// Coach 沒有公開目前的設定；情境只換活動來源，其他沿用建立時的
const configs = new WeakMap<Coach, Parameters<Coach["configure"]>[0]>();
function currentConfig(coach: Coach): Parameters<Coach["configure"]>[0] {
  const config = configs.get(coach);
  if (!config) throw new Error("coach 不是用 createEvalCoach 建立的");
  return config;
}

export function createEvalCoach(provider: LlmProvider, model: ModelConfig, options: { now: Date; features: string[] }): { coach: Coach; driver: SqlDriver } {
  const driver = openNodeSqlite(":memory:");
  const config: Parameters<Coach["configure"]>[0] = {
    llm: { provider, models: { chat: model.model, summary: model.model, compress: model.model }, chatEffort: model.effort },
    activities: new FakeActivitySource([], () => ""),
    settings: { timeZone: "Asia/Taipei", shell: "web", features: options.features },
  };
  const coach = new Coach({ driver, ...config, now: () => options.now, logger: quiet });
  configs.set(coach, config);
  return { coach, driver };
}

async function savedChanges(coach: Coach, driver: SqlDriver, before: SessionRow[], calls: ToolCallRecord[]): Promise<SavedChanges> {
  const beforeById = new Map(before.map((r) => [Number(r.id), r]));
  const after = await sessionRows(driver);
  const newSessions = after.filter((r) => !beforeById.has(Number(r.id))).map(snapshot);
  const editedSessions = after
    .filter((r) => {
      const old = beforeById.get(Number(r.id));
      return old && (old.updated_at !== r.updated_at || old.kind !== r.kind || old.steps !== r.steps);
    })
    .map(snapshot);
  const plans = calls.filter((c) => c.name === "save_training_plan");
  return {
    newSessions,
    editedSessions,
    acceptedWarnings: plans.some((c) => c.input.accept_warnings === true && c.result.startsWith("課表已儲存")),
    checkerBlocked: [...plans, ...calls.filter((c) => c.name === "edit_planned_session")].filter((c) => c.result.startsWith("尚未")).length,
    injuries: (await coach.db.getInjuries({ includeResolved: true })).map((i) => ({ area: i.area, status: i.status, scores: i.scores.map((s) => s.score) })),
    memories: (await coach.db.getMemories()).map((m) => m.content),
    profile: await coach.db.getProfile(),
    races: (await coach.db.getAllRaces()).map((r) => `${r.name}（${r.date}，${r.distance_km} km）`),
  };
}

/** 跑一個情境；API 的錯誤記在結果裡，不丟出 */
export async function runScenario(scenario: Scenario, model: ModelConfig, makeProvider: (model: ModelConfig) => LlmProvider, options: { now: Date; features: string[] }): Promise<RunRecord> {
  const recorder = new RecordingProvider(makeProvider(model));
  const { coach, driver } = createEvalCoach(recorder, model, options);
  const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, apiCalls: 0, toolRounds: 0 };
  let costUsd: number | null = 0;
  let reply = "";
  let finish = "ok";
  let error: string | null = null;
  let seconds = 0;
  try {
    await coach.init();
    let before: SessionRow[] = [];
    let started = performance.now();
    try {
      await seedAthlete(coach, scenario.athlete, coach.today());
      before = await sessionRows(driver);
      // 秒數只算對話
      started = performance.now();
      for (const message of scenario.messages) {
        // 傳 onEvent 讓核心用串流呼叫，和網頁版一樣
        const result = await coach.chat(message, () => undefined);
        reply = result.reply;
        finish = result.stopped ? "stopped" : "ok";
        const u = result.stats.usage;
        usage.input += u.inputTokens;
        usage.cacheRead += u.cacheReadTokens;
        usage.cacheWrite += u.cacheWriteTokens;
        usage.output += u.outputTokens;
        usage.apiCalls += u.apiCalls;
        usage.toolRounds += u.toolRounds;
        costUsd = costUsd === null || u.costUsd === null ? null : costUsd + u.costUsd;
      }
      await coach.idle();
    } catch (e) {
      finish = "error";
      error = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
    }
    seconds = Math.round((performance.now() - started) / 100) / 10;
    if (/^這個問題我沒辦法回覆/.test(reply)) finish = "refused";
    else if (/^這次沒有產生回覆/.test(reply)) finish = "truncated";
    const saved = await savedChanges(coach, driver, before, recorder.calls);
    return {
      scenario: scenario.id,
      model: model.id,
      reply,
      finish,
      error,
      toolCalls: recorder.calls,
      saved,
      redFlags: detectRedFlags(scenario.messages.join("\n")),
      usage,
      costUsd,
      seconds,
    };
  } finally {
    (driver as { close?: () => void }).close?.();
  }
}
