/** Prompt Caching：快取斷點前的內容（工具清單＋系統提示不常變的一段）不隨日期、選手資料、天氣改變（規格 12.23 第 2 點） */
import { describe, expect, it } from "vitest";

import { ContextManager } from "../src/context";
import { buildTools } from "../src/tools";
import { DEFAULT_SETTINGS, type CoachSettings } from "../src/types";
import { activity, makeCoach, NOW, toolTurn, turn, type RecordedCall } from "./helpers";

/** 斷點前的內容：工具清單與系統提示不常變的那段，依請求的順序（tools → system） */
function cachedPrefix(call: RecordedCall): string {
  const { system, systemStableChars, tools } = call.request;
  expect(systemStableChars).toBeGreaterThan(0);
  return JSON.stringify(tools) + system!.slice(0, systemStableChars);
}

const SETTINGS: [string, Partial<CoachSettings>][] = [
  ["預設", {}],
  ["網頁版＋多運動", { shell: "web", features: ["multisport"] }],
];

describe("Prompt Caching", () => {
  it.each(SETTINGS)("換日期、選手資料、記住的事、賽事、身體狀況時，斷點前一個位元組都不變（%s）", async (_label, settings) => {
    let now = NOW;
    const { coach, provider } = await makeCoach(
      [toolTurn("get_training_plan"), turn({ text: "好" }), turn({ text: "好" })],
      { settings, now: () => now },
    );
    await coach.chat("這週怎麼練？");

    now = new Date("2026-10-12T22:30:00Z"); // 隔幾天，台北 2026-10-13 06:30
    await coach.db.setProfileKey("weight_kg", "66");
    await coach.db.setProfileKey("max_hr", "188");
    await coach.db.setProfileKey("injuries", "左腳跟腱緊");
    await coach.db.addMemory("週三晚上不能練", "user");
    await coach.db.addRace({ name: "田中馬", date: "2026-11-08", distance_km: 42.195 });
    await coach.db.saveCheckin({ date: "2026-10-13", energy: 2, soreness: 4, sleep: 2, notes: "沒睡好" });
    await coach.chat("今天要練嗎？");

    const [first, toolRound, later] = provider.calls;
    const prefix = cachedPrefix(first!);
    // 同一則回覆的工具迴圈、隔幾天選手資料變了，斷點前都一樣
    expect(cachedPrefix(toolRound!)).toBe(prefix);
    expect(cachedPrefix(later!)).toBe(prefix);
    expect(later!.request.system).not.toBe(first!.request.system);

    // 會變的都在斷點後面
    const stable = later!.request.system!.slice(0, later!.request.systemStableChars);
    for (const text of ["2026-10-10", "2026-10-13", "66kg", "188", "左腳跟腱緊", "週三晚上不能練", "田中馬", "沒睡好"]) {
      expect(stable).not.toContain(text);
      expect(later!.request.system).toContain(text === "2026-10-10" ? "2026-10-13" : text);
    }
  });

  it("換天氣時斷點前不變；天氣在斷點後面", async () => {
    const { coach } = await makeCoach();
    const context = new ContextManager(coach.db, { ...DEFAULT_SETTINGS }, () => NOW);
    const sunny = await context.buildSystemParts({ weather: "晴，24–31°C，露點 22°C" });
    const rainy = await context.buildSystemParts({ weather: "大雨，19–22°C" });
    const missing = await context.buildSystemParts({ weather: null });
    expect(rainy.stable).toBe(sunny.stable);
    expect(missing.stable).toBe(sunny.stable);
    expect(sunny.dynamic).toContain("晴，24–31°C");
    expect(sunny.stable).not.toContain("°C");
  });

  it("同一個設定下工具清單固定（內容與順序）", () => {
    for (const [, settings] of SETTINGS) {
      const s = { ...DEFAULT_SETTINGS, ...settings };
      for (const options of [{}, { weather: true }]) {
        expect(JSON.stringify(buildTools(s, options))).toBe(JSON.stringify(buildTools(s, options)));
      }
    }
  });

  it("系統提示提醒需要好幾樣資料時同一輪一起呼叫", async () => {
    const { coach } = await makeCoach();
    const context = new ContextManager(coach.db, { ...DEFAULT_SETTINGS }, () => NOW);
    expect((await context.buildSystemParts()).stable).toContain("在同一輪一起呼叫");
  });

  it("get_recent_workouts：7 天內的 AI 摘要帶全文，更早的只帶第一行的結論；最多查 90 天", async () => {
    const { coach, provider } = await makeCoach([toolTurn("get_recent_workouts", { days: 365 }), turn({ text: "好" })]);
    const summary = (date: string) => `${date} 的結論\n\n- 說明一\n- 說明二`;
    for (const date of ["2026-10-10", "2026-10-04", "2026-10-03", "2026-07-13", "2026-07-11"]) {
      const id = await coach.db.saveWorkout(activity({ date, intervals_id: date }));
      await coach.db.saveWorkoutSummary(id, summary(date));
    }
    await coach.chat("最近練得怎樣");
    const result = provider.calls[1]!.toolResults![0]!.content;
    expect(result).toContain("最近 90 天的訓練紀錄（共 4 筆）");
    expect(result).toContain(`AI摘要：${summary("2026-10-10")}`);
    expect(result).toContain(`AI摘要：${summary("2026-10-04")}`);
    expect(result).toContain("AI摘要：2026-10-03 的結論\n");
    expect(result).not.toContain("2026-07-11");
    expect(result.match(/說明一/g)).toHaveLength(2);
    expect(result).toContain("（7 天以前的 AI 摘要只列第一行的結論）");
  });
});
