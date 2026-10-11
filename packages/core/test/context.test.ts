import { describe, expect, it } from "vitest";

import { makeCoach } from "./helpers";
import { ContextManager } from "../src/context";
import { DEFAULT_SETTINGS } from "../src";
import { NOW } from "./helpers";

async function setup(profile: Record<string, string> = {}) {
  const { coach } = await makeCoach();
  for (const [k, v] of Object.entries(profile)) await coach.db.setProfileKey(k, v);
  const context = new ContextManager(coach.db, { ...DEFAULT_SETTINGS }, () => NOW);
  return { coach, context };
}

describe("ContextManager", () => {
  it("層1：日期、選手資料、心率區間與賽事清單", async () => {
    const { coach, context } = await setup({
      goal_long_term: "全馬破四",
      pb_10k: "48:30",
      pb_half: "1:52:10",
      injuries: "右膝舊傷",
      weekly_km_target: "40",
      gender: "男",
      birth_year: "1990",
      weight_kg: "68",
      max_hr: "185",
      resting_hr: "52",
      pref_long_run_day: "週日",
    });
    const upcoming = await coach.db.addRace({ name: "萬金石", date: "2026-11-01", distance_km: 21.1, target_time: "1:50:00" });
    const maybe = await coach.db.addRace({ name: "考慮中的比賽", date: "2026-12-20", distance_km: 10, confirmed: 0 });
    const past = await coach.db.addRace({ name: "上週 10K", date: "2026-10-04", distance_km: 10 });

    const prompt = await context.buildSystemPrompt();
    const head = prompt.split("\n請根據選手資料")[0];
    expect(head).toBe(
      [
        "今天日期：2026-10-10（星期六）｜時區：Asia/Taipei（UTC+8）｜以星期一為一週的第一天",
        "",
        "你是一位專業跑步教練，以下是選手資料：",
        "",
        "長期目標：全馬破四",
        "個人最佳：10km 48:30 / 半馬 1:52:10",
        "傷病注意：右膝舊傷",
        "每週目標里程：40km",
        "生理資料：性別：男｜年齡：36歲｜體重：68kg",
        "最大心率：185bpm（實測）",
        "靜息心率：52bpm",
        "心率區間：Z1 <111  Z2 111–129  Z3 129–148  Z4 148–166  Z5 >166",
        "訓練偏好：長跑日：週日",
        "",
        "近期目標賽事：",
        `- [${upcoming}] 2026-11-01 萬金石 21.1km｜目標 1:50:00｜距今 22 天（已確認報名）`,
        `- [${maybe}] 2026-12-20 考慮中的比賽 10km｜目標完賽｜距今 71 天（考慮中）`,
        "",
        "待記錄成績的賽事（已結束、尚未回報成績）：",
        `- [${past}] 2026-10-04 上週 10K 10km｜目標完賽｜6 天前`,
        "",
      ].join("\n"),
    );
    expect(prompt).toContain("【跑後回報】");
  });

  it("沒有實測最大心率時以年齡推算；資料不是數字時略過", async () => {
    const estimated = await (await setup({ birth_year: "1986" })).context.buildSystemPrompt();
    expect(estimated).toContain("最大心率：180bpm（推算，220－年齡）");
    expect(estimated).toContain("心率區間：Z1 <108  Z2 108–126  Z3 126–144  Z4 144–162  Z5 >162");

    const invalid = await (await setup({ birth_year: "八六年", max_hr: "很高" })).context.buildSystemPrompt();
    expect(invalid).not.toContain("年齡");
    expect(invalid).not.toContain("最大心率");
    expect(invalid).not.toContain("心率區間");
  });

  it("層4、層5：摘要在前，未壓縮對話全部帶入，超長訊息截斷", async () => {
    const { coach, context } = await setup();
    const first = await coach.db.appendConversation("user", "舊訊息");
    await coach.db.applyCompression("【訓練狀態】穩定", first);
    await coach.db.appendConversation("user", "x".repeat(700));
    await coach.db.appendConversation("assistant", "好的");

    const ctx = await context.getContextForApi();
    expect(ctx.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(ctx.messages[0]!.content).toBe("以下是之前對話的重點摘要：\n\n【訓練狀態】穩定");
    expect(ctx.messages[2]!.content).toBe("x".repeat(600) + "…（訊息過長，已截短至 600 字）");
    expect(ctx.layerChars).toEqual({
      layer1: ctx.system.length,
      layer4: ctx.messages[0]!.content.length,
      layer5: ctx.messages[2]!.content.length + 2,
    });
  });
});
