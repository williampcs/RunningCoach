import { describe, expect, it } from "vitest";

import { accumulate, cityDistanceKm, landmarks, landmarkTrack, regionOf, splitSummary } from "../src/history";
import type { Workout } from "../src/types";
import { activity, makeCoach, toolTurn, turn } from "./helpers";

const ZONES = [145, 153, 161, 170, 175, 182, 190];
const raw = (id: string, zoneMin: number[]) => JSON.stringify({ id, icu_hr_zone_times: zoneMin.map((m) => m * 60), icu_hr_zones: ZONES, lthr: 172 });

describe("分析摘要的結論與細節", () => {
  it("第一段當結論，其餘收起；空白與沒有摘要", () => {
    expect(splitSummary("\n穩定的有氧跑\n\n- 配速穩定\n- 體感相符")).toEqual({ headline: "穩定的有氧跑", details: "- 配速穩定\n- 體感相符" });
    expect(splitSummary("只有一句")).toEqual({ headline: "只有一句", details: null });
    expect(splitSummary(null)).toEqual({ headline: null, details: null });
  });

  it("舊格式：第一行的數據與「AI評估」的標籤略過；數據之後直接是條列時沒有結論", () => {
    expect(splitSummary("**10 公里有氧跑**｜配速 5:30/km｜心率 152\n\n- 配速穩定\n- 體感相符")).toEqual({
      headline: null,
      details: "- 配速穩定\n- 體感相符",
    });
    expect(splitSummary("📊 數據摘要：10.02km、55 分鐘、5:30/km\n\n🤖 **AI評估**：有氧跑得很穩，心率控制好。\n下次可以多 1 km。")).toEqual({
      headline: "有氧跑得很穩，心率控制好。",
      details: "下次可以多 1 km。",
    });
    expect(splitSummary("10km｜55分鐘｜5:30/km｜心率 152/171\n**AI評估**\n穩定的有氧跑")).toEqual({ headline: "穩定的有氧跑", details: null });
    // 結論裡提到數字不算數據行
    expect(splitSummary("配速 5:30、心率 152，都在輕鬆跑的範圍").headline).toBe("配速 5:30、心率 152，都在輕鬆跑的範圍");
  });
});

describe("紀錄頁的卡片", () => {
  const plan = {
    week_start: "2026-10-05",
    style: "fixed",
    reason: "這週",
    sessions: [
      { date: "2026-10-08", kind: "threshold", title: "4×1 km 閾值", steps: [{ distance_km: 2, target: { hr: "easy" } }, { repeat: 4, steps: [{ distance_km: 1, target: { pace: "T" } }] }], purpose: "閾值", success: "每趟在範圍內" },
    ],
    accept_warnings: true,
    warning_notes: "測試",
  };

  it("強度分配、對應的課與預期的體感；課表外的跑步；摘要分段", async () => {
    const { coach } = await makeCoach([toolTurn("save_training_plan", plan), turn({ text: "好" })]);
    const tempo = await coach.db.saveWorkout(activity({ intervals_id: "i1", date: "2026-10-08", distance_km: 8, duration_min: 45, raw_json: raw("i1", [15, 10, 5, 0, 15, 0, 0]) }), 8, "最後一趟很硬");
    await coach.db.saveWorkoutSummary(tempo, "閾值課完成，最後一趟偏難\n\n- 前三趟穩定");
    const easy = await coach.db.saveWorkout(activity({ intervals_id: "i2", date: "2026-10-06", distance_km: 6, duration_min: 38, raw_json: raw("i2", [38, 0, 0, 0, 0, 0, 0]) }));
    await coach.db.saveWorkout(activity({ intervals_id: "i3", date: "2026-09-30", distance_km: 5, duration_min: 30, raw_json: JSON.stringify({ id: "i3" }) }));
    await coach.chat("排課表");

    const cards = await coach.runCards(30);
    expect(cards.map((c) => c.workout.date)).toEqual(["2026-10-08", "2026-10-06", "2026-09-30"]);
    const [t, e, old] = cards;
    expect(t!.plan).toMatchObject({ kindLabel: "T 閾值", title: "4×1 km 閾值", outcome: "achieved", difficulty: "hard", difficultyLabel: "體感偏難" });
    expect(t!.expectedRpe).toEqual([6, 7]);
    expect(t!.intensity).toEqual({ low: 25 * 60, moderate: 5 * 60, high: 15 * 60 });
    expect(t).toMatchObject({ headline: "閾值課完成，最後一趟偏難", details: "- 前三趟穩定", outsidePlan: false });
    // 有課表的週、但那天沒有課
    expect(e!.workout.id).toBe(easy);
    expect(e).toMatchObject({ plan: null, outsidePlan: true, expectedRpe: null });
    // 課表以前的週；沒有心率區間
    expect(old).toMatchObject({ plan: null, outsidePlan: false, intensity: null, headline: null });
  });
});

describe("紀錄頁頁首的累積", () => {
  let id = 1;
  const w = (date: string, km: number, minutes: number, elevation = 0) =>
    ({ id: id++, date, distance_km: km, duration_min: minutes, elevation_m: elevation }) as Workout;

  it("總量、週數、最長的一趟、里程碑與每一趟的格子", () => {
    const runs = [w("2025-12-30", 21.1, 120, 300), w("2026-10-06", 8, 48, 50), w("2026-10-08", 12, 70, 200), w("2026-10-01", 4, 25)];
    const a = accumulate(runs, "2026-10-10", "TW");
    expect(a).toMatchObject({ runs: 4, km: 45.1, minutes: 263, elevationM: 550, weeks: 3, since: "2025-12-30", thisYearKm: 24, marathons: 1.1, region: "TW" });
    expect(a.climb).toEqual({ name: "台北 101", meters: 508, kind: "tower", count: 1.08 });
    expect(a.thisWeek).toEqual({ runs: 2, km: 20, minutes: 118 });
    expect(a.longest).toEqual({ km: 21.1, date: "2025-12-30" });
    expect(a.passed).toEqual({ name: "環島到林口", km: 41 });
    expect(a.next).toEqual({ name: "環島到桃園", km: 49 });
    expect(a.blocks.map((b) => b.size)).toEqual([3, 0, 1, 2]);

    // 沒選所在地區：不依賴所在地的里程碑，爬升和聖母峰比
    const anywhere = accumulate(runs, "2026-10-10");
    expect(anywhere.region).toBe("");
    expect(anywhere.passed).toEqual({ name: "一場全馬", km: 42.195 });
    expect(anywhere.next).toEqual({ name: "雙洋超馬（南非）", km: 56 });
    expect(anywhere.climb).toEqual({ name: "聖母峰", meters: 8849, kind: "mountain", count: 0.06 });
  });

  it("里程碑的地區：沒填是通用；依時區自動判斷；手動選的；不認得的當成通用", () => {
    expect(regionOf(undefined, "Asia/Taipei")).toBe("");
    expect(regionOf("auto", "Asia/Taipei")).toBe("TW");
    expect(regionOf("auto", "Europe/London")).toBe("");
    expect(regionOf("TW", "Europe/London")).toBe("TW");
    expect(regionOf("JP", "Asia/Tokyo")).toBe("");
  });

  it("這週沒跑不顯示 0；紀錄都在今年時不另外列今年；沒有紀錄", () => {
    const a = accumulate([w("2026-09-28", 5, 30)], "2026-10-10", "TW");
    expect(a.thisWeek).toBeNull();
    expect(a.thisYearKm).toBeNull();
    expect(a.passed).toBeNull();
    expect(a.next).toEqual({ name: "環島到台北", km: 25 });
    expect(accumulate([], "2026-10-10")).toMatchObject({ runs: 0, km: 0, since: null, thisWeek: null, longest: null });
  });

  it("里程碑切細：相鄰兩站不超過 1.4 倍（地球一圈之後照舊），由近到遠；城市間的距離用座標算", () => {
    for (const region of ["", "TW"] as const) {
      const places = landmarks(region);
      for (let i = 1; i < places.length; i++) {
        expect(places[i]!.km).toBeGreaterThan(places[i - 1]!.km);
        if (places[i - 1]!.km < 40075) expect(places[i]!.km / places[i - 1]!.km).toBeLessThanOrEqual(1.4);
      }
    }
    // 大圓距離（公里，四捨五入）
    expect(cityDistanceKm("台北", "東京")).toBe(2095);
    expect(cityDistanceKm("倫敦", "巴黎")).toBe(344);
    expect(cityDistanceKm("台北", "台北")).toBe(0);
    // 台灣：環島之旅從基隆出發，沿西部南下、經墾丁沿東部回來，最後是環島一圈；之後從桃園機場飛出去
    const tw = landmarks("TW");
    const island = tw.slice(0, tw.findIndex((p) => p.short === "環島一圈") + 1).map((p) => p.short);
    expect(island).toEqual(["台北", "五股", "林口", "桃園", "中壢", "楊梅", "湖口", "新竹", "頭份", "苗栗", "三義", "台中", "彰化", "斗南", "嘉義", "台南", "高雄", "枋寮", "墾丁", "台東", "花蓮", "宜蘭", "環島一圈"]);
    expect(tw.find((p) => p.short === "台中")).toEqual({ name: "環島到台中", short: "台中", km: 178, approx: true });
    expect(tw.find((p) => p.short === "環島一圈")).toEqual({ name: "環島一圈（回到基隆）", short: "環島一圈", km: 1000, approx: false });
    expect(cityDistanceKm("桃園機場", "東京")).toBe(2118);
    expect(tw.find((p) => p.short === "東京")).toEqual({ name: "從台灣飛到東京", short: "東京", km: 2118, approx: true });
    expect(tw.some((p) => p.name.startsWith("台北到"))).toBe(false);
  });

  it("四站的軌道：起點 A B C；過了 C 換成 B C D E；除了一開始都在中段或後段", () => {
    const names = (t: ReturnType<typeof landmarkTrack>) => t.stations.map((s) => s.short);
    // 0 km：起點、台北、五股、林口，在起點；軌道上方是環島
    const zero = landmarkTrack(0, "TW");
    expect(names(zero)).toEqual(["起點", "台北", "五股", "林口"]);
    expect(zero).toMatchObject({ origin: "環島：從基隆出發", at: 0, fraction: 0 });
    // 剛過 A（台北 25）
    const a = landmarkTrack(26, "TW");
    expect(a.at).toBe(1);
    expect(a.stations.map((s) => s.passed)).toEqual([true, true, false, false]);
    expect(a.fraction).toBeCloseTo(1 / 8, 5);
    // 在 B–C 之間（五股 33–林口 41）
    const bc = landmarkTrack(37, "TW");
    expect(names(bc)).toEqual(["起點", "台北", "五股", "林口"]);
    expect(bc).toMatchObject({ at: 2, fraction: 0.5 });
    // 剛過 C（林口 41）：往前移兩站
    const c = landmarkTrack(41, "TW");
    expect(names(c)).toEqual(["五股", "林口", "桃園", "中壢"]);
    expect(c.at).toBe(1);
    // 過了 D（桃園）還是同一組；過了 E（中壢）再移兩站
    expect(names(landmarkTrack(50, "TW"))).toEqual(["五股", "林口", "桃園", "中壢"]);
    expect(landmarkTrack(50, "TW").at).toBe(2);
    expect(names(landmarkTrack(62, "TW"))).toEqual(["桃園", "中壢", "楊梅", "湖口"]);
    // 使用者的例子：1,060 km 在環島一圈（1,000）與馬尼拉之間，不在軌道的前段；上方改成從台灣出發
    const user = landmarkTrack(1060, "TW");
    expect(user.stations[user.at]!.short).toBe("環島一圈");
    expect(user.at).toBeGreaterThanOrEqual(1);
    expect(user.origin).toBe("從台灣（桃園機場）出發");
    expect(landmarkTrack(950, "TW").origin).toBe("環島：從基隆出發");
    // 接近最後一站（地球一圈）：最後幾站
    const end = landmarkTrack(40000, "TW");
    expect(names(end)).toEqual(["地球半圈", "紐約來回", "四分之三圈", "地球一圈"]);
    expect(end.at).toBe(2);
    // 全部走完：停在最後一站
    const done = landmarkTrack(50000, "TW");
    expect(done).toMatchObject({ at: 3, fraction: 0 });
    // 每個位置都在軌道上（除了一開始，不在前三分之一以前）
    for (let km = 26; km < 40075; km += 37) {
      const t = landmarkTrack(km, "TW");
      expect(t.at).toBeGreaterThanOrEqual(1);
    }
    expect(landmarkTrack(100, "").origin).toBeNull();
  });
});
