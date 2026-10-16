import { openNodeSqlite } from "@running-coach/sqlite-node";
import { describe, expect, it } from "vitest";

import {
  addDays,
  analyzeRecovery,
  Coach,
  FakeActivitySource,
  formatRecoveryReport,
  IntervalsClient,
  type DailyCheckin,
  type WellnessDay,
} from "../src";
import { silentLogger } from "../src/types";
import { activity, makeCoach, ScriptedProvider, toolTurn, turn } from "./helpers";

const TODAY = "2026-10-10";
const day = (date: string, partial: Partial<WellnessDay> = {}): WellnessDay => ({
  date,
  resting_hr: 52,
  hrv: 60,
  sleep_secs: 7 * 3600,
  sleep_score: 80,
  readiness: null,
  ...partial,
});
/** 前 7 天正常，最後一天（今天）依參數 */
const week = (latest: Partial<WellnessDay>) => [
  ...Array.from({ length: 7 }, (_, i) => day(addDays(TODAY, -7 + i))),
  day(TODAY, latest),
];
const checkin = (partial: Partial<DailyCheckin> = {}): DailyCheckin => ({
  date: TODAY,
  energy: 4,
  soreness: 2,
  sleep: 4,
  notes: null,
  ...partial,
});

describe("analyzeRecovery", () => {
  it("compares today with the days before", () => {
    const s = analyzeRecovery(week({ resting_hr: 58, hrv: 45, sleep_secs: 5.5 * 3600 }), [], TODAY);
    expect(s).toMatchObject({ restingHrDelta: 6, hrvChangePct: -25, sleepHours: 5.5, checkin: null, mismatch: null });
    expect(s.watchFlags).toEqual(["靜息心率比前幾天平均高 6 bpm", "HRV 比前幾天平均低 25%", "睡眠只有 5.5 小時"]);
  });

  it("compares with the usual level, so a slump lasting several days still shows", () => {
    const wellness = Array.from({ length: 36 }, (_, i) => {
      const daysAgo = 35 - i;
      // 最近 10 天一路偏高：前 7 天的平均也偏高，只有和「平常」比才看得出來
      return day(addDays(TODAY, -daysAgo), daysAgo < 10 ? { resting_hr: 58, hrv: 46 } : {});
    });
    const s = analyzeRecovery(wellness, [], TODAY);
    expect(s.baselineLabel).toBe("平常");
    // 平常（8～35 天前）含 2 天偏高：靜息心率平均 52.4、HRV 59
    expect(s.watchFlags).toEqual(["靜息心率比平常平均高 6 bpm", "HRV 比平常平均低 22%"]);
  });

  it("does not compare without enough earlier days, and ignores stale data", () => {
    const short = analyzeRecovery([day(addDays(TODAY, -1)), day(TODAY, { resting_hr: 70 })], [], TODAY);
    expect(short.restingHrDelta).toBeNull();
    expect(short.watchFlags).toEqual([]);

    const stale = analyzeRecovery([day(addDays(TODAY, -3))], [], TODAY);
    expect(stale.latest).toBeNull();
  });

  it("flags how the runner feels and where watch and feeling disagree", () => {
    const poor = analyzeRecovery(week({}), [checkin({ energy: 2, soreness: 4, sleep: 2 })], TODAY);
    expect(poor.selfFlags).toEqual(["自評精神差（2/5）", "自評痠痛明顯（4/5）", "自評睡不好（2/5）"]);
    expect(poor.mismatch).toBe("self_worse");

    const fine = analyzeRecovery(week({ resting_hr: 59 }), [checkin()], TODAY);
    expect(fine.mismatch).toBe("watch_worse");

    const both = analyzeRecovery(week({ resting_hr: 59 }), [checkin({ energy: 2 })], TODAY);
    expect(both.mismatch).toBeNull();
  });

  it("writes a per-day report that puts the runner's feeling first", () => {
    const report = formatRecoveryReport(week({ resting_hr: 58 }), [checkin({ energy: 2, notes: "右小腿緊" })], TODAY, 3);
    expect(report).toContain("2026-10-10（星期六）　手錶：靜息心率 58｜HRV 60｜睡眠 7h　自評：精神 2/5、痠痛 2/5、睡眠 4/5；右小腿緊");
    expect(report).toContain("・手錶：靜息心率比前幾天平均高 6 bpm");
    expect(report).toContain("・自評：自評精神差（2/5）");
    expect(report).toContain("以選手的感受為主");
    expect(formatRecoveryReport([], [], TODAY, 7)).toContain("最近沒有恢復資料");
  });
});

describe("wellness from Intervals.icu", () => {
  it("reads the wellness endpoint and drops days without values", async () => {
    const requests: string[] = [];
    const intervals = new IntervalsClient({
      apiKey: "secret",
      today: () => TODAY,
      fetch: async (input) => {
        requests.push(String(input));
        return new Response(
          JSON.stringify([
            { id: "2026-10-10", restingHR: 55, hrv: 58.2, sleepSecs: 25200, sleepScore: 80, ctl: 40 },
            { id: "2026-10-09", weight: 62 },
          ]),
        );
      },
    });
    expect(await intervals.fetchWellness(14)).toEqual([
      expect.objectContaining({ date: "2026-10-10", resting_hr: 55, hrv: 58.2, sleep_secs: 25200, sleep_score: 80, readiness: null }),
    ]);
    expect(requests[0]).toBe("https://intervals.icu/api/v1/athlete/0/wellness?oldest=2026-09-26&newest=2026-10-10");
  });

  it("syncs wellness even when there are no runs, and keeps runs going if wellness fails", async () => {
    const make = (source: FakeActivitySource) =>
      new Coach({
        driver: openNodeSqlite(":memory:"),
        llm: { provider: new ScriptedProvider([]), models: { chat: "c", summary: "s", compress: "p" }, chatEffort: "medium" },
        activities: source,
        now: () => new Date(`${TODAY}T04:00:00Z`),
        logger: silentLogger,
      });

    const resting = make(new FakeActivitySource([], () => TODAY, week({})));
    await resting.init();
    expect(await resting.sync()).toBe("Intervals.icu 最近 14 天無跑步活動。已更新恢復資料 8 天。");
    expect(await resting.db.getWellness(7)).toHaveLength(8);

    const broken = new FakeActivitySource([], () => TODAY);
    broken.fetchWellness = async () => {
      throw new Error("down");
    };
    const coach = make(broken);
    await coach.init();
    expect(await coach.sync()).toBe("Intervals.icu 最近 14 天無跑步活動。（恢復資料暫時無法取得）");
  });
});

describe("recovery in the coach", () => {
  it("adds today's condition to the system prompt only when there is some", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "a" }), turn({ text: "b" })]);
    await coach.chat("你好");
    expect(provider.calls[0]!.request.system).not.toContain("今日身體狀況");

    await coach.db.upsertWellness(week({ resting_hr: 58 }));
    await coach.saveCheckin({ energy: 2, soreness: 3, sleep: 4, notes: " 有點累 " });
    await coach.chat("今天可以練嗎");
    const system = provider.calls[1]!.request.system!;
    expect(system).toContain("今日身體狀況：\n・選手自評：精神 2/5、痠痛 3/5、睡眠 4/5；有點累");
    expect(system).toContain("・手錶（2026-10-10）：靜息心率 58（前幾天平均 52，+6）｜HRV 60 ms（+0%）｜睡眠 7 小時｜睡眠分數 80");
    expect(system).toContain("【身體狀況的判讀】手錶的恢復數據只是參考。");
  });

  it("records a check-in and reports recovery through tools", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("save_daily_checkin", { energy: 2, soreness: 4, sleep: 3, notes: "右小腿緊" }),
      toolTurn("get_recovery_status", { days: 3 }),
      toolTurn("save_daily_checkin", { energy: 9, soreness: 1, sleep: 1 }),
      turn({ text: "今天休息吧" }),
    ]);
    await coach.db.upsertWellness(week({}));
    await coach.chat("今天好累，小腿很緊，睡得普通");

    expect(provider.calls[1]!.toolResults![0]!.content).toBe("已記錄今天（2026-10-10）的身體狀況：精神 2/5、痠痛 4/5、睡眠 3/5；右小腿緊");
    expect(provider.calls[2]!.toolResults![0]!.content).toContain("・選手自評偏差，但手錶正常：以選手的感受為主，降低今天的強度。");
    expect(provider.calls[3]!.toolResults![0]!.content).toContain("energy 必須是 1–5");
    expect(await coach.db.getCheckin(TODAY)).toEqual({ date: TODAY, energy: 2, soreness: 4, sleep: 3, notes: "右小腿緊" });
  });

  it("brings the day's condition into the post-run analysis", async () => {
    const prompt = (provider: ScriptedProvider) => String(provider.calls[0]!.request.messages[0]!.content);

    const plain = await makeCoach([turn({ text: "摘要" })], { activities: [activity()] });
    await plain.coach.reportRun(6, "腿很重");
    expect(prompt(plain.provider)).not.toContain("當天身體狀況");

    const { coach, provider } = await makeCoach([turn({ text: "摘要" })], { activities: [activity()] });
    // 跑步之後的日期不算：分析的是跑步當天的狀況
    await coach.db.upsertWellness([...week({ resting_hr: 58 }), day(addDays(TODAY, 1), { resting_hr: 70 })]);
    await coach.saveCheckin({ energy: 4, soreness: 2, sleep: 4, notes: null });
    await coach.reportRun(6, "腿很重");
    expect(prompt(provider)).toContain(
      "當天身體狀況：手錶：靜息心率 58（前幾天平均 52，+6）｜HRV 60 ms（+0%）｜睡眠 7 小時｜睡眠分數 80；選手自評：精神 4/5、痠痛 2/5、睡眠 4/5\n",
    );
    expect(prompt(provider)).toContain("與選手的自評不一致時以選手的感受為主");
  });

  it("rejects check-in scores outside 1–5", async () => {
    const { coach } = await makeCoach([]);
    await expect(coach.saveCheckin({ energy: 0, soreness: 1, sleep: 1, notes: null })).rejects.toThrow("energy 必須是 1–5");
  });
});
