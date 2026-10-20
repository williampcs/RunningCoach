import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import {
  Coach,
  danielsPaces,
  durationText,
  estimateVdot,
  FakeActivitySource,
  fakeRunSettings,
  formatPace,
  generateActivities,
  generateWellness,
  heartRateInfo,
  IntervalsClient,
  predictSecs,
  vdotOf,
  type FakeSpec,
  type PaceCurveSummary,
  type Race,
  type RunSettings,
  type Workout,
} from "../src";
import {
  effortDistribution,
  intensityDistribution,
  latestFitness,
  parseDuration,
  weeklySummaries,
} from "../src/training-values";
import { silentLogger } from "../src/types";
import { activity, makeCoach, ScriptedProvider, toolTurn, turn } from "./helpers";

const TODAY = "2026-10-10";
/** Intervals.icu 預設的 7 區（閾值心率 172） */
const SETTINGS: RunSettings = { lthr: 172, max_hr: 190, hr_zones: [145, 153, 161, 170, 175, 182, 190], threshold_pace: null };

const race = (partial: Partial<Race>): Race => ({
  id: 1,
  name: "城市路跑",
  date: "2026-09-20",
  distance_km: 10,
  target_time: null,
  confirmed: 1,
  result_time: "45:00",
  notes: null,
  cancelled: 0,
  created_at: "2026-09-01T00:00:00Z",
  ...partial,
});

const workout = (partial: Partial<Workout>): Workout => ({
  id: 1,
  intervals_id: null,
  strava_id: null,
  date: TODAY,
  type: "run",
  distance_km: 8,
  duration_min: 48,
  avg_hr: 140,
  max_hr: 155,
  avg_pace: "6:00/km",
  elevation_m: 20,
  calories: 500,
  training_load: 50,
  perceived_effort: null,
  subjective_notes: null,
  source: "intervals",
  synced_at: "2026-10-10T00:00:00Z",
  raw_json: null,
  ...partial,
});

const zoned = (times: number[], lthr: number | null = 172) =>
  JSON.stringify({ icu_hr_zone_times: times, icu_hr_zones: SETTINGS.hr_zones, ...(lthr ? { lthr } : {}) });

describe("Daniels 的公式", () => {
  it("和 Daniels 的表一致（VDOT 50：5 km 19:57、10 km 41:21、全馬 3:10:49、T 4:15、I 3:55）", () => {
    expect(vdotOf(5000, 19 * 60 + 57)).toBeCloseTo(50, 0);
    expect(Math.abs(predictSecs(50, 10_000) - (41 * 60 + 21))).toBeLessThan(15);
    expect(Math.abs(predictSecs(50, 42_195) - (3 * 3600 + 10 * 60 + 49))).toBeLessThan(60);
    const p = danielsPaces(50);
    expect(formatPace(p.threshold)).toBe("4:15/km");
    expect(formatPace(p.interval)).toBe("3:55/km");
    expect(formatPace(p.marathon)).toBe("4:31/km");
    expect(p.easy[0]).toBeLessThan(p.easy[1]);
    // VDOT 30 的 5 km 約 30:40
    expect(durationText(predictSecs(30, 5000))).toMatch(/^30:[34]\d$/);
  });

  it("超出公式的適用範圍時不推算", () => {
    expect(vdotOf(1000, 200)).toBeNull();
    expect(vdotOf(1609.34, 200)).toBeNull();
    expect(vdotOf(42_195, 6 * 3600)).toBeNull();
  });

  it("解讀成績的寫法", () => {
    expect(parseDuration("1:52:30")).toBe(6750);
    expect(parseDuration("45:00")).toBe(2700);
    expect(parseDuration("45:00.4")).toBe(2700);
    expect(parseDuration("大約 45 分")).toBeNull();
    expect(durationText(6750)).toBe("1:52:30");
    expect(durationText(2700)).toBe("45:00");
  });
});

describe("VDOT 的來源", () => {
  const curve = (efforts: PaceCurveSummary["efforts"]): PaceCurveSummary => ({ days: 90, critical_speed: null, d_prime: null, efforts });

  it("取最近 90 天最高的；太久以前、取消的、寫不清楚的比賽不算", () => {
    const races = [
      race({ id: 1, result_time: "50:00" }),
      race({ id: 2, date: "2026-05-01", result_time: "40:00" }),
      race({ id: 3, cancelled: 1, result_time: "39:00" }),
      race({ id: 4, result_time: "很快" }),
    ];
    const best = estimateVdot(races, curve([{ distance_m: 5000, secs: 25 * 60, race: false, date: "2026-10-01" }]), TODAY)!;
    expect(best.kind).toBe("race");
    expect(best.secs).toBe(3000);
    expect(estimateVdot([race({ date: "2026-05-01" })], null, TODAY)).toBeNull();
  });

  it("訓練中的最佳表現比比賽好時用它，並標明來源；明顯異常的（例如 GPS 誤差）不用", () => {
    const efforts = curve([
      { distance_m: 5000, secs: 21 * 60, race: false, date: "2026-10-05" },
      { distance_m: 10_000, secs: 44 * 60, race: true, date: "2026-09-28" },
    ]);
    const best = estimateVdot([race({ result_time: "50:00" })], efforts, TODAY)!;
    expect(best.kind).toBe("best_effort");
    expect(best.distanceM).toBe(5000);

    const glitch = curve([
      { distance_m: 1609.34, secs: 4 * 60 + 30, race: false, date: "2026-10-05" },
      { distance_m: 5000, secs: 25 * 60, race: false, date: "2026-10-05" },
    ]);
    expect(estimateVdot([], glitch, TODAY)!.distanceM).toBe(5000);
  });
});

describe("心率的來源", () => {
  it("Intervals.icu 有閾值心率與區間時用它的；輕鬆跑的上限是閾值心率 90% 以下最高的一區", () => {
    const hr = heartRateInfo({}, SETTINGS, TODAY)!;
    expect(hr.source).toBe("intervals");
    expect(hr.zones.map((z) => z.name)).toEqual(["Z1", "Z2", "Z3", "Z4", "Z5a", "Z5b", "Z5c"]);
    expect(hr.zones[1]).toEqual({ name: "Z2", min: 146, max: 153 });
    expect(hr.easyMax).toBe(153);
    expect(hr.maxHr).toBe(190);
    // 選手資料的實測最大心率優先於 Intervals.icu 的設定，區間仍用 Intervals.icu 的
    expect(heartRateInfo({ max_hr: "188" }, SETTINGS, TODAY)!.maxHr).toBe(188);
  });

  it("沒有 Intervals.icu 的設定時，依實測或推算的最大心率；填了但不是數字時不推算", () => {
    const measured = heartRateInfo({ max_hr: "180" }, null, TODAY)!;
    expect(measured.source).toBe("profile");
    expect(measured.easyMax).toBe(142);
    const estimated = heartRateInfo({ birth_year: "1986" }, { lthr: null, max_hr: null, hr_zones: null, threshold_pace: null }, TODAY)!;
    expect(estimated.source).toBe("estimate");
    expect(estimated.maxHr).toBe(180);
    expect(heartRateInfo({ birth_year: "1986", max_hr: "很高" }, null, TODAY)).toBeNull();
    expect(heartRateInfo({}, null, TODAY)).toBeNull();
  });
});

describe("強度分配、每週的量、體能", () => {
  it("依各區的上限與閾值心率分成低、中、高；沒有區間或閾值心率的跑步不算", () => {
    const d = intensityDistribution(
      [
        workout({ raw_json: zoned([600, 1200, 300, 300, 120, 60, 0]) }),
        workout({ raw_json: zoned([0, 0, 0, 0, 0, 0, 100], null) }),
        workout({ raw_json: JSON.stringify({ icu_training_load: 40 }) }),
        workout({ raw_json: null, avg_hr: null }),
      ],
      null,
    );
    expect(d).toEqual({ runs: 4, withZones: 1, lowSecs: 1800, moderateSecs: 600, highSecs: 180 });
    // 活動沒記閾值心率時用設定的
    expect(intensityDistribution([workout({ raw_json: zoned([0, 0, 0, 0, 0, 0, 100], null) })], 172).highSecs).toBe(100);
  });

  it("沒有心率時依體感粗分", () => {
    const e = effortDistribution([3, 4, 6, 8, null].map((perceived_effort) => workout({ perceived_effort })));
    expect(e).toEqual({ rated: 4, low: 2, moderate: 1, high: 1 });
  });

  it("每週一列：跑量、時間、負荷與 sRPE；沒有負荷或體感時不寫 0", () => {
    const weeks = weeklySummaries(
      [
        workout({ date: "2026-10-10", distance_km: 10, duration_min: 60, training_load: 70, perceived_effort: 6 }),
        workout({ date: "2026-10-06", distance_km: 5, duration_min: 30, training_load: null }),
        workout({ date: "2026-10-01", distance_km: 8, duration_min: 50, training_load: null }),
      ],
      TODAY,
      2,
    );
    expect(weeks.map((w) => w.label)).toEqual(["2026-W40", "2026-W41"]);
    expect(weeks[0]).toMatchObject({ start: "2026-09-28", runs: 1, km: 8, load: null, srpe: null });
    expect(weeks[1]).toMatchObject({ start: "2026-10-05", runs: 2, km: 15, minutes: 90, load: 70, srpe: 360, longestKm: 10 });
  });

  it("體能與疲勞：優先用恢復資料，沒有時用最近一筆跑步當時的值", () => {
    const wellness = [
      { date: "2026-10-09", raw_json: JSON.stringify({ ctl: 30, atl: 40, rampRate: 1.5 }) },
      { date: "2026-10-10", raw_json: JSON.stringify({ restingHR: 50 }) },
    ];
    expect(latestFitness(wellness, [])).toEqual({ date: "2026-10-09", ctl: 30, atl: 40, rampRate: 1.5, source: "wellness" });
    const runs = [workout({ date: "2026-10-08", raw_json: JSON.stringify({ icu_ctl: 20, icu_atl: 25 }) })];
    expect(latestFitness([], runs)).toMatchObject({ date: "2026-10-08", ctl: 20, source: "activity" });
    expect(latestFitness([], [])).toBeNull();
  });
});

describe("Intervals.icu 的跑步設定與最佳配速曲線", () => {
  it("只取跑步那組的閾值與區間，選手的其他資料不留；配速曲線取標準距離與臨界速度", async () => {
    const requests: string[] = [];
    const client = new IntervalsClient({
      apiKey: "secret",
      today: () => TODAY,
      fetch: async (input) => {
        const url = String(input);
        requests.push(url);
        if (url.endsWith("/athlete/0")) {
          return Response.json({
            id: "i1",
            email: "runner@example.com",
            sportSettings: [
              { types: ["Ride"], lthr: 160 },
              { types: ["Run", "TrailRun"], lthr: 172, max_hr: 190, hr_zones: SETTINGS.hr_zones, threshold_pace: null },
            ],
          });
        }
        return Response.json({
          list: [
            {
              days: 91,
              distance: [400, 1609.34, 3000, 5000, 10000],
              values: [90, 420, 840, 1460, 3100],
              activity_id: ["i9", "i9", "i8", "i8", "i7"],
              paceModels: [{ type: "CS", criticalSpeed: 3.3, dPrime: 150, r2: 1 }],
            },
          ],
          activities: { i8: { race: true, start_date_local: "2026-09-20T07:00:00" }, i7: { race: false, start_date_local: "2026-10-01T06:00:00" } },
        });
      },
    });
    expect(await client.fetchRunSettings()).toEqual(SETTINGS);
    const curve = (await client.fetchPaceCurve(90))!;
    expect(requests[1]).toBe("https://intervals.icu/api/v1/athlete/0/pace-curves.json?type=Run&curves=90d&pmType=CS");
    expect(curve.critical_speed).toBe(3.3);
    expect(curve.efforts).toEqual([
      { distance_m: 1609.34, secs: 420, race: false, date: null },
      { distance_m: 3000, secs: 840, race: true, date: "2026-09-20" },
      { distance_m: 5000, secs: 1460, race: true, date: "2026-09-20" },
      { distance_m: 10_000, secs: 3100, race: false, date: "2026-10-01" },
    ]);
  });
});

describe("測試模式的假資料", () => {
  const spec: FakeSpec = { scenario: "steady", endDate: TODAY, weeks: 6, runsPerWeek: 4, easyPaceSec: 345, maxHr: 190, seed: 7 };

  it("有心率的跑步帶心率區間時間；只有 iPhone 時沒有", () => {
    const raw = JSON.parse(generateActivities(spec).at(-1)!.raw_json!);
    expect(raw.lthr).toBe(171);
    expect(raw.icu_hr_zones).toHaveLength(7);
    expect(raw.icu_hr_zone_times.reduce((a: number, b: number) => a + b, 0)).toBeGreaterThan(0);
    const phone = JSON.parse(generateActivities({ ...spec, device: "iphone" }).at(-1)!.raw_json!);
    expect(phone.icu_hr_zone_times).toBeUndefined();
    expect(fakeRunSettings({ ...spec, device: "iphone" }).lthr).toBeNull();
  });

  it("恢復資料帶體能與疲勞；配速曲線取夠長的那幾趟", async () => {
    const raw = JSON.parse(generateWellness(spec).at(-1)!.raw_json!);
    expect(raw.ctl).toBeGreaterThan(0);
    expect(raw.atl).toBeGreaterThan(0);
    const source = new FakeActivitySource(generateActivities(spec), () => TODAY, [], fakeRunSettings(spec));
    expect((await source.fetchRunSettings())!.hr_zones).toHaveLength(7);
    const curve = (await source.fetchPaceCurve(90))!;
    expect(curve.efforts.map((e) => e.distance_m)).toEqual([1609.34, 3000, 5000, 10_000]);
    expect(curve.critical_speed).toBeGreaterThan(2);
  });
});

describe("訓練數值進到教練", () => {
  it("同步時存下跑步設定與配速曲線；失敗不影響同步", async () => {
    const spec: FakeSpec = { scenario: "steady", endDate: TODAY, weeks: 4, runsPerWeek: 4, easyPaceSec: 345, maxHr: 190, seed: 3 };
    const source = new FakeActivitySource(generateActivities(spec), () => TODAY, generateWellness(spec), fakeRunSettings(spec));
    const coach = new Coach({
      driver: openNodeSqlite(":memory:"),
      llm: { provider: new ScriptedProvider([]), models: { chat: "c", summary: "s", compress: "p" }, chatEffort: "medium" },
      activities: source,
      now: () => new Date(`${TODAY}T04:00:00Z`),
      logger: silentLogger,
    });
    await coach.init();
    source.fetchPaceCurve = async () => {
      throw new Error("down");
    };
    // 沒有 LLM 回應：AI 分析失敗只記錄，同步照常
    expect(await coach.sync()).toMatch(/^✅ Intervals\.icu 同步完成/);
    expect((await coach.db.getSnapshot<RunSettings>("run_settings"))!.value.lthr).toBe(171);
    expect(await coach.db.getSnapshot("pace_curve")).toBeNull();
  });

  it("系統提示用 Intervals.icu 的區間；工具列出配速、強度分配與依據", async () => {
    const runs = [
      activity({ intervals_id: "i1", date: "2026-10-10", raw_json: zoned([1200, 1500, 400, 200, 0, 0, 0]) }),
      activity({ intervals_id: "i2", date: "2026-10-07", avg_hr: null, max_hr: null, training_load: null, raw_json: "{}" }),
    ];
    const { coach, provider } = await makeCoach([toolTurn("get_training_values"), turn({ text: "好" })]);
    for (const run of runs) await coach.db.saveWorkout(run, 6, "");
    await coach.db.saveSnapshot("run_settings", SETTINGS);
    await coach.db.saveSnapshot("pace_curve", {
      days: 90,
      critical_speed: 3.4,
      d_prime: 150,
      efforts: [{ distance_m: 5000, secs: 22 * 60, race: false, date: "2026-10-03" }],
    } satisfies PaceCurveSummary);

    await coach.chat("下週的課表幫我排一下");
    const system = provider.calls[0]!.request.system!;
    expect(system).toContain("閾值心率：172bpm（Intervals.icu 的設定）");
    expect(system).toContain("心率區間（Intervals.icu）：Z1 ≤145｜Z2 146–153｜Z3 154–161｜Z4 162–170｜Z5a 171–175｜Z5b 176–182｜Z5c 183–190");
    expect(system).toContain("課表與建議中的配速與心率一律用 get_training_values 的數值");

    const result = provider.calls[1]!.toolResults![0]!.content;
    expect(result).toContain("有心率 1 次｜有心率區間時間 1 次｜有回報體感 2 次");
    expect(result).toContain("缺的不補也不估");
    expect(result).toContain("來源：Intervals.icu 的跑步設定");
    expect(result).toContain("輕鬆跑的心率上限：153 bpm（Z2 的上限，約閾值心率的 89%）");
    expect(result).toMatch(/Daniels 的 VDOT \d+\.\d，依據：最近 90 天的最佳 5 km 22:00（2026-10-03），來自訓練、不是比賽，可能低估/);
    expect(result).toContain("・T 閾值配速：");
    expect(result).toContain("臨界速度（Intervals.icu 以最近 90 天的最佳表現擬合，只供對照）：4:54/km");
    expect(result).toContain("Intervals.icu 沒有設定閾值配速");
    expect(result).toContain("依心率區間的時間：低 82%｜中 18%｜高 0%（2 次中 1 次有區間資料");
    expect(result).toContain("sRPE");
  });

  it("什麼都沒有時說明缺什麼、怎麼補", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("get_training_values"),
      turn({ text: "好" }),
      toolTurn("get_training_values"),
      turn({ text: "好" }),
    ]);
    await coach.chat("幫我排課表");
    const result = provider.calls[1]!.toolResults![0]!.content;
    expect(result).toContain("沒有心率的依據");
    expect(result).toContain("做一次 5 km 計時跑");
    expect(result).toContain("無法估計強度分配");

    // 只用手機記錄：有推算的區間，但跑步都沒有心率
    await coach.db.setProfileKey("birth_year", "1986");
    await coach.db.saveWorkout(activity({ avg_hr: null, max_hr: null, training_load: null, raw_json: "{}" }), 5, "");
    await coach.chat("那這週呢");
    const phone = provider.calls[3]!.toolResults![0]!.content;
    expect(phone).toContain("來源：以 220－年齡推算，個人差異常超過 10 bpm");
    expect(phone).toContain("最近的跑步都沒有心率，這些區間暫時用不到");
    expect(phone).toContain("有心率 0 次｜有心率區間時間 0 次｜有回報體感 1 次");
  });
});
