/** 多運動的基礎與跑者的交叉訓練（規格 12.24 的第 2 階段），功能開關 multisport（12.25） */
import { describe, expect, it } from "vitest";

import { danielsPaces, featureOn, heartRateInfo, IntervalsClient, parseFeatures, type OtherActivity, type SportSettings, type TrainingValues } from "../src";
import { buildTools } from "../src/tools";
import { checkPlan, isHardOther, parseSessions, sessionView, targetText, type CheckContext, type PlannedSession, type SessionDraft } from "../src/plan";
import { matchWeek } from "../src/plan-match";
import { changeSession, planTextForTool, preferenceText, savePlanFromTool } from "../src/planning";
import { athleteSports, sportOfType, sportTargets } from "../src/sports";
import { SNAPSHOT_RUN_SETTINGS, SNAPSHOT_SPORT_SETTINGS } from "../src/training-values";
import { DEFAULT_SETTINGS, type CoachSettings } from "../src/types";
import { makeCoach, turn } from "./helpers";

const TODAY = "2026-10-10"; // 星期六；makeCoach 的今天
const WEEK = "2026-10-05";
const MULTI: Partial<CoachSettings> = { features: ["multisport"] };

const RUN: SportSettings = {
  types: ["Run", "VirtualRun"],
  lthr: 172,
  max_hr: 190,
  hr_zones: [145, 153, 161, 170, 175, 182, 190],
  ftp: null,
  indoor_ftp: null,
  power_zones: null,
  threshold_pace: 3.4,
};
const RIDE: SportSettings = {
  types: ["Ride", "VirtualRide"],
  lthr: 160,
  max_hr: 185,
  hr_zones: [135, 142, 150, 158, 163, 170, 185],
  ftp: 200,
  indoor_ftp: null,
  power_zones: [55, 75, 90, 105, 120, 150, 999],
  threshold_pace: null,
};
/** 只有心率、沒有功率計（使用者的情況） */
const RIDE_HR_ONLY: SportSettings = { ...RIDE, ftp: null, power_zones: null };

const values = { paces: danielsPaces(50), hr: heartRateInfo({}, RUN, TODAY) } as TrainingValues;
const targetCtx = (settings: SportSettings[]) => ({
  values,
  challenge: false,
  fallbackPaceSec: 360,
  sports: { ride: sportTargets(settings, "ride", TODAY), swim: sportTargets(settings, "swim", TODAY) },
});

const ride = (date: string, partial: Partial<OtherActivity> = {}): OtherActivity => ({
  intervals_id: `i-ride-${date}`,
  date,
  type: "Ride",
  duration_min: 60,
  distance_km: 30,
  avg_hr: 128,
  training_load: 38,
  raw_json: JSON.stringify({ lthr: 160, icu_hr_zones: RIDE.hr_zones, icu_hr_zone_times: [2400, 1200, 0, 0, 0, 0, 0] }),
  ...partial,
});
/** 中強度以上 20 分鐘的騎車 */
const hardRide = (date: string) =>
  ride(date, { intervals_id: `i-hard-${date}`, raw_json: JSON.stringify({ lthr: 160, icu_hr_zones: RIDE.hr_zones, icu_hr_zone_times: [1200, 1200, 600, 600, 0, 0, 0] }) });

describe("功能開關", () => {
  it("staging 全開；正式版只開列出來的，不認得的略過；沒設定時全關", () => {
    expect(parseFeatures(undefined)).toEqual([]);
    expect(parseFeatures("")).toEqual([]);
    expect(parseFeatures("multisport")).toEqual(["multisport"]);
    expect(parseFeatures(" MultiSport , nope")).toEqual(["multisport"]);
    expect(parseFeatures("all")).toEqual(["multisport"]);
    expect(parseFeatures(undefined, { staging: true })).toEqual(["multisport"]);
    expect(DEFAULT_SETTINGS.features).toEqual([]);
    expect(featureOn(DEFAULT_SETTINGS, "multisport")).toBe(false);
    expect(featureOn({ features: ["multisport"] }, "multisport")).toBe(true);
  });

  it("關著時工具和原本一樣；開著時交叉訓練有 sport、可以回報做完了", () => {
    const off = JSON.stringify(buildTools(DEFAULT_SETTINGS));
    expect(off).not.toContain("交叉訓練（kind=cross）是哪種運動");
    expect(off).not.toContain("pref_sports");
    expect(off).not.toContain('"done"');
    const on = buildTools({ ...DEFAULT_SETTINGS, features: ["multisport"] });
    const plan = on.find((t) => t.name === "save_training_plan")!;
    expect(JSON.stringify(plan)).toContain("交叉訓練（kind=cross）是哪種運動");
    expect(JSON.stringify(plan)).toContain('{\\"power\\":\\"Z2\\"}');
    expect(JSON.stringify(on.find((t) => t.name === "update_planned_session"))).toContain('"done"');
    expect(JSON.stringify(on.find((t) => t.name === "update_athlete_profile"))).toContain("pref_sports");
    // 每次建立新的，不會改到關著時的工具
    expect(JSON.stringify(buildTools(DEFAULT_SETTINGS))).toBe(off);
  });

  it("關著時系統提示和原本一樣（v3）；開著時是 v5，有練的運動與目標", async () => {
    const profile = { pref_sports: "run,ride,strength", pref_goal_ride: "週末長騎" };
    const prompt = async (settings: Partial<CoachSettings>) => {
      const { coach, provider } = await makeCoach([turn({ text: "好" })], { settings });
      for (const [k, v] of Object.entries(profile)) await coach.db.setProfileKey(k, v);
      await coach.chat("嗨");
      return provider.calls[0]!.request.system!;
    };
    const [offPrompt, onPrompt] = [await prompt({}), await prompt(MULTI)];
    expect(offPrompt).toContain("【教練方法 v3】");
    expect(offPrompt).not.toContain("練的運動");
    expect(offPrompt).not.toContain("交叉訓練的目標（v4）");
    expect(onPrompt).toContain("【教練方法 v5】");
    expect(onPrompt).toContain("練的運動：跑步、騎車、肌力訓練");
    expect(onPrompt).toContain("騎車的目標：週末長騎");
    expect(onPrompt).toContain("交叉訓練的目標（v4）");
  });
});

describe("各運動的設定", () => {
  it("Intervals.icu 的 sportSettings 只留閾值與區間，跑步的設定從同一份取", async () => {
    const requests: string[] = [];
    const client = new IntervalsClient({
      apiKey: "k",
      today: () => TODAY,
      fetch: async (url) => {
        requests.push(String(url));
        return new Response(
          JSON.stringify({
            name: "Someone",
            email: "a@b.c",
            sportSettings: [
              { ...RIDE, id: 1, gear: "secret bike", warmup_time: 600 },
              { ...RUN, id: 2 },
              { types: [], lthr: 150 },
            ],
          }),
        );
      },
    });
    const all = await client.fetchSportSettings();
    expect(all).toEqual([RIDE, RUN]);
    expect(JSON.stringify(all)).not.toContain("secret");
    expect(await client.fetchRunSettings()).toEqual({ lthr: 172, max_hr: 190, hr_zones: RUN.hr_zones, threshold_pace: 3.4 });
    expect(requests).toHaveLength(2);
  });

  it("同步時讀一次，存下各運動的設定與跑步的設定", async () => {
    const { coach, activities } = await makeCoach();
    let calls = 0;
    Object.assign(activities, {
      fetchRunSettings: async () => {
        throw new Error("有各運動的設定時不另外讀跑步的");
      },
      fetchSportSettings: async () => {
        calls += 1;
        return [RUN, RIDE];
      },
    });
    await coach.sync();
    expect(calls).toBe(1);
    expect((await coach.db.getSnapshot(SNAPSHOT_SPORT_SETTINGS))?.value).toEqual([RUN, RIDE]);
    expect((await coach.db.getSnapshot(SNAPSHOT_RUN_SETTINGS))?.value).toEqual({ lthr: 172, max_hr: 190, hr_zones: RUN.hr_zones, threshold_pace: 3.4 });
  });

  it("活動類型對應運動；選手資料沒選時當成只跑步", () => {
    expect(sportOfType("VirtualRide")).toBe("ride");
    expect(sportOfType("GravelRide")).toBe("ride");
    expect(sportOfType("OpenWaterSwim")).toBe("swim");
    expect(sportOfType("WeightTraining")).toBe("strength");
    expect(sportOfType("Elliptical")).toBe("other");
    expect(athleteSports({})).toEqual(["run"]);
    expect(athleteSports({ pref_sports: "ride, strength,bogus" })).toEqual(["ride", "strength"]);
    expect(preferenceText({ pref_sports: "ride" })).toEqual([]);
    expect(preferenceText({ pref_sports: "ride", pref_goal_ride: "長騎" }, { multisport: true })).toEqual(["練的運動：騎車（不跑步）", "騎車的目標：長騎"]);
  });
});

describe("交叉訓練的目標", () => {
  it("騎車用騎車自己的心率區間，不是跑步的", () => {
    const c = targetCtx([RUN, RIDE]);
    expect(targetText({ zone: "Z2" }, c)).toBe("心率 Z2（146–153）");
    expect(targetText({ zone: "Z2" }, c, "ride")).toBe("心率 Z2（136–142）");
    expect(targetText({ hr: "easy" }, c, "ride")).toBe("心率 ≤142");
  });

  it("有 FTP 時功率換算成瓦；沒有功率計時改看心率", () => {
    expect(targetText({ power: "Z2" }, targetCtx([RIDE]), "ride")).toBe("功率 Z2（111–150 W）");
    expect(targetText({ power: "Z7" }, targetCtx([RIDE]), "ride")).toBe("功率 Z7（≥301 W）");
    expect(targetText({ power: "Z2" }, targetCtx([RIDE_HR_ONLY]), "ride")).toBe("心率 Z2（136–142；還沒有騎車的 FTP，改看心率）");
  });

  it("騎車沒有設定時不拿跑步的區間硬套：改成體感並提示到 Intervals.icu 設定", () => {
    const c = targetCtx([RUN]);
    expect(targetText({ zone: "Z2" }, c, "ride")).toBe("體感 2–4/10（Z2；騎車的心率區間還沒在 Intervals.icu 設定）");
    expect(targetText({ zone: "Z4" }, c, "swim")).toBe("體感 6–7/10（Z4；游泳的心率區間還沒在 Intervals.icu 設定）");
    expect(targetText({ power: "Z3" }, c, "ride")).toBe("體感 5–6/10（Z3；還沒有騎車的 FTP，騎車的心率區間還沒在 Intervals.icu 設定）");
  });

  it("交叉訓練要寫運動；功率只能用在騎車；開關關著時照舊", () => {
    const raw = (session: Record<string, unknown>) => [{ date: "2026-10-06", kind: "cross", title: "騎車", purpose: "", success: "", steps: [{ duration_min: 45, target: { zone: "Z2" } }], ...session }];
    expect(() => parseSessions(raw({}), WEEK, "fixed", { multisport: true })).toThrow("要寫 sport");
    expect(parseSessions(raw({ sport: "ride" }), WEEK, "fixed", { multisport: true })[0]!.sport).toBe("ride");
    expect(() => parseSessions(raw({ sport: "swim", steps: [{ duration_min: 30, target: { power: "Z2" } }] }), WEEK, "fixed", { multisport: true })).toThrow("只能用在騎車");
    expect(parseSessions(raw({ sport: "ride" }), WEEK, "fixed")[0]!.sport).toBeUndefined();
  });

  it("課表頁：交叉訓練的步驟與小標籤用那項運動的區間", () => {
    const draft: SessionDraft = {
      date: "2026-10-06",
      kind: "cross",
      sport: "ride",
      title: "輕鬆騎",
      steps: [{ duration_min: 45, target: { zone: "Z2" } }],
      purpose: "",
      success: "",
      fallback: null,
    };
    const v = sessionView(draft, targetCtx([RUN, RIDE]));
    expect(v.sport).toBe("ride");
    expect(v.rows[0]).toMatchObject({ name: "輕鬆", target: "心率 Z2（136–142）", intensity: "low" });
    expect(v.chips).toContain("心率 Z2（136–142）");
    // 沒寫運動的舊課照原本（不列目標）
    expect(sessionView({ ...draft, sport: undefined }, targetCtx([RUN, RIDE])).chips).toEqual(["45 分鐘"]);
  });
});

describe("檢查器把交叉訓練算進去", () => {
  const easy = (date: string): SessionDraft => ({ date, kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40, target: { hr: "easy" } }], purpose: "", success: "", fallback: null });
  const tempo = (date: string): SessionDraft => ({
    date,
    kind: "threshold",
    title: "T",
    steps: [{ duration_min: 15, target: { hr: "easy" } }, { duration_min: 20, target: { pace: "T" } }],
    purpose: "",
    success: "",
    fallback: "輕鬆跑",
  });
  const ctx = (partial: Partial<CheckContext>): CheckContext => ({
    ...targetCtx([RUN, RIDE]),
    weekStart: "2026-10-12",
    style: "fixed",
    today: "2026-10-14",
    profile: { pref_intensity: "moderate" },
    workouts: [],
    races: [],
    recovery: null,
    others: [],
    ...partial,
  });
  const rules = (sessions: SessionDraft[], c: Partial<CheckContext>) => checkPlan(sessions, ctx(c)).map((w) => w.rule);

  it("這週做過的高強度騎車算一堂強度課（數量與間隔）；開關關著時不算", () => {
    const week = [easy("2026-10-14"), tempo("2026-10-16")];
    expect(isHardOther(hardRide("2026-10-13"))).toBe(true);
    expect(isHardOther(ride("2026-10-13"))).toBe(false);
    expect(rules(week, { others: [hardRide("2026-10-13")] })).toEqual([]);
    expect(rules(week, { others: [hardRide("2026-10-13")], multisport: true })).toEqual(["quality_count"]);
    // 輕鬆的騎車不算
    expect(rules(week, { others: [ride("2026-10-13")], multisport: true })).toEqual([]);
    // 想要挑戰（兩堂）：數量沒超過，但強度課接在高強度的騎車隔天
    expect(rules([easy("2026-10-15"), tempo("2026-10-14")], { others: [hardRide("2026-10-13")], multisport: true, profile: { pref_intensity: "challenge" } })).toEqual([
      "quality_spacing",
    ]);
  });

  it("排進課表的高強度交叉訓練也算", () => {
    const hardCross: SessionDraft = {
      date: "2026-10-17",
      kind: "cross",
      sport: "ride",
      title: "節奏騎",
      steps: [{ duration_min: 20, target: { zone: "Z2" } }, { duration_min: 20, target: { zone: "Z3" } }],
      purpose: "",
      success: "",
      fallback: null,
    };
    expect(rules([tempo("2026-10-16"), hardCross], { multisport: true })).toEqual(["quality_count", "quality_spacing"]);
    expect(rules([tempo("2026-10-16"), hardCross], {})).toEqual([]);
  });
});

describe("配對與回報做完了", () => {
  const session = (id: number, draft: Partial<PlannedSession> & Pick<PlannedSession, "kind">): PlannedSession => ({
    id,
    plan_id: 1,
    status: "planned",
    note: null,
    date: "2026-10-07",
    title: draft.kind,
    steps: [{ duration_min: 30 }],
    purpose: "",
    success: "",
    fallback: null,
    ...draft,
  });
  const ctx = targetCtx([RUN, RIDE]);

  it("回報做完了的肌力算達成；課表外的運動另外列出；寫了運動的交叉訓練只配那項運動", () => {
    const swim: OtherActivity = { ...ride("2026-10-08"), intervals_id: "i-swim", type: "Swim" };
    const sessions = [
      session(1, { kind: "strength", done_at: "2026-10-07T12:00:00Z" }),
      session(2, { kind: "strength", date: "2026-10-08" }),
      session(3, { kind: "cross", sport: "ride", date: "2026-10-08" }),
    ];
    const m = matchWeek(sessions, [], [swim, ride("2026-10-09")], WEEK, TODAY, ctx);
    expect(m.results.get(1)).toMatchObject({ outcome: "achieved", actual: "選手回報做完了" });
    expect(m.results.get(2)!.outcome).toBe("missed");
    expect(m.results.get(3)!.outcome).toBe("missed");
    expect(m.extraOthers.map((o) => o.intervals_id)).toEqual(["i-swim", "i-ride-2026-10-09"]);
  });

  it("肌力可以在 App 裡回報做完了，教練看得到；跑步的課不行", async () => {
    const { coach } = await makeCoach([], { settings: MULTI });
    const planId = await coach.db.saveStructuredPlan(
      { weekLabel: "W41", weekStart: WEEK, style: "fixed", reason: "r", outline: null, notes: null, content: "" },
      [
        { date: "2026-10-08", kind: "strength", title: "肌力", steps: [{ duration_min: 20 }], purpose: "", success: "", fallback: null },
        { date: "2026-10-09", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40 }], purpose: "", success: "", fallback: null },
        { date: "2026-10-12", kind: "strength", title: "下週的肌力", steps: [{ duration_min: 20 }], purpose: "", success: "", fallback: null },
      ],
    );
    const [strength, easy] = await coach.db.getPlannedSessions(planId);
    expect(await coach.changeSession(strength!.id, "done")).toContain("已記下做完了");
    await expect(coach.changeSession(easy!.id, "done")).rejects.toThrow("跑步以手錶的紀錄為準");
    const active = await coach.activePlan();
    expect(active!.sessions.find((s) => s.id === strength!.id)).toMatchObject({ doneAt: expect.any(String), result: { outcome: "achieved" } });
    expect(await planTextForTool(coach.db, TODAY, { multisport: true })).toContain("→ 達成｜實際：選手回報做完了");
    await coach.changeSession(strength!.id, "undone");
    expect((await coach.activePlan())!.sessions.find((s) => s.id === strength!.id)!.result!.outcome).toBe("missed");
  });
});

describe("課表外的運動：主動建議調整（A → A'）", () => {
  async function setup(settings: Partial<CoachSettings>, others: OtherActivity[]) {
    const { coach } = await makeCoach([], { settings });
    await coach.db.saveStructuredPlan(
      { weekLabel: "W41", weekStart: WEEK, style: "fixed", reason: "r", outline: null, notes: null, content: "" },
      [
        { date: "2026-10-09", kind: "easy", title: "輕鬆跑", steps: [{ duration_min: 40 }], purpose: "", success: "", fallback: null },
        { date: "2026-10-11", kind: "long", title: "長跑", steps: [{ duration_min: 90 }], purpose: "", success: "", fallback: null },
      ],
    );
    await coach.db.upsertOtherActivities(others);
    return coach;
  }

  it("昨天用騎車取代了課表上的跑步：教練動態問要不要調整，點了請教練重排", async () => {
    const coach = await setup(MULTI, [ride("2026-10-09")]);
    const item = (await coach.feed()).find((i) => i.kind === "cross")!;
    expect(item.title).toBe("昨天用騎車取代了「輕鬆跑」");
    expect(item.detail).toContain("取代掉的課不必補");
    const action = item.actions[0]!;
    expect(action.type === "ask" && action.message).toContain("請依這趟調整這週接下來的課");
    expect(action.type === "ask" && action.message).toContain("60 分鐘、平均心率 128、負荷 38");
  });

  it("課表外的騎車、今天還有課；很久或很硬時提醒延後強度課", async () => {
    const coach = await setup(MULTI, [ride("2026-10-10", { duration_min: 120, training_load: 90 })]);
    const item = (await coach.feed()).find((i) => i.kind === "cross")!;
    expect(item.title).toBe("今天有一趟課表外的騎車");
    expect(item.detail).toContain("強度課可能要延後或減量");
  });

  it("開關關著、太短、肌力、這週已經沒有課時不提", async () => {
    expect((await (await setup({}, [ride("2026-10-09")])).feed()).some((i) => i.kind === "cross")).toBe(false);
    const short = await setup(MULTI, [ride("2026-10-09", { duration_min: 15, training_load: 10 }), { ...ride("2026-10-10"), intervals_id: "w", type: "WeightTraining" }]);
    expect((await short.feed()).some((i) => i.kind === "cross")).toBe(false);
    const old = await setup(MULTI, [ride("2026-10-07")]);
    expect((await old.feed()).some((i) => i.kind === "cross")).toBe(false);
  });

  it("教練看得到課表外的其他運動（開著時）；重排時檢查器算進去", async () => {
    const coach = await setup(MULTI, [hardRide("2026-10-09")]);
    expect(await planTextForTool(coach.db, TODAY, { multisport: true })).toContain("課表外的其他運動");
    expect(await planTextForTool(coach.db, TODAY)).not.toContain("課表外的其他運動");
    await coach.db.setProfileKey("pref_intensity", "moderate");
    const input = {
      week_start: WEEK,
      style: "fixed",
      reason: "依騎車調整",
      sessions: [{ date: "2026-10-11", kind: "threshold", title: "T", steps: [{ duration_min: 20, target: { rpe: [6, 7] } }], purpose: "", success: "", fallback: "輕鬆跑" }],
    };
    expect(await savePlanFromTool(coach.db, TODAY, input, { multisport: true })).toContain("高強度的交叉訓練");
    expect(await savePlanFromTool(coach.db, TODAY, input)).toContain("課表已儲存");
  });

  it("單堂的調整也帶著開關", async () => {
    const coach = await setup(MULTI, []);
    const plan = await coach.db.getActiveTrainingPlan();
    const [easy] = await coach.db.getPlannedSessions(plan!.id);
    await expect(changeSession(coach.db, TODAY, easy!.id, "skip", { reason: "累" })).resolves.toContain("已跳過");
  });
});
