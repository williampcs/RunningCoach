import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  COACHING_METHOD,
  COACHING_METHOD_VERSION,
  coachingMethod,
  CROSS_TRAINING_METHOD,
  CROSS_TRAINING_RULES,
  PLANNING_RULES,
  planningRules,
} from "../src/coaching-method";
import { makeCoach, toolTurn, turn } from "./helpers";

describe("教練方法", () => {
  it("程式與 doc/coaching-method.md 的版本一致（多運動開著時）", () => {
    const doc = readFileSync(new URL("../../../doc/coaching-method.md", import.meta.url), "utf8");
    expect(doc).toContain(`版本 ${COACHING_METHOD_VERSION}（`);
    expect(coachingMethod({ multisport: true })).toContain(`【教練方法 v${COACHING_METHOD_VERSION}】`);
    expect(coachingMethod({ multisport: true })).toContain(CROSS_TRAINING_METHOD);
    expect(planningRules({ multisport: true })).toContain(`教練方法 v${COACHING_METHOD_VERSION}`);
    expect(planningRules({ multisport: true })).toContain(CROSS_TRAINING_RULES);
  });

  it("多運動關著時和加上交叉訓練之前一樣（v3）", () => {
    expect(coachingMethod()).toBe(COACHING_METHOD);
    expect(planningRules()).toBe(PLANNING_RULES);
    expect(COACHING_METHOD).toContain("【教練方法 v3】");
    expect(COACHING_METHOD).not.toContain("v4");
    expect(PLANNING_RULES).not.toContain("v4");
  });

  it("系統提示每次都帶原則；排課表的細則附在訓練數值後面", async () => {
    const { coach, provider } = await makeCoach([toolTurn("get_training_values"), turn({ text: "好" })]);
    await coach.chat("幫我排下週的課表");
    const system = provider.calls[0]!.request.system!;
    expect(system).toContain(COACHING_METHOD);
    expect(system).toContain("給建議時附上一兩個依據");
    expect(system).not.toContain("【排課表的規則");
    expect(provider.calls[1]!.toolResults![0]!.content.endsWith(PLANNING_RULES)).toBe(true);
  });
});

describe("回覆的依據", () => {
  it("由這次呼叫成功的讀取工具產生，同樣的只列一次，並存進對話紀錄", async () => {
    const { coach } = await makeCoach([
      toolTurn("get_training_values", {}, "a"),
      toolTurn("get_recent_workouts", { days: 28 }, "b"),
      toolTurn("get_training_values", {}, "c"),
      // 執行失敗的不算；存檔類的工具不算
      toolTurn("get_recovery_status", { days: "很多" }, "d"),
      toolTurn("save_daily_checkin", { energy: 4, soreness: 2, sleep: 4 }, "e"),
      turn({ text: "下週照這樣排" }),
      turn({ text: "不客氣" }),
    ]);
    const first = await coach.chat("幫我排下週");
    expect(first.sources).toEqual(["訓練數值", "最近 28 天的訓練"]);
    const second = await coach.chat("謝謝");
    expect(second.sources).toEqual([]);

    const rows = await coach.db.getRecentConversations(10);
    expect(rows.map((r) => r.sources)).toEqual([[], ["訓練數值", "最近 28 天的訓練"], [], []]);
  });
});
