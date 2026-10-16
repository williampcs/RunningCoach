import { describe, expect, it } from "vitest";

import { formatTokenFooter, formatUsd, priceOf, turnCostUsd, Usage, type ToolDef } from "../src";
import { Llm } from "../src/llm";
import { silentLogger } from "../src/types";
import { ScriptedProvider, toolTurn, turn } from "./helpers";

describe("priceOf", () => {
  it("matches the longest model prefix, with or without a date suffix", () => {
    expect(priceOf("claude-opus-5-5")).toEqual({ input: 4, cacheWrite: 5, cacheRead: 0.2, output: 20 });
    expect(priceOf("claude-opus-5")).toEqual({ input: 5, cacheWrite: 6.25, cacheRead: 0.5, output: 25 });
    expect(priceOf("claude-sonnet-4-5-20250929")).toEqual({ input: 3, cacheWrite: 3.75, cacheRead: 0.3, output: 15 });
    expect(priceOf("Claude-Haiku-5-5")?.input).toBe(0.1);
  });

  it("returns null for models it does not know", () => {
    expect(priceOf("gpt-5")).toBeNull();
    expect(priceOf("claude-opus-5-55")).toBeNull();
    // 未來的新版本不能沿用舊版本的價格
    expect(priceOf("claude-opus-5-6")).toBeNull();
    expect(priceOf("claude-sonnet-5-5-latest")).toBeNull();
    expect(priceOf("chat-model")).toBeNull();
  });

  it("switches Haiku 5.5 to the long-prompt price above 100,000 prompt tokens", () => {
    expect(priceOf("claude-haiku-5-5", 100_000)?.input).toBe(0.1);
    expect(priceOf("claude-haiku-5-5", 100_001)).toEqual({ input: 0.5, cacheWrite: 0.625, cacheRead: 0.05, output: 2.5 });
    expect(priceOf("claude-sonnet-5-5", 500_000)?.input).toBe(2);
  });
});

describe("turnCostUsd", () => {
  it("prices plain input, cache writes, cache reads and output separately", () => {
    const cost = turnCostUsd("claude-opus-5-5", { input: 1000, cacheWrite: 400, cacheRead: 2000, output: 500 });
    // 1000×4 + 400×5 + 2000×0.2 + 500×20 = 16,400 → US$0.0164
    expect(cost).toBeCloseTo(0.0164, 10);
  });

  it("counts cache reads and writes toward Haiku 5.5's prompt length", () => {
    const cost = turnCostUsd("claude-haiku-5-5", { input: 1000, cacheWrite: 0, cacheRead: 100_000, output: 0 });
    expect(cost).toBeCloseTo((1000 * 0.5 + 100_000 * 0.05) / 1_000_000, 12);
  });
});

describe("cost in usage and footer", () => {
  function makeLlm(chatModel: string, script: ConstructorParameters<typeof ScriptedProvider>[0]) {
    const llm = new Llm(
      {
        provider: new ScriptedProvider(script),
        models: { chat: chatModel, summary: "claude-haiku-5-5", compress: chatModel },
        chatEffort: "medium",
        maxResponseTokens: 16000,
        toolCallMaxRounds: 5,
      },
      silentLogger,
    );
    return llm;
  }
  const tools: ToolDef[] = [{ name: "echo", description: "回傳輸入", input_schema: { type: "object", properties: {}, required: [] } }];
  const usage = (input: number, output: number) => ({ input, cacheRead: 0, cacheWrite: 0, output });

  it("adds up every call of a reply, tool rounds included", async () => {
    const llm = makeLlm("claude-sonnet-5-5", [
      { ...toolTurn("echo"), usage: usage(3000, 100) },
      turn({ text: "好", usage: usage(3500, 400) }),
    ]);
    const result = await llm.runWithTools("system", [{ role: "user", content: "hi" }], tools, async () => "ok");
    // (3000+3500)×2 + (100+400)×10 = 18,000 → US$0.018
    expect(result.usage.costUsd).toBeCloseTo(0.018, 10);
    expect(formatTokenFooter({ layerChars: { layer1: 100, layer4: 0, layer5: 0 }, userMsgChars: 2, usage: result.usage })).toMatch(
      /\| 工具 1 輪，累計輸入 6,500 \| 約 US\$0\.018$/,
    );
  });

  it("shows no amount when the model has no known price", async () => {
    const llm = makeLlm("gpt-5", [turn({ text: "好", usage: usage(3000, 100) })]);
    const result = await llm.runWithTools("system", [{ role: "user", content: "hi" }], tools, async () => "ok");
    expect(result.usage.costUsd).toBeNull();
    const footer = formatTokenFooter({ layerChars: { layer1: 100, layer4: 0, layer5: 0 }, userMsgChars: 2, usage: result.usage });
    expect(footer).not.toContain("US$");
  });

  it("stops estimating once any call has an unknown price", () => {
    const u = new Usage();
    u.add(usage(10, 10), 0.001);
    u.add(usage(10, 10), null);
    u.add(usage(10, 10), 0.001);
    expect(u.costUsd).toBeNull();
  });

  it("formats small amounts with enough decimals", () => {
    expect(formatUsd(0.00042)).toBe("US$0.0004");
    expect(formatUsd(0.0156)).toBe("US$0.016");
    expect(formatUsd(1.234)).toBe("US$1.23");
  });
});
