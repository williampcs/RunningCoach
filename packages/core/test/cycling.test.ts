/** 單車：教練方法、單車的課、檢查器、完成度、訓練數值、紀錄與賽事（規格 12.24 的第 3 階段，功能開關 multisport） */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { danielsPaces, heartRateInfo, type OtherActivity, type SportSettings, type TrainingValues } from "../src";
import {
  COACHING_METHOD,
  coachingMethod,
  CYCLING_METHOD,
  CYCLING_METHOD_VERSION,
  CYCLING_ONLY_SHARED,
  CYCLING_RULES,
  planningRules,
} from "../src/coaching-method";
import { applyEntity, snapshot } from "../src/device-sync/entities";
import { accumulateRides } from "../src/history";
import { checkPlan, parseSessions, sessionView, stepsText, type CheckContext, type PlannedSession, type SessionDraft } from "../src/plan";
import { judgeOther, matchWeek } from "../src/plan-match";
import { weekAllocation } from "../src/allocation";
import { raceActivity } from "../src/races";
import { sportTargets } from "../src/sports";
import { buildTools } from "../src/tools";
import { computeTrainingValues, estimateVdot, formatTrainingValues, SNAPSHOT_SPORT_SETTINGS } from "../src/training-values";
import { DEFAULT_SETTINGS, type CoachSettings, type Race } from "../src/types";
import { makeCoach, toolTurn, turn } from "./helpers";

const TODAY = "2026-10-10"; // 星期六；makeCoach 的今天
const WEEK = "2026-10-05";
const MULTI: Partial<CoachSettings> = { features: ["multisport"] };

const RUN: SportSettings = {
  types: ["Run"],
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
const RIDE_HR: SportSettings = { ...RIDE, ftp: null, power_zones: null };

const values = { paces: danielsPaces(50), hr: heartRateInfo({}, RUN, TODAY), fitness: null } as unknown as TrainingValues;
const targetCtx = (settings: SportSettings[]) => ({
  values,
  challenge: false,
  fallbackPaceSec: 360,
  sports: { ride: sportTargets(settings, "ride", TODAY), swim: sportTargets(settings, "swim", TODAY) },
});

const ride = (date: string, partial: Partial<OtherActivity> = {}): OtherActivity => ({
  intervals_id: `r-${date}`,
  date,
  type: "Ride",
  duration_min: 60,
  distance_km: 25,
  avg_hr: 128,
  training_load: 40,
  raw_json: JSON.stringify({ lthr: 160, icu_hr_zones: RIDE.hr_zones, icu_hr_zone_times: [2400, 1200, 0, 0, 0, 0, 0] }),
  ...partial,
});
const zoneTimes = (times: number[]) => JSON.stringify({ lthr: 160, icu_hr_zones: RIDE.hr_zones, icu_hr_zone_times: times });

const draft = (date: string | null, kind: SessionDraft["kind"], steps: SessionDraft["steps"], extra: Partial<SessionDraft> = {}): SessionDraft => ({
  date,
  kind,
  title: kind,
  steps,
  purpose: "",
  success: "",
  fallback: kind.startsWith("ride_") && !["ride_recovery", "ride_endurance", "ride_long"].includes(kind) ? "改成 60 分鐘耐力騎" : null,
  ...(kind.startsWith("ride_") ? { sport: "ride" as const } : {}),
  ...extra,
});
const endurance = (date: string | null, minutes = 60) => draft(date, "ride_endurance", [{ duration_min: minutes, target: { zone: "Z2" } }]);
const sweetspot = (date: string | null) =>
  draft(date, "ride_sweetspot", [{ duration_min: 15, target: { zone: "Z2" } }, { repeat: 2, steps: [{ duration_min: 20, target: { zone: "SS" } }, { duration_min: 5 }] }, { duration_min: 10, target: { zone: "Z1" } }]);
const vo2 = (date: string) =>
  draft(date, "ride_vo2", [{ duration_min: 15, target: { zone: "Z2" } }, { repeat: 5, steps: [{ duration_min: 4, target: { zone: "Z5" } }, { duration_min: 4 }] }, { duration_min: 10, target: { zone: "Z1" } }]);
const easyRun = (date: string): SessionDraft => draft(date, "easy", [{ duration_min: 40, target: { hr: "easy" } }]);
const longRun = (date: string): SessionDraft => draft(date, "long", [{ duration_min: 90, target: { hr: "easy" } }]);
const tempoRun = (date: string): SessionDraft => draft(date, "threshold", [{ duration_min: 15, target: { hr: "easy" } }, { duration_min: 20, target: { pace: "T" } }], { fallback: "輕鬆跑" });

describe("單車的教練方法", () => {
  it("程式與 doc/coaching-method-cycling.md 的版本一致；只在選手練騎車時帶入", () => {
    const doc = readFileSync(new URL("../../../doc/coaching-method-cycling.md", import.meta.url), "utf8");
    expect(doc).toContain(`版本 ${CYCLING_METHOD_VERSION}（`);
    expect(doc).not.toContain("草稿");
    expect(CYCLING_METHOD).toContain(`【單車的教練方法 v${CYCLING_METHOD_VERSION}】`);
    // 只跑步：不帶單車的
    expect(coachingMethod({ multisport: true, sports: ["run"] })).not.toContain(CYCLING_METHOD);
    expect(planningRules({ multisport: true, sports: ["run"] })).not.toContain(CYCLING_RULES);
    // 跑步＋騎車：兩份都有
    expect(coachingMethod({ multisport: true, sports: ["run", "ride"] })).toContain(CYCLING_METHOD);
    expect(coachingMethod({ multisport: true, sports: ["run", "ride"] })).toContain("【教練方法 v6】");
    expect(planningRules({ multisport: true, sports: ["run", "ride"] })).toContain(CYCLING_RULES);
    // 只練騎車：不帶跑步的方法
    const rideOnly = coachingMethod({ multisport: true, sports: ["ride"] });
    expect(rideOnly).toContain(CYCLING_METHOD);
    expect(rideOnly).toContain(CYCLING_ONLY_SHARED);
    expect(rideOnly).not.toContain("Daniels");
    expect(planningRules({ multisport: true, sports: ["ride"] })).not.toContain("Daniels");
    // 開關關著：和原本一樣
    expect(coachingMethod({ sports: ["ride"] })).toBe(COACHING_METHOD);
  });

  it("文件裡的課的種類、強度偏好的堂數與檢查器的門檻和程式一致", () => {
    const doc = readFileSync(new URL("../../../doc/coaching-method-cycling.md", import.meta.url), "utf8");
    for (const name of ["恢復騎", "耐力騎", "長騎", "節奏騎", "甜蜜點", "閾值騎", "最大攝氧間歇", "無氧與衝刺"]) {
      expect(doc).toContain(name);
      expect(CYCLING_METHOD).toContain(name);
    }
    for (const text of ["輕鬆就好 0", "適度 1", "想要挑戰 2", "最多 3 堂", "新手 2 堂", "六到七成", "全馬約 12 週", "88–94%", "91–96%", "15–20 分鐘", "5 點", "30–60 公克"]) {
      expect(doc).toContain(text);
      if (!["88–94%", "91–96%", "30–60 公克", "15–20 分鐘", "5 點"].includes(text)) expect(CYCLING_METHOD).toContain(text);
    }
  });
});

describe("單車的課", () => {
  const raw = (kind: string, steps: unknown[]) => [{ date: "2026-10-06", kind, title: "x", purpose: "", success: "", steps }];

  it("單車的課只在開關開著時可以排；運動自動是騎車；甜蜜點只給騎車", () => {
    expect(() => parseSessions(raw("ride_endurance", [{ duration_min: 60 }]), WEEK, "fixed")).toThrow("kind 只能是");
    const [s] = parseSessions(raw("ride_sweetspot", [{ duration_min: 20, target: { power: "SS" } }]), WEEK, "fixed", { multisport: true });
    expect(s).toMatchObject({ kind: "ride_sweetspot", sport: "ride", steps: [{ target: { power: "SS" } }] });
    expect(() => parseSessions(raw("easy", [{ duration_min: 20, target: { zone: "SS" } }]), WEEK, "fixed", { multisport: true })).toThrow("只能用在騎車");
    const tools = JSON.stringify(buildTools({ ...DEFAULT_SETTINGS, ...MULTI }));
    expect(tools).toContain("ride_sweetspot");
    expect(tools).toContain("save_activity_feedback");
    expect(JSON.stringify(buildTools(DEFAULT_SETTINGS))).not.toContain("ride_");
  });

  it("目標用騎車自己的心率區間；有 FTP 時用功率；甜蜜點換算成範圍", () => {
    const hr = targetCtx([RUN, RIDE_HR]);
    const power = targetCtx([RUN, RIDE]);
    expect(stepsText(endurance("2026-10-06"), hr)).toBe("60 分鐘 心率 Z2（136–142）");
    expect(stepsText(draft(null, "ride_sweetspot", [{ duration_min: 20, target: { zone: "SS" } }]), hr)).toBe("20 分鐘 心率 甜蜜點（146–154）");
    expect(stepsText(draft(null, "ride_sweetspot", [{ duration_min: 20, target: { power: "SS" } }]), power)).toBe("20 分鐘 功率 甜蜜點（176–188 W）");
    expect(stepsText(draft(null, "ride_threshold", [{ duration_min: 20, target: { power: "Z4" } }]), power)).toBe("20 分鐘 功率 Z4（181–210 W）");
    // 沒有功率計時功率的目標改看心率
    expect(stepsText(draft(null, "ride_threshold", [{ duration_min: 20, target: { power: "Z4" } }]), hr)).toBe(
      "20 分鐘 心率 Z4（151–158；還沒有騎車的 FTP，改看心率）",
    );
  });

  it("5 分鐘以內的高強度間歇：沒有功率時看體感；有功率時照功率", () => {
    const hrOnly = sessionView(vo2("2026-10-08"), targetCtx([RUN, RIDE_HR]));
    const repeat = hrOnly.rows[1]!;
    expect(repeat.type === "repeat" && repeat.steps[0]).toMatchObject({ target: "體感 8–9/10（短間歇，心率跟不上；後段心率到 Z5）", intensity: "high" });
    expect(repeat.type === "repeat" && repeat.steps[1]).toMatchObject({ name: "輕鬆踩" });
    const withPower = draft(null, "ride_vo2", [{ repeat: 5, steps: [{ duration_min: 4, target: { power: "Z5" } }, { duration_min: 4 }] }]);
    expect(stepsText(withPower, targetCtx([RUN, RIDE]))).toBe("5 ×（4 分鐘 功率 Z5（211–240 W） ＋ 4 分鐘）");
  });

  it("騎車的區間沒設定時不拿跑步的硬套，改成體感", () => {
    expect(stepsText(endurance("2026-10-06"), targetCtx([RUN]))).toBe("60 分鐘 體感 2–4/10（Z2；騎車的心率區間還沒在 Intervals.icu 設定）");
  });

  it("課表頁：不算跑量、時間的標籤、強度課的主要目標、種類", () => {
    const v = sessionView({ ...sweetspot("2026-10-08"), title: "甜蜜點 2 × 20 分鐘" }, targetCtx([RUN, RIDE_HR]));
    expect(v).toMatchObject({ isRun: false, km: 0, minutes: 75, sport: "ride", kindHint: null, kindLabel: "甜蜜點" });
    expect(v.chips).toEqual(["75 分鐘", "心率 甜蜜點（146–154）", "2 × 20 分鐘"]);
    expect(v.brief).toEqual(["75 分鐘", "心率 甜蜜點（146–154）"]);
    expect(sessionView({ ...endurance("2026-10-06"), title: "週末騎車" }, targetCtx([RIDE])).kindHint).toBe("耐力騎");
  });
});

describe("檢查器：單車與跨運動的規則", () => {
  const ctx = (partial: Partial<CheckContext> = {}): CheckContext => {
    const c: CheckContext = {
      ...targetCtx([RUN, RIDE_HR]),
      weekStart: "2026-10-12",
      style: "fixed",
      today: "2026-10-12",
      profile: { pref_intensity: "moderate", pref_sports: "run,ride", pref_ride_hours: "5" },
      workouts: [],
      races: [],
      recovery: null,
      // 最近五週都有騎（不是新手），最近兩週每週兩趟 90 分鐘（長騎的增幅有依據）
      others: ["2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01", "2026-10-04", "2026-10-07", "2026-10-10"].map((d) => ride(d, { duration_min: 90 })),
      multisport: true,
      ...partial,
    };
    // 額度照實際的算法（沒有另外給時）
    return { ...c, allocation: "allocation" in partial ? partial.allocation : weekAllocation(c.profile, c.races, c.weekStart, c.today, c.workouts, c.others) };
  };
  const rules = (sessions: SessionDraft[], c: Partial<CheckContext> = {}) => checkPlan(sessions, ctx(c)).map((w) => w.rule);

  it("一週跑步＋騎車：照規則排的沒有警告", () => {
    const week = [easyRun("2026-10-12"), sweetspot("2026-10-13"), endurance("2026-10-14"), tempoRun("2026-10-15"), endurance("2026-10-17", 100), longRun("2026-10-18")];
    // 長跑（週日）與長騎不連兩天：週六是耐力騎 100 分鐘（不算長騎）
    expect(rules(week)).toEqual([]);
  });

  it("強度課照額度：各項的強度偏好、主要運動、兩項合計的上限；輕鬆就好可以有一堂少量的節奏騎", () => {
    const week = [sweetspot("2026-10-13"), tempoRun("2026-10-15"), vo2("2026-10-17")];
    // 兩項都適度：各 1 堂；騎車排了 2 堂
    expect(rules(week)).toEqual(["allocation"]);
    expect(checkPlan(week, ctx()).find((w) => w.rule === "allocation")!.message).toContain("騎車（含高強度的交叉訓練）的強度課這週的額度是 1 堂，排了 2 堂");
    // 想要挑戰、主要運動是騎車：騎車 2、跑步 1（合計上限 3，先減輔助的）
    const challenge = { pref_intensity: "challenge", pref_sports: "run,ride", pref_primary_sport: "ride", pref_ride_hours: "5" };
    expect(rules(week, { profile: challenge })).toEqual([]);
    // 新手（最近 8 週有練的不到 4 週）：合計 2 堂
    expect(rules(week, { profile: challenge, others: [ride("2026-10-10")] })).toEqual(["allocation", "quality_count"]);
    const tempoRide = draft("2026-10-14", "ride_tempo", [{ duration_min: 20, target: { zone: "Z3" } }]);
    const easyRide = { pref_intensity_ride: "easy", pref_sports: "ride", pref_ride_hours: "5" };
    expect(rules([tempoRide, endurance("2026-10-16")], { profile: easyRide })).toEqual([]);
    expect(rules([tempoRide, sweetspot("2026-10-16")], { profile: easyRide })).toEqual(["allocation"]);
  });

  it("不連排兩天（跑步與騎車一起算）；強度課要有替代", () => {
    expect(rules([sweetspot("2026-10-13"), tempoRun("2026-10-14")])).toEqual(["quality_spacing"]);
    expect(rules([{ ...sweetspot("2026-10-13"), fallback: null }])).toEqual(["fallback"]);
  });

  it("硬的或很久的騎車隔天不排跑步的強度課；長跑與長騎不連兩天", () => {
    const long = draft("2026-10-14", "ride_long", [{ duration_min: 100, target: { zone: "Z2" } }]);
    expect(rules([long, tempoRun("2026-10-15")])).toEqual(["cross_fatigue"]);
    expect(rules([long, longRun("2026-10-15")])).toEqual(["long_back_to_back"]);
  });

  it("長騎的增幅：比最近 30 天最長的一趟多 20 分鐘以上；最近沒有騎車時先 90 分鐘以內", () => {
    expect(rules([endurance("2026-10-14", 110)])).toEqual([]);
    expect(rules([endurance("2026-10-14", 120)])).toEqual(["long_ride"]);
    expect(rules([endurance("2026-10-14", 100)], { others: [] })).toEqual(["long_ride"]);
    expect(rules([endurance("2026-10-14", 90)], { others: [] })).toEqual([]);
  });

  it("每週至少一天休息或恢復騎（跑步與騎車一起算）", () => {
    const days = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-17", "2026-10-18"];
    const week = days.map((d, i) => (i % 2 ? easyRun(d) : endurance(d)));
    expect(rules(week)).toContain("rest_day");
    week[6] = draft("2026-10-18", "ride_recovery", [{ duration_min: 40, target: { zone: "Z1" } }]);
    expect(rules(week)).not.toContain("rest_day");
  });

  it("體能（CTL）每週上升約 5 點以上時提醒", () => {
    const fitness = { date: "2026-10-12", ctl: 30, atl: 30, rampRate: null, source: "wellness" as const };
    const c = { values: { ...values, fitness } as TrainingValues };
    const big = ["2026-10-12", "2026-10-14", "2026-10-16", "2026-10-18"].map((d) => endurance(d, 110));
    // 約 4 × 110 分鐘 Z2：負荷約 360，每日 51，CTL 約上升 3.3
    expect(rules(big, c)).not.toContain("ctl_ramp");
    const huge = [...big, sweetspot("2026-10-13"), draft("2026-10-15", "ride_threshold", [{ duration_min: 90, target: { zone: "Z4" } }]), endurance("2026-10-17", 110)];
    expect(rules(huge, { ...c, profile: { pref_intensity: "challenge", pref_sports: "ride" } })).toContain("ctl_ramp");
    // 只跑步的人不檢查（跑步的方法沒有這條）
    expect(rules(huge.filter((s) => s.kind === "ride_endurance"), { ...c, profile: { pref_sports: "run" } })).not.toContain("ctl_ramp");
  });

  it("連續三週沒有減量：提醒排恢復週", () => {
    const weekly = (start: string, load: number) => ride(start, { intervals_id: `w-${start}`, training_load: load, duration_min: 60 });
    const others = [weekly("2026-09-21", 250), weekly("2026-09-28", 260), weekly("2026-10-05", 270)];
    const week = [endurance("2026-10-13", 60), endurance("2026-10-15", 60), endurance("2026-10-17", 60), endurance("2026-10-18", 60), sweetspot("2026-10-14")];
    expect(rules(week, { others })).toContain("recovery_week");
    expect(rules([endurance("2026-10-13", 60), endurance("2026-10-15", 60)], { others })).not.toContain("recovery_week");
  });

  it("單車賽事的賽前減量；跑步的減量不看單車的賽事", () => {
    const race: Race = { id: 1, name: "百K", date: "2026-10-18", distance_km: 100, target_time: null, confirmed: 1, result_time: null, notes: null, cancelled: 0, created_at: "", sport: "ride" };
    const week = [endurance("2026-10-13", 90), sweetspot("2026-10-15"), endurance("2026-10-16", 90)];
    expect(rules(week, { races: [race] })).toContain("taper");
    expect(rules([endurance("2026-10-14", 60), endurance("2026-10-16", 45)], { races: [race] })).not.toContain("taper");
    const runs = [1, 2, 3, 4].map((n) => ({ id: n, date: `2026-10-0${n + 4}`, distance_km: 12, duration_min: 70 }) as never);
    expect(rules([easyRun("2026-10-13"), longRun("2026-10-15")], { races: [race], workouts: runs })).not.toContain("taper");
  });

  it("只練騎車的人：沒有跑步的資料與課，也不出錯", () => {
    const c = { profile: { pref_intensity: "moderate", pref_sports: "ride", pref_ride_hours: "4" } };
    expect(rules([endurance("2026-10-13"), sweetspot("2026-10-15"), endurance("2026-10-18", 100)], c)).toEqual([]);
  });

  it("只跑步的人：開關開著也沒有單車的新規則", () => {
    const c = { profile: { pref_intensity: "moderate" }, others: [] };
    expect(rules([easyRun("2026-10-13"), tempoRun("2026-10-15"), longRun("2026-10-18")], c)).toEqual([]);
  });
});

describe("完成度：騎車的心率區間的時間＋體感", () => {
  const ctx = targetCtx([RUN, RIDE_HR]);
  const planned = (s: SessionDraft, id = 1): PlannedSession => ({ ...s, id, plan_id: 1, status: "planned", note: null });

  it("耐力騎：大部分在低強度是達成；太硬是不一樣的課；長時間的騎乘放寬心率漂移", () => {
    const s = planned(endurance("2026-10-08", 60));
    expect(judgeOther(s, ride("2026-10-08"), ctx)).toMatchObject({ outcome: "achieved", activityId: "r-2026-10-08" });
    const hard = ride("2026-10-08", { raw_json: zoneTimes([1200, 600, 1200, 600, 0, 0, 0]) });
    expect(judgeOther(s, hard, ctx)).toMatchObject({ outcome: "different" });
    expect(judgeOther(s, hard, ctx).reasons[0]).toContain("低強度只有 50%");
    // 120 分鐘、低強度 65%：一般是不一樣的課，長時間放寬到 60%
    const drift = ride("2026-10-08", { duration_min: 120, raw_json: zoneTimes([2700, 1980, 2520, 0, 0, 0, 0]) });
    expect(judgeOther(planned(endurance("2026-10-08", 120)), drift, ctx).outcome).toBe("achieved");
    expect(judgeOther(planned(endurance("2026-10-08", 120)), { ...drift, duration_min: 60 }, ctx).outcome).not.toBe("achieved");
  });

  it("強度課：中強度以上的時間比計畫少很多是不一樣的課；少一些是部分達成；太短是部分達成", () => {
    const s = planned(sweetspot("2026-10-08"));
    const done = ride("2026-10-08", { duration_min: 75, raw_json: zoneTimes([1200, 600, 1500, 1200, 0, 0, 0]) });
    expect(judgeOther(s, done, ctx).outcome).toBe("achieved");
    expect(judgeOther(s, { ...done, raw_json: zoneTimes([2400, 1800, 300, 0, 0, 0, 0]) }, ctx)).toMatchObject({ outcome: "different", reasons: ["強度比計畫低，比較像耐力騎"] });
    expect(judgeOther(s, { ...done, raw_json: zoneTimes([2400, 900, 600, 600, 0, 0, 0]) }, ctx).outcome).toBe("partial");
    expect(judgeOther(s, { ...done, duration_min: 50 }, ctx).reasons[0]).toContain("比計畫短");
  });

  it("有功率時看功率區間的時間；體感比預期累時附上", () => {
    const s = planned(sweetspot("2026-10-08"));
    const power = JSON.stringify({ icu_zone_times: [{ id: "Z1", secs: 600 }, { id: "Z2", secs: 1500 }, { id: "Z3", secs: 1200 }, { id: "Z4", secs: 1200 }, { id: "SS", secs: 2000 }], icu_average_watts: 165 });
    const r = judgeOther(s, ride("2026-10-08", { duration_min: 75, raw_json: power, perceived_effort: 9 }), ctx);
    expect(r).toMatchObject({ outcome: "achieved", difficulty: "hard" });
    expect(r.actual).toBe("75 分鐘、25 km、心率 128、負荷 40、功率 165 W、體感 9");
    expect(r.reasons).toContain("體感比預期累");
  });

  it("交叉訓練也看那項運動的心率區間（不只看時間）", () => {
    const cross = planned(draft("2026-10-08", "cross", [{ duration_min: 60, target: { zone: "Z2" } }], { sport: "ride" }));
    expect(judgeOther(cross, ride("2026-10-08", { raw_json: zoneTimes([600, 600, 1800, 600, 0, 0, 0]) }), ctx).outcome).toBe("different");
    expect(judgeOther(cross, ride("2026-10-08"), ctx).outcome).toBe("achieved");
  });

  it("配對：單車的課只配騎車；彈性的菜單依強度配", () => {
    const sessions = [planned(sweetspot(null), 1), planned(endurance(null), 2)];
    const easy = ride("2026-10-06", { intervals_id: "easy" });
    const hard = ride("2026-10-08", { intervals_id: "hard", duration_min: 75, raw_json: zoneTimes([1200, 600, 1500, 1200, 0, 0, 0]) });
    const swim = { ...ride("2026-10-07"), intervals_id: "swim", type: "Swim" };
    const m = matchWeek(sessions, [], [easy, hard, swim], WEEK, TODAY, ctx);
    expect(m.results.get(1)!.activityId).toBe("hard");
    expect(m.results.get(2)!.activityId).toBe("easy");
    expect(m.extraOthers.map((a) => a.intervals_id)).toEqual(["swim"]);
  });
});

describe("訓練數值、教練的角色與只練騎車的人", () => {
  async function setup(profile: Record<string, string>, settings: Partial<CoachSettings> = MULTI) {
    const { coach, provider } = await makeCoach([turn({ text: "好" })], { settings });
    for (const [k, v] of Object.entries(profile)) await coach.db.setProfileKey(k, v);
    await coach.db.saveSnapshot(SNAPSHOT_SPORT_SETTINGS, [RUN, RIDE_HR]);
    await coach.db.upsertOtherActivities([ride("2026-10-08", { duration_min: 95, raw_json: JSON.stringify({ icu_eftp: 212 }) }), ride("2026-10-04")]);
    return { coach, provider };
  }

  it("練騎車時列出騎車的量、最長的一趟、沒有 FTP 時用心率；單車的排課規則附在後面", async () => {
    const { coach } = await setup({ pref_sports: "run,ride" });
    const text = formatTrainingValues(await computeTrainingValues(coach.db, TODAY), { multisport: true });
    expect(text).toContain("【騎車】最近 4 週");
    expect(text).toContain("・最近 30 天最長的一趟：95 分鐘");
    expect(text).toContain("eFTP 212 W");
    expect(text).toContain(CYCLING_RULES);
    expect(text).toContain("【配速】");
    // 只跑步：沒有
    const runOnly = formatTrainingValues(await computeTrainingValues(coach.db, TODAY), { multisport: false });
    expect(runOnly).not.toContain("【騎車】");
  });

  it("只練騎車：跑步的數值省略；系統提示的角色不限跑步、不帶跑步的方法", async () => {
    const { coach, provider } = await setup({ pref_sports: "ride" });
    const text = formatTrainingValues(await computeTrainingValues(coach.db, TODAY), { multisport: true });
    expect(text).toContain("選手不跑步");
    expect(text).not.toContain("【配速】");
    expect(text).toContain("【騎車】");
    await coach.chat("嗨");
    const system = provider.calls[0]!.request.system!;
    expect(system).toContain("你是一位專業的耐力運動教練（這位選手練的運動：騎車）");
    expect(system).not.toContain("你是一位專業跑步教練");
    expect(system).toContain(CYCLING_METHOD);
    expect(system).not.toContain("Daniels");
    expect(await coach.feed()).toEqual(expect.not.arrayContaining([expect.objectContaining({ kind: "gap" })]));
  });

  it("開關關著時角色和原本一樣", async () => {
    const { coach, provider } = await setup({ pref_sports: "ride" }, {});
    await coach.chat("嗨");
    expect(provider.calls[0]!.request.system!).toContain("你是一位專業跑步教練，以下是選手資料：");
    expect(provider.calls[0]!.request.system!).not.toContain("單車的教練方法");
  });

  it("只練騎車的人：課表、教練動態、紀錄都不出錯", async () => {
    const { coach } = await setup({ pref_sports: "ride", pref_intensity: "moderate", pref_ride_hours: "5" });
    const input = {
      week_start: WEEK,
      style: "fixed",
      reason: "騎車為主",
      sessions: [
        { date: "2026-10-10", kind: "ride_endurance", title: "耐力騎", steps: [{ duration_min: 60, target: { zone: "Z2" } }], purpose: "", success: "" },
        { date: "2026-10-11", kind: "ride_long", title: "長騎", steps: [{ duration_min: 100, target: { zone: "Z2" } }], purpose: "", success: "" },
      ],
    };
    const { savePlanFromTool } = await import("../src/planning");
    expect(await savePlanFromTool(coach.db, TODAY, input, { multisport: true })).toContain("課表已儲存");
    const active = await coach.activePlan();
    expect(active!.sessions.map((s) => s.kindLabel)).toEqual(["耐力騎", "長騎"]);
    expect(active!.totalKm).toBe(0);
    expect(active!.runCount).toBe(0);
    await expect(coach.feed()).resolves.toBeInstanceOf(Array);
    expect(await coach.runCards(30)).toEqual([]);
    const rides = await coach.rideCards(30);
    expect(rides.map((c) => c.activity.intervals_id)).toEqual(["r-2026-10-08", "r-2026-10-04"]);
    expect(rides[0]!.intensity).toBeNull();
    expect(accumulateRides(await coach.db.getOtherActivities(100), TODAY)).toMatchObject({ rides: 2, minutes: 155, thisWeek: { rides: 1 } });
  });
});

describe("運動回報、賽事與多裝置同步", () => {
  it("騎完也能回報體感：回報的選項有騎車，存到那一趟；配對用得到體感", async () => {
    const { coach } = await makeCoach([], { settings: MULTI });
    await coach.db.upsertOtherActivities([ride("2026-10-10")]);
    const { candidates } = await coach.reportCandidates();
    const c = candidates.find((x) => x.sport === "ride")!;
    expect(c.target).toEqual({ kind: "other", intervalsId: "r-2026-10-10" });
    const report = await coach.reportRun(7, "腿很重", c.target);
    expect(report).toMatchObject({ status: "other", activity: { perceived_effort: 7, subjective_notes: "腿很重" } });
    expect((await coach.reportCandidates()).candidates.some((x) => x.sport === "ride")).toBe(false);
    // 同步後不會被蓋掉
    await coach.db.upsertOtherActivities([ride("2026-10-10", { training_load: 41 })]);
    expect((await coach.db.getOtherActivity("r-2026-10-10"))!.perceived_effort).toBe(7);
    // 開關關著時不列
    const off = (await makeCoach([])).coach;
    await off.db.upsertOtherActivities([ride("2026-10-10")]);
    expect((await off.reportCandidates()).candidates.some((x) => x.sport === "ride")).toBe(false);
  });

  it("教練也可以在對話中記下騎車的體感", async () => {
    const { coach, provider } = await makeCoach([toolTurn("save_activity_feedback", { perceived_effort: 5, sport: "ride" }), turn({ text: "好" })], { settings: MULTI });
    await coach.db.upsertOtherActivities([ride("2026-10-10")]);
    await coach.chat("剛騎完，體感 5");
    expect(provider.calls[1]!.toolResults![0]!.content).toContain("已記下 2026-10-10 騎車（60 分鐘）的體感 5/10");
    expect(provider.calls[0]!.request.system!).toContain("save_activity_feedback");
  });

  it("騎車的賽事：記得運動、不拿來推算跑步的配速、手錶紀錄找騎車", async () => {
    const { coach } = await makeCoach([], { settings: MULTI });
    const id = await coach.db.addRace({ name: "百K", date: "2026-10-04", distance_km: 100, sport: "ride" });
    await coach.db.upsertOtherActivities([ride("2026-10-04", { distance_km: 101, duration_min: 240, raw_json: JSON.stringify({ elapsed_time: 14700 }) })]);
    const race = (await coach.db.getRace(id))!;
    expect(race.sport).toBe("ride");
    expect(await raceActivity(coach.db, race)).toMatchObject({ time: "4:05:00", distanceKm: 101, intervalsId: "r-2026-10-04" });
    await coach.db.setRaceOutcome(id, "finished", { resultTime: "4:05:00", source: "watch" });
    expect(estimateVdot([(await coach.db.getRace(id))!], null, TODAY)).toBeNull();
    // 跑步的賽事照舊
    const runId = await coach.db.addRace({ name: "10K", date: "2026-10-04", distance_km: 10 });
    expect((await coach.db.getRace(runId))!.sport ?? null).toBeNull();
  });

  it("多裝置同步：騎車的體感與賽事的運動帶過去；之前同步過的賽事內容不變", async () => {
    const ma = await makeCoach([], { settings: MULTI });
    const mb = await makeCoach([], { settings: MULTI });
    const [a, b] = [ma.coach, mb.coach];
    const runRace = await a.db.addRace({ name: "10K", date: "2026-11-01", distance_km: 10 });
    await a.db.addRace({ name: "百K", date: "2026-11-08", distance_km: 100, sport: "ride" });
    await a.db.setActivityFeedback("r-2026-10-10", 6, "順");
    const sql = (c: typeof a) => (c === a ? ma.driver : mb.driver);
    const snap = await snapshot(sql(a));
    const races = [...snap.data].filter(([k]) => k.startsWith("r:"));
    expect(races.find(([, v]) => v.name === "10K")![1]).not.toHaveProperty("sport");
    expect(races.find(([, v]) => v.name === "百K")![1]).toMatchObject({ sport: "ride" });
    const target = await snapshot(sql(b));
    for (const [name, data] of snap.data) {
      if (name.startsWith("r:") || name.startsWith("af:")) expect(await applyEntity(sql(b), name, data, target)).toBe("applied");
    }
    expect((await b.db.getAllRaces()).find((r) => r.name === "百K")!.sport).toBe("ride");
    // 那趟還沒同步到這台也先存著，之後同步進來就看得到
    await b.db.upsertOtherActivities([ride("2026-10-10")]);
    expect((await b.db.getOtherActivity("r-2026-10-10"))!.perceived_effort).toBe(6);
    void runRace;
  });
});

describe("使用說明的多運動", () => {
  it("開關開著才有「跑步以外的運動」一段，跑後回報改叫運動回報；關著時和原本一樣", async () => {
    const { appGuide } = await import("../src/app-guide");
    expect(appGuide("web").some((s) => s.id === "multisport")).toBe(false);
    expect(appGuide("web").find((s) => s.id === "report")!.title).toBe("跑後回報");
    const on = appGuide("web", ["multisport"]);
    expect(on.find((s) => s.id === "multisport")!.body).toContain("只選騎車也可以");
    expect(on.find((s) => s.id === "report")!.title).toBe("運動回報");
    expect(on.find((s) => s.id === "sync")!.body).toContain("「運動回報」");
  });
});
