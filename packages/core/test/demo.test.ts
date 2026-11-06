import { describe, expect, it } from "vitest";

import { checkLlmKey, classifyKeyError, DEMO_REPLY, demoSource, FakeActivitySource, LlmError, OpenAICompatibleError, seedDemo } from "../src";
import { makeCoach, ScriptedProvider, turn } from "./helpers";

describe("先看看的範例（規格 12.35 的 B）", () => {
  it("寫進範例的資料：跑步、恢復資料、選手資料、賽事、課表、分析與一段對話；不打 AI", async () => {
    const today = "2026-10-10";
    const demo = demoSource(today);
    const source = new FakeActivitySource(demo.activities, () => today, demo.wellness, demo.runSettings);
    const { coach, provider } = await makeCoach([], { source });
    await seedDemo(coach, source);
    expect(provider.calls).toHaveLength(0);
    expect(await coach.db.countWorkouts()).toBeGreaterThan(20);
    const profile = await coach.db.getProfile();
    expect(profile.goal_long_term).toContain("半馬");
    expect(profile.record_with).toBe("watch");
    expect((await coach.db.getAllRaces()).map((r) => r.name)).toContain("範例半馬");
    const convo = await coach.db.getRecentConversations(10);
    expect(convo.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(convo[1]!.content).toBe(DEMO_REPLY);
    const plan = (await coach.db.getActiveTrainingPlan()) ?? (await coach.db.getNextTrainingPlan());
    expect(plan).toBeDefined();
    const sessions = await coach.db.getPlannedSessions(plan!.id);
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => !s.date || s.date >= today)).toBe(true);
    const withSummary = (await coach.db.getRecentWorkouts(14)).slice(0, 2);
    expect(withSummary.length).toBe(2);
  });
});

describe("貼上 key 就檢查（規格 12.35 的 A）", () => {
  const status = (code: number, message: string) => Object.assign(new Error(message), { status: code });

  it("錯誤分成看得懂的幾類", () => {
    expect(classifyKeyError(status(401, "invalid x-api-key"))).toBe("key");
    expect(classifyKeyError(new OpenAICompatibleError(401, "401 Incorrect API key provided"))).toBe("key");
    expect(classifyKeyError(status(400, "Your credit balance is too low to access the Anthropic API."))).toBe("credit");
    expect(classifyKeyError(new OpenAICompatibleError(429, "429 You exceeded your current quota, please check your plan and billing details."))).toBe("credit");
    expect(classifyKeyError(status(404, "model: claude-x not_found_error"))).toBe("model");
    expect(classifyKeyError(new OpenAICompatibleError(429, "429 Rate limit reached"))).toBe("rate");
    expect(classifyKeyError(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifyKeyError(status(500, "overloaded"))).toBe("other");
  });

  it("打一次最小的請求；成功或模型沒產生文字都算可以用，錯誤回看得懂的話", async () => {
    const ok = new ScriptedProvider([turn({ text: "pong" })]);
    expect(await checkLlmKey(ok, "m")).toEqual({ ok: true });
    expect(ok.calls[0]!.request).toMatchObject({ model: "m", maxTokens: 16, messages: [{ role: "user", content: "ping" }] });
    expect(await checkLlmKey(new ScriptedProvider([new LlmError("沒有內容")]), "m")).toEqual({ ok: true });
    const bad = await checkLlmKey(new ScriptedProvider([status(401, "invalid x-api-key")]), "m");
    expect(bad).toMatchObject({ ok: false, problem: "key" });
    expect(bad.ok ? "" : bad.message).toContain("key 不對");
  });
});
