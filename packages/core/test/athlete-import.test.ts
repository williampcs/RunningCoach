import { describe, expect, it } from "vitest";

import { buildExtractionPrompt, IMPORT_PROMPT, parseExtraction, PROFILE_FIELDS } from "../src";
import { makeCoach, turn } from "./helpers";

const TODAY = "2026-10-10";

describe("parseExtraction", () => {
  it("keeps known profile keys and drops unknown or empty values", () => {
    const result = parseExtraction(
      JSON.stringify({
        profile: { pb_10k: "48:30", weight_kg: 62, injuries: "不明", nickname: "小明", resting_hr: " " },
        races: [],
        plan: null,
      }),
      TODAY,
    );
    expect(result).toEqual({ profile: { pb_10k: "48:30", weight_kg: "62" }, races: [], plan: null });
  });

  it("accepts a reply wrapped in a code block with surrounding text", () => {
    const reply = '整理如下：\n```json\n{"profile": {"goal_long_term": "全馬破四"}, "races": [], "plan": "- 週二 間歇"}\n```\n以上。';
    expect(parseExtraction(reply, TODAY)).toEqual({
      profile: { goal_long_term: "全馬破四" },
      races: [],
      plan: "- 週二 間歇",
    });
  });

  it("keeps only future races with a real date and distance, sorted by date", () => {
    const result = parseExtraction(
      JSON.stringify({
        profile: {},
        races: [
          { name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:59:00", notes: null },
          { name: "去年的賽", date: "2026-03-01", distance_km: 21.0975 },
          { name: "日期不明", date: "2026-11", distance_km: 10 },
          { name: "不存在的日期", date: "2026-02-30", distance_km: 10 },
          { name: "沒有距離", date: "2026-11-01", distance_km: "很遠" },
          { name: "秋季 10K", date: "2026-11-08", distance_km: "10", target_time: "不明" },
        ],
        plan: "無",
      }),
      TODAY,
    );
    expect(result.races).toEqual([
      { name: "秋季 10K", date: "2026-11-08", distance_km: 10, target_time: null, notes: null },
      { name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:59:00", notes: null },
    ]);
    expect(result.plan).toBeNull();
  });

  it("rejects a reply without JSON", () => {
    expect(() => parseExtraction("抱歉，我無法整理。", TODAY)).toThrow("無法解讀");
    expect(() => parseExtraction("{不是 JSON}", TODAY)).toThrow("無法解讀");
  });
});

describe("import prompts", () => {
  it("lists every profile field for the model", () => {
    const prompt = buildExtractionPrompt("原文", TODAY);
    for (const field of PROFILE_FIELDS) expect(prompt).toContain(field.key);
    expect(prompt).toContain(`今天是 ${TODAY}`);
    expect(prompt).toContain('"""\n原文\n"""');
  });

  it("asks the old service not to guess or share contact details", () => {
    expect(IMPORT_PROMPT).toContain("不要猜測");
    expect(IMPORT_PROMPT).toContain("不需要提供姓名或聯絡方式");
  });
});

describe("Coach import", () => {
  it("extracts suggestions with the summary model without writing anything", async () => {
    const { coach, provider, driver } = await makeCoach([
      turn({ text: JSON.stringify({ profile: { pb_10k: "48:30" }, races: [], plan: null }) }),
    ]);
    const suggestion = await coach.extractImport("  10K 最佳 48:30  ");

    expect(suggestion.profile).toEqual({ pb_10k: "48:30" });
    expect(provider.calls[0]!.request.model).toBe("summary-model");
    expect(provider.calls[0]!.request.messages[0]!.content).toContain('"""\n10K 最佳 48:30\n"""');
    expect(await driver.all("SELECT * FROM athlete_profile")).toEqual([]);
    expect(await driver.all("SELECT * FROM conversations")).toEqual([]);
  });

  it("writes the confirmed profile fields, races and plan", async () => {
    const { coach } = await makeCoach([]);
    await coach.db.setProfileKey("pb_10k", "50:00");

    const result = await coach.applyImport({
      profile: { pb_10k: "48:30", goal_long_term: "全馬破四", injuries: "  " },
      races: [{ name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:59:00", notes: null }],
      plan: "- 週二 間歇\n- 週日 長跑",
    });

    expect(result).toEqual({ profile: 2, races: 1, plan: true });
    expect(await coach.db.getProfile()).toEqual({ pb_10k: "48:30", goal_long_term: "全馬破四" });
    expect(await coach.db.getAllRaces()).toMatchObject([
      { name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:59:00", notes: null },
    ]);
    expect(await coach.db.getActiveTrainingPlan()).toMatchObject({ week_label: "2026-W41", content: "- 週二 間歇\n- 週日 長跑" });
  });

  it("leaves the current plan alone when no plan is selected", async () => {
    const { coach } = await makeCoach([]);
    await coach.savePlanForThisWeek("原本的課表");
    await coach.applyImport({ profile: {}, races: [], plan: null });
    expect((await coach.db.getActiveTrainingPlan())?.content).toBe("原本的課表");
  });
});
