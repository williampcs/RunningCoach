import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { COACHING_METHOD, COACHING_METHOD_VERSION, PLANNING_RULES } from "../src/coaching-method";
import { makeCoach, toolTurn, turn } from "./helpers";

describe("教練方法", () => {
  it("程式與 doc/coaching-method.md 的版本一致", () => {
    const doc = readFileSync(new URL("../../../doc/coaching-method.md", import.meta.url), "utf8");
    expect(doc).toContain(`版本 ${COACHING_METHOD_VERSION}（`);
    expect(COACHING_METHOD).toContain(`【教練方法 v${COACHING_METHOD_VERSION}】`);
    expect(PLANNING_RULES).toContain(`教練方法 v${COACHING_METHOD_VERSION}`);
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
