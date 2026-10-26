/** 多運動的每週額度（規格 12.26 第 4 點） */
import { describe, expect, it } from "vitest";

import { allocationLine, allocationText, weekAllocation } from "../src/allocation";
import type { Race } from "../src/types";

const WEEK = "2026-10-12"; // 星期一
const TODAY = "2026-10-12";
// 最近 8 週每週都有跑與騎（不是新手）：每週三次 50 分鐘的跑步、一趟 120 分鐘的騎車
const weeks = Array.from({ length: 8 }, (_, i) => new Date(Date.parse(WEEK) - (i + 1) * 7 * 86_400_000).toISOString().slice(0, 10));
const runs = weeks.flatMap((w) => [0, 2, 4].map((d) => ({ date: new Date(Date.parse(w) + d * 86_400_000).toISOString().slice(0, 10), duration_min: 50 })));
const rides = weeks.map((w) => ({ date: new Date(Date.parse(w) + 5 * 86_400_000).toISOString().slice(0, 10), type: "Ride", duration_min: 120 }));
const race = (partial: Partial<Race>): Race =>
  ({ id: 1, name: "半馬", date: "2026-11-15", distance_km: 21.1, target_time: null, confirmed: 1, result_time: null, notes: null, cancelled: 0, created_at: "", ...partial }) as Race;

const alloc = (profile: Record<string, string>, races: Race[] = [], data = { runs, rides }) =>
  weekAllocation({ pref_sports: "run,ride", ...profile }, races, WEEK, TODAY, data.runs, data.rides);
const of = (a: ReturnType<typeof alloc>, sport: "run" | "ride") => a!.sports.find((s) => s.sport === sport)!;

describe("每週的額度", () => {
  it("只跑步的人沒有額度（照跑步原本的規則）；只練騎車只有騎車", () => {
    expect(weekAllocation({}, [], WEEK, TODAY, runs, rides)).toBeNull();
    expect(weekAllocation({ pref_sports: "run" }, [], WEEK, TODAY, runs, rides)).toBeNull();
    const rideOnly = weekAllocation({ pref_sports: "ride", pref_ride_hours: "4", pref_intensity_ride: "challenge" }, [], WEEK, TODAY, [], rides);
    expect(rideOnly!.sports).toEqual([{ sport: "ride", count: null, minutes: 240, quality: 2, wanted: { quality: 2, minutes: 240 } }]);
  });

  it("不選主要運動：依各項的設定（每週的量、強度）；舊資料的欄位就是跑步的卡", () => {
    const a = alloc({ pref_runs_per_week: "4", pref_intensity: "moderate", pref_ride_hours: "3", pref_intensity_ride: "challenge" });
    expect(of(a, "run")).toMatchObject({ count: 4, minutes: 200, quality: 1 });
    expect(of(a, "ride")).toMatchObject({ minutes: 180, quality: 2 });
    expect(a!.primary).toBeNull();
    expect(a!.reasons[0]).toBe("沒有選主要運動，依各項的設定");
    expect(allocationLine(a!)).toBe("跑步 4 次（約 3 小時 20 分）、強度課 1；騎車 3 小時、強度課 2");
    // 騎車沒有自己的強度時沿用跑步的
    expect(of(alloc({ pref_intensity: "challenge" }), "ride").wanted.quality).toBe(2);
  });

  it("主要運動：約六到七成的時間、至少一半的強度課", () => {
    const a = alloc({ pref_primary_sport: "run", pref_runs_per_week: "3", pref_intensity: "moderate", pref_ride_hours: "4", pref_intensity_ride: "challenge" });
    // 跑步 150 分鐘、騎車想要 240 → 減到約 81（跑步佔 65%）；騎車的強度課不比跑步多
    expect(of(a, "ride")).toMatchObject({ minutes: 81, quality: 1 });
    expect(of(a, "run")).toMatchObject({ minutes: 150, quality: 1 });
    expect(a!.reasons[0]).toBe("主要運動是跑步");
  });

  it("兩項合計的上限：3 堂（先減輔助的），新手 2 堂", () => {
    const both = { pref_intensity: "challenge", pref_intensity_ride: "challenge" };
    expect(alloc({ ...both, pref_primary_sport: "ride" })!.sports.map((s) => s.quality)).toEqual([1, 2]);
    expect(alloc(both)!.sports.map((s) => s.quality)).toEqual([2, 1]);
    const beginner = alloc(both, [], { runs: runs.slice(0, 3), rides: [] });
    expect(beginner!.qualityCap).toBe(2);
    expect(beginner!.sports.reduce((n, s) => n + s.quality, 0)).toBe(2);
    expect(beginner!.reasons.at(-1)).toContain("最近 8 週有練的只有");
  });

  it("賽事的專項準備期：那項暫時變主要並說明；期間外照原本的", () => {
    const profile = { pref_primary_sport: "ride", pref_intensity: "moderate", pref_ride_hours: "4" };
    const half = race({ date: "2026-11-15" }); // 約 5 週後，半馬的準備期是 8 週
    const a = alloc(profile, [half]);
    expect(a!.primary).toBe("run");
    expect(a!.chosenPrimary).toBe("ride");
    expect(a!.reasons[0]).toBe("離 11/15「半馬」剩 5 週，以跑步為主（平常的主要運動是騎車，賽後回到騎車）");
    // 全馬 12 週、10 km 6 週
    expect(alloc(profile, [race({ date: "2027-01-03", distance_km: 42.2, name: "全馬" })])!.primary).toBe("run");
    expect(alloc(profile, [race({ date: "2026-12-20", distance_km: 10, name: "10K" })])!.primary).toBe("ride");
    // 考慮中的、已經有結局的不算
    expect(alloc(profile, [race({ confirmed: 0 })])!.primary).toBe("ride");
    // 單車的賽事 8 週
    expect(alloc({ pref_primary_sport: "run" }, [race({ sport: "ride", name: "百K", distance_km: 100, date: "2026-11-29" })])!.primary).toBe("ride");
  });

  it("賽前減量週：兩項都降量；賽後恢復那項沒有強度課", () => {
    const profile = { pref_runs_per_week: "4", pref_ride_hours: "3", pref_intensity: "moderate" };
    const taper = alloc(profile, [race({ date: "2026-10-18" })]);
    expect(taper!.taper).toBe(true);
    // 半馬也在準備期：跑步為主（騎車先減到 108），減量再乘 0.6
    expect(of(taper, "run").minutes).toBe(120);
    expect(of(taper, "ride").minutes).toBe(65);
    expect(taper!.reasons).toContain("10/18「半馬」前的減量週：兩項都降量（約 60%），保留少量強度");
    const after = alloc(profile, [race({ date: "2026-10-11", outcome: "finished", result_time: "1:50:00" })]);
    expect(after!.recovering).toBe("run");
    expect(of(after, "run").quality).toBe(0);
    expect(of(after, "ride").quality).toBe(1);
    // 恢復完回到原本的
    expect(alloc(profile, [race({ date: "2026-10-01", outcome: "finished", result_time: "1:50:00" })])!.recovering).toBeNull();
  });

  it("給教練看的一段", () => {
    const text = allocationText(alloc({ pref_primary_sport: "run" })!).join("\n");
    expect(text).toContain("【這週的額度】");
    expect(text).toContain("兩項合計的強度課最多 3 堂");
    expect(text).toContain("reason 用一句話告訴選手");
  });
});
