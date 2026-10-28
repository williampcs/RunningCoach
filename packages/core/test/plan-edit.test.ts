/** 只改一堂課的內容（edit_planned_session）與存課表的工具開 strict（規格 12.31 第 1、2 點） */
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS, type ToolDef } from "../src";
import { buildTools } from "../src/tools";
import { activePlan } from "../src/planning";
import type { SessionDraft } from "../src/plan";
import { makeCoach, toolTurn, turn } from "./helpers";

// 今天是 2026-10-10（星期六）；排的是下週（10-12 起）
const easy = (date: string, km = 8): SessionDraft => ({
  date,
  kind: "easy",
  title: "輕鬆跑",
  steps: [{ distance_km: km, target: { hr: "easy" } }],
  purpose: "有氧",
  success: "心率不超過上限",
  fallback: null,
});
const tempo = (date: string): SessionDraft => ({
  date,
  kind: "threshold",
  title: "4×1 km 閾值",
  steps: [{ distance_km: 2, target: { pace: "E" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }, { duration_min: 1, target: { hr: "easy" } }] }, { distance_km: 1.5, target: { pace: "E" } }],
  purpose: "提高閾值",
  success: "每一趟都在範圍內",
  fallback: "改成 40 分鐘輕鬆跑",
});
const long = (date: string): SessionDraft => ({ ...easy(date, 14), kind: "long", title: "長跑" });
const week = { week_start: "2026-10-12", style: "fixed", reason: "照目前的跑量排", outline: "", sessions: [easy("2026-10-13"), tempo("2026-10-15"), long("2026-10-18")] };

/** 週四的閾值改成 400 m × 8（工具的輸入：完整的一堂，沒有日期） */
const intervals = {
  kind: "interval",
  title: "8×400 m",
  steps: [{ distance_km: 2, target: { pace: "E" } }, { repeat: 8, steps: [{ distance_km: 0.4, target: { pace: "I" } }, { duration_min: 1.5, note: "慢跑恢復" }] }, { distance_km: 1.5, target: { pace: "E" } }],
  purpose: "最大攝氧量",
  success: "最後一趟仍能保持配速",
  fallback: "改成 40 分鐘輕鬆跑",
};

async function coachWithPlan(script: NonNullable<Parameters<typeof makeCoach>[0]>) {
  const made = await makeCoach([toolTurn("save_training_plan", week), turn({ text: "排好了" }), ...script]);
  // 最近的 10 km 比賽 45:00，才有配速的依據
  const id = await made.coach.db.addRace({ name: "城市路跑", date: "2026-09-20", distance_km: 10, target_time: "", confirmed: 1, notes: "" });
  await made.coach.recordRaceResult(id, { outcome: "finished", time: "45:00" });
  await made.coach.chat("幫我排下週");
  const plan = (await made.coach.db.getActiveTrainingPlan())!;
  const sessions = await made.coach.db.getPlannedSessions(plan.id);
  return { ...made, plan, sessions, results: () => made.provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content) };
}

describe("只改一堂課的內容", () => {
  it("只換掉那一堂：日期不變、其他堂不動，記下原因，課表頁與教練看得到「已調整」", async () => {
    const { coach, plan, sessions, results } = await coachWithPlan([
      toolTurn("edit_planned_session", { session_id: 2, reason: "想練速度，週四改成 400 m × 8", session: intervals }),
      turn({ text: "改好了" }),
      toolTurn("get_training_plan"),
      turn({ text: "好" }),
    ]);
    expect(sessions.map((s) => s.id)).toEqual([1, 2, 3]);
    await coach.chat("週四改成 400 m × 8");
    expect(results()[1]).toMatch(/^已修改 10-15（星期四）的課「4×1 km 閾值」→「8×400 m」（session_id=2），原因：想練速度/);
    expect(results()[1]).toMatch(/8 ×（0.4 km/);

    const after = await coach.db.getPlannedSessions(plan.id);
    expect(after[1]).toMatchObject({ id: 2, date: "2026-10-15", kind: "interval", title: "8×400 m", status: "planned", note: "想練速度，週四改成 400 m × 8" });
    expect(after[1]!.edited_at).toBeTruthy();
    // 其他堂完全不變
    expect(after[0]).toEqual(sessions[0]);
    expect(after[2]).toEqual(sessions[2]);
    // 計畫的文字版（Discord 的 /plan）寫出改了哪一堂、為什麼
    expect((await coach.db.getTrainingPlan(plan.id))!.content).toContain("8×400 m（已調整：想練速度，週四改成 400 m × 8）");

    await coach.chat("課表");
    expect(results()[2]).toContain("[session_id=2] 10-15（星期四）｜I 間歇：8×400 m（已調整：想練速度，週四改成 400 m × 8）");
    expect(results()[2]).toContain("只改一堂課的內容用 edit_planned_session");
    const view = (await activePlan(coach.db, coach.today()))!;
    expect(view.sessions[1]!.editedAt).toBeTruthy();
    expect(view.sessions[0]!.editedAt).toBeNull();
  });

  it("格式不對時不改，回傳具體的錯誤；已經過去的課、不在目前課表的課不能改；reason 必填", async () => {
    const { coach, plan, sessions, results } = await coachWithPlan([
      toolTurn("edit_planned_session", { session_id: 2, reason: "改間歇", session: { ...intervals, steps: [{ distance_km: 1, target: { pace: "X" } }] } }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "改間歇", session: { ...intervals, steps: [] } }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "", session: intervals }),
      toolTurn("edit_planned_session", { session_id: 99, reason: "改", session: intervals }),
      turn({ text: "好" }),
    ]);
    await coach.chat("週四改成 400 m × 8");
    expect(results().slice(1)).toEqual([
      "執行失敗：這堂課的第 1 步 的 pace 只能是 E、M、T、I、R：X",
      "執行失敗：這堂課 沒有 steps",
      "執行失敗：缺少 reason：寫明為什麼改這堂課",
      "執行失敗：找不到 session_id=99 的課",
    ]);
    expect(await coach.db.getPlannedSessions(plan.id)).toEqual(sessions);
  });

  it("整週的檢查有問題時先退回；寫了理由才改，理由記在那堂課上給選手看", async () => {
    // 400 m × 10：I 配速的量超過週跑量的 8%
    const hard = { ...intervals, title: "10×400 m", steps: intervals.steps.map((s) => ("repeat" in s ? { ...s, repeat: 10 } : s)) };
    const { coach, plan, sessions, results } = await coachWithPlan([
      toolTurn("edit_planned_session", { session_id: 2, reason: "想多練幾趟", session: hard }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "想多練幾趟", session: hard, accept_warnings: true }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "想多練幾趟", session: hard, accept_warnings: true, warning_notes: "選手想試試看" }),
      turn({ text: "好" }),
    ]);
    await coach.chat("週四改成 400 m × 10");
    const [, first, second, third] = results();
    expect(first).toMatch(/^尚未修改：改完後整週的檢查發現以下問題/);
    expect(second).toBe("執行失敗：accept_warnings=true 時要在 warning_notes 寫出保留的理由");
    expect(first).toContain("I 配速的量");
    expect(third).toMatch(/^已修改 10-15（星期四）的課/);
    const after = await coach.db.getPlannedSessions(plan.id);
    expect(after[1]).toMatchObject({ kind: "interval", note: "想多練幾趟。選手想試試看" });
    expect([after[0], after[2]]).toEqual([sessions[0], sessions[2]]);
  });

  it("改之前就有的提醒（存課表時寫了理由保留）不擋，附在結果後面", async () => {
    const backToBack = { ...week, sessions: [easy("2026-10-13"), tempo("2026-10-14"), tempo("2026-10-15")], accept_warnings: true, warning_notes: "選手想試試看" };
    const { coach, provider } = await makeCoach([
      toolTurn("save_training_plan", backToBack),
      toolTurn("edit_planned_session", { session_id: 1, reason: "只有 30 分鐘", session: { ...easy("x", 5), date: undefined, fallback: "" } }),
      turn({ text: "好" }),
    ]);
    await coach.chat("排課表，週二只有 30 分鐘");
    const [saved, edited] = provider.calls.flatMap((c) => c.toolResults ?? []).map((r) => r.content);
    expect(saved).toMatch(/^課表已儲存/);
    expect(edited).toMatch(/^已修改 10-13（星期二）的課「輕鬆跑」（session_id=1）/);
    expect(edited).toContain("改之前就有的提醒（存課表時已保留）：\n1. ");
    expect(edited).toContain("強度課不要連排兩天");
  });

  it("跳過或改用替代的課改了內容後恢復成照計畫", async () => {
    const { coach, plan } = await coachWithPlan([
      toolTurn("update_planned_session", { session_id: 2, action: "fallback", reason: "很累" }),
      toolTurn("edit_planned_session", { session_id: 2, reason: "還是想練，改短一點", session: { ...intervals, steps: [{ distance_km: 2, target: { pace: "E" } }, { repeat: 6, steps: [{ distance_km: 0.4, target: { pace: "I" } }, { duration_min: 1.5 }] }] } }),
      turn({ text: "好" }),
    ]);
    await coach.chat("週四很累");
    expect((await coach.db.getPlannedSessions(plan.id))[1]).toMatchObject({ status: "planned", title: "8×400 m" });
  });
});

// ---------------------------------------------------------------------------
// strict 的 schema（規格 12.31 第 2 點）
// ---------------------------------------------------------------------------

/** strict 不支援的關鍵字（Anthropic 的 structured outputs 文件，2026-10-28） */
const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "maxItems", "uniqueItems", "patternProperties", "oneOf", "not", "if"];
/** 一次請求裡所有 strict 的 schema 合計的上限 */
const LIMITS = { strictTools: 20, optional: 24, unions: 16 };

/** 檢查 strict 的限制，回傳違反的地方與選填參數、聯集的數量（$ref 每用一次算一次，保守的算法） */
function strictReport(tool: ToolDef): { problems: string[]; optional: number; unions: number } {
  const defs = (tool.input_schema.$defs ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  let optional = 0;
  let unions = 0;
  const walk = (node: unknown, path: string, depth: number): void => {
    if (depth > 20) return void problems.push(`${path}：遞迴`);
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (typeof n.$ref === "string") {
      const name = n.$ref.replace(/^#\/\$defs\//, "");
      if (!(name in defs)) problems.push(`${path}：找不到 ${n.$ref}`);
      return walk(defs[name], `${path}→${name}`, depth + 1);
    }
    for (const key of UNSUPPORTED) if (key in n) problems.push(`${path}：不支援 ${key}`);
    if (typeof n.minItems === "number" && n.minItems > 1) problems.push(`${path}：minItems 只能是 0 或 1`);
    if (Array.isArray(n.type)) unions++;
    if (Array.isArray(n.anyOf)) {
      unions++;
      (n.anyOf as unknown[]).forEach((x, i) => walk(x, `${path}|${i}`, depth + 1));
    }
    if (n.type === "object") {
      if (n.additionalProperties !== false) problems.push(`${path}：物件要 additionalProperties: false`);
      const props = (n.properties ?? {}) as Record<string, unknown>;
      const required = (n.required ?? []) as string[];
      for (const r of required) if (!(r in props)) problems.push(`${path}：required 的 ${r} 不在 properties`);
      optional += Object.keys(props).filter((k) => !required.includes(k)).length;
      for (const [k, v] of Object.entries(props)) walk(v, `${path}.${k}`, depth + 1);
    }
    if (n.type === "array") walk(n.items, `${path}[]`, depth + 1);
  };
  walk(tool.input_schema, tool.name, 0);
  return { problems, optional, unions };
}

const variants = {
  一般: buildTools(DEFAULT_SETTINGS, { weather: true }),
  多運動: buildTools({ ...DEFAULT_SETTINGS, features: ["multisport"] }, { weather: true }),
};

const validator = (tool: ToolDef) => new Ajv2020({ strict: true, allErrors: true }).compile(tool.input_schema);

describe("strict 的工具", () => {
  for (const [label, tools] of Object.entries(variants)) {
    it(`${label}：存課表與改一堂是 strict；schema 符合 strict 的限制，一次請求的總數在上限內`, () => {
      const strict = tools.filter((t) => t.strict);
      expect(strict.map((t) => t.name).sort()).toEqual(["edit_planned_session", "save_training_plan"]);
      const reports = strict.map(strictReport);
      expect(reports.flatMap((r) => r.problems)).toEqual([]);
      expect(strict.length).toBeLessThanOrEqual(LIMITS.strictTools);
      expect(reports.reduce((sum, r) => sum + r.optional, 0)).toBeLessThanOrEqual(LIMITS.optional);
      expect(reports.reduce((sum, r) => sum + r.unions, 0)).toBeLessThanOrEqual(LIMITS.unions);
      // 每個工具都是正確的 JSON Schema（2020-12），也都寫了 additionalProperties: false
      for (const tool of tools) {
        expect(() => validator(tool)).not.toThrow();
        expect(tool.input_schema.additionalProperties).toBe(false);
      }
    });
  }

  it("教練實際會送的輸入通過 schema；多的欄位、不認得的代號不通過", () => {
    const save = validator(variants.一般.find((t) => t.name === "save_training_plan")!);
    const edit = validator(variants.一般.find((t) => t.name === "edit_planned_session")!);
    const sessions = [easy("2026-10-13"), tempo("2026-10-15"), { ...long("2026-10-18"), steps: [{ duration_min: 90, target: { rpe: [3, 4] } }, { distance_km: 2, target: { zone: "Z2" }, note: "最後 2 km" }] }];
    // 沒有替代時不寫 fallback（null 不是字串）
    const input = { ...week, sessions: sessions.map(({ fallback, ...s }) => (fallback ? { ...s, fallback } : s)), accept_warnings: true, warning_notes: "理由" };
    expect(save(input), JSON.stringify(save.errors)).toBe(true);
    expect(edit({ session_id: 2, reason: "改間歇", session: intervals })).toBe(true);
    expect(edit({ session_id: 2, reason: "改間歇", session: { ...intervals, fallback: "" } })).toBe(true);

    expect(save({ ...input, extra: 1 })).toBe(false);
    expect(save({ ...input, sessions: [{ ...input.sessions[0], steps: [{ distance_km: 1, target: { pace: "X" } }] }] })).toBe(false);
    expect(save({ ...input, sessions: [{ ...input.sessions[0], steps: [{ distance_km: 1, pace: "E" }] }] })).toBe(false);
    expect(edit({ session_id: 2, reason: "改", session: { ...intervals, date: "2026-10-15" } })).toBe(false);
    const { fallback: _, ...noFallback } = intervals;
    expect(edit({ session_id: 2, reason: "改", session: noFallback })).toBe(false);
  });

  it("多運動：單車的課、功率與甜蜜點的目標通過 schema", () => {
    const save = validator(variants.多運動.find((t) => t.name === "save_training_plan")!);
    const ride = { date: "2026-10-14", kind: "ride_sweetspot", title: "甜蜜點", steps: [{ duration_min: 15, target: { power: "SS" } }, { duration_min: 20, target: { zone: "SS" } }], purpose: "FTP", success: "穩定" };
    const cross = { date: "2026-10-16", kind: "cross", sport: "swim", title: "游泳", steps: [{ duration_min: 30 }], purpose: "恢復", success: "輕鬆" };
    expect(save({ ...week, sessions: [ride, cross] }), JSON.stringify(save.errors)).toBe(true);
    // 開關關著時沒有單車的課與功率
    const off = validator(variants.一般.find((t) => t.name === "save_training_plan")!);
    expect(off({ ...week, sessions: [ride] })).toBe(false);
  });
});
