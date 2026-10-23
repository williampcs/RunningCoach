import { describe, expect, it } from "vitest";

import { AnthropicProvider, OpenAICompatibleProvider, Usage, type UsageStats } from "@running-coach/core";

import { loadConfig } from "../src/config";
import { replyParts, splitMessage } from "../src/messages";

const base = { DISCORD_BOT_TOKEN: "t", DISCORD_ALLOWED_CHANNEL_ID: "1234567890123456789", ANTHROPIC_API_KEY: "k" };

describe("loadConfig", () => {
  it("v1 的 .env 可直接使用，未設定的值套用與 v1 相同的預設", () => {
    const config = loadConfig({
      ...base,
      INTERVALS_API_KEY: "ik",
      CLAUDE_MODEL_SUMMARY: "claude-haiku-5-5",
      CLAUDE_MODEL_COMPRESS: "claude-sonnet-5-5",
      CONVERSATION_MAX: "30",
    });
    expect(config.allowedChannelId).toBe("1234567890123456789");
    expect(config.dbPath).toBe("/app/data/coach.db");
    expect(config.intervals).toEqual({ apiKey: "ik", athleteId: "0" });
    expect(config.llm.provider).toBeInstanceOf(AnthropicProvider);
    expect(config.llm.models).toEqual({
      chat: "claude-opus-5-5",
      summary: "claude-haiku-5-5",
      compress: "claude-sonnet-5-5",
    });
    expect(config.llm.chatEffort).toBe("medium");
    expect(config.settings).toMatchObject({
      timeZone: "Asia/Taipei",
      conversationMax: 30,
      conversationKeep: 10,
      raceLookbackDays: 14,
      toolCallMaxRounds: 5,
      maxResponseTokens: 16000,
    });
  });

  it("其他供應商必須指定模型；摘要與壓縮未設定時沿用主對話模型", () => {
    const config = loadConfig({ ...base, LLM_PROVIDER: "gemini", LLM_API_KEY: "g", LLM_MODEL: "some-model" });
    expect(config.llm.provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(config.llm.models).toEqual({ chat: "some-model", summary: "some-model", compress: "some-model" });
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "openai", LLM_API_KEY: "o" })).toThrow("缺少環境變數 LLM_MODEL");
  });

  it("分用途模型只讀該供應商的變數：換供應商時留著的 CLAUDE_MODEL_* 不會被誤用", () => {
    const config = loadConfig({
      ...base,
      LLM_PROVIDER: "openai",
      LLM_API_KEY: "o",
      LLM_MODEL: "main-model",
      LLM_MODEL_COMPRESS: "small-model",
      CLAUDE_MODEL_SUMMARY: "claude-haiku-5-5",
    });
    expect(config.llm.models).toEqual({ chat: "main-model", summary: "main-model", compress: "small-model" });
  });

  it("天氣的座標選填，四捨五入到 0.1°", () => {
    expect(loadConfig(base).weather).toBeNull();
    expect(loadConfig({ ...base, WEATHER_LOCATION: "25.0478, 121.5319" }).weather).toEqual({ lat: 25, lon: 121.5 });
    expect(() => loadConfig({ ...base, WEATHER_LOCATION: "台北" })).toThrow("WEATHER_LOCATION");
  });

  it("設定錯誤時在啟動階段就報錯", () => {
    expect(() => loadConfig({ ...base, DISCORD_BOT_TOKEN: "" })).toThrow("缺少環境變數 DISCORD_BOT_TOKEN");
    expect(() => loadConfig({ ...base, CONVERSATION_MAX: "abc" })).toThrow("CONVERSATION_MAX 必須是整數");
    expect(() => loadConfig({ ...base, CLAUDE_CHAT_EFFORT: "extreme" })).toThrow("思考強度必須是");
    expect(() => loadConfig({ ...base, LLM_PROVIDER: "llama" })).toThrow("LLM_PROVIDER 必須是");
  });
});

describe("訊息分段", () => {
  it("在換行處切開，每段不超過上限", () => {
    const text = ["a".repeat(1500), "b".repeat(1500), "c".repeat(100)].join("\n");
    const parts = splitMessage(text);
    expect(parts).toEqual(["a".repeat(1500), "b".repeat(1500) + "\n" + "c".repeat(100)]);
    expect(splitMessage("x".repeat(4500)).map((p) => p.length)).toEqual([2000, 2000, 500]);
    expect(splitMessage("")).toEqual([]);
  });

  it("頁尾附在最後一段，放不下時另起一段", () => {
    const usage = new Usage();
    usage.add({ input: 1200, cacheRead: 0, cacheWrite: 0, output: 300 });
    const stats: UsageStats = { layerChars: { layer1: 600, layer4: 0, layer5: 300 }, userMsgChars: 100, usage };
    const footer = "-# 📊 輸入 1,200（層1系統~720  層5對話~360  訊息~120） | 輸出 300";

    expect(replyParts("短回覆", stats)).toEqual([`短回覆\n${footer}`]);
    expect(replyParts("短回覆", null)).toEqual(["短回覆"]);
    const long = "y".repeat(1990);
    expect(replyParts(long, stats)).toEqual([long, footer]);
    for (const part of replyParts("z".repeat(5000), stats)) expect(part.length).toBeLessThanOrEqual(2000);
  });

  it("回覆的依據放在頁尾之前，同樣是小字", () => {
    expect(replyParts("好", null, ["訓練數值", "最近 14 天的訓練"])).toEqual(["好\n-# 參考了：訓練數值、最近 14 天的訓練"]);
    expect(replyParts("好", null, [])).toEqual(["好"]);
  });
});
