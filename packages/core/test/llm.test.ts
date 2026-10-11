import { describe, expect, it } from "vitest";

import { LlmError, type ToolDef } from "../src";
import { Llm } from "../src/llm";
import { silentLogger } from "../src/types";
import { ScriptedProvider, toolTurn, turn } from "./helpers";

const tools: ToolDef[] = [
  { name: "echo", description: "回傳輸入", input_schema: { type: "object", properties: {}, required: [] } },
];

function makeLlm(script: ConstructorParameters<typeof ScriptedProvider>[0], toolCallMaxRounds = 5) {
  const provider = new ScriptedProvider(script);
  const llm = new Llm(
    {
      provider,
      models: { chat: "chat-model", summary: "summary-model", compress: "compress-model" },
      chatEffort: "medium",
      maxResponseTokens: 16000,
      toolCallMaxRounds,
    },
    silentLogger,
  );
  return { llm, provider };
}

describe("Llm.runWithTools", () => {
  it("執行工具並把結果交回，直到模型產生最終回應；用量逐輪累加", async () => {
    const { llm, provider } = makeLlm([
      turn({
        finish: "tool_use",
        toolCalls: [
          { id: "a", name: "echo", input: { v: 1 } },
          { id: "b", name: "echo", input: { v: 2 } },
        ],
        usage: { input: 1000, cacheRead: 200, cacheWrite: 50, output: 30 },
      }),
      turn({ text: "完成", usage: { input: 1300, cacheRead: 0, cacheWrite: 0, output: 40 } }),
    ]);
    const executed: unknown[] = [];
    const result = await llm.runWithTools("sys", [{ role: "user", content: "hi" }], tools, async (name, input) => {
      executed.push([name, input]);
      return `result-${input.v}`;
    });

    expect(result).toMatchObject({ text: "完成", finish: "ok" });
    expect(executed).toEqual([
      ["echo", { v: 1 }],
      ["echo", { v: 2 }],
    ]);
    expect(provider.calls[0]!.request).toMatchObject({
      model: "chat-model",
      system: "sys",
      maxTokens: 16000,
      effort: "medium",
      tools,
    });
    // 同一輪的所有工具結果一次交回
    expect(provider.calls[1]).toMatchObject({
      toolResults: [
        { id: "a", content: "result-1" },
        { id: "b", content: "result-2" },
      ],
      disableTools: false,
    });
    expect(result.usage).toMatchObject({
      firstInputTokens: 1250,
      inputTokens: 2300,
      cacheReadTokens: 200,
      cacheWriteTokens: 50,
      outputTokens: 70,
      apiCalls: 2,
      toolRounds: 1,
      totalInputTokens: 2550,
    });
  });

  it("達最大輪數時最後一次呼叫禁止再用工具", async () => {
    const { llm, provider } = makeLlm([toolTurn("echo"), toolTurn("echo"), toolTurn("echo"), turn({ text: "收尾" })], 3);
    let executions = 0;
    const result = await llm.runWithTools("sys", [], tools, async () => `r${++executions}`);

    expect(executions).toBe(3);
    expect(provider.calls.map((c) => c.disableTools ?? false)).toEqual([false, false, false, true]);
    expect(result).toMatchObject({ text: "收尾", finish: "ok" });
    expect(result.usage).toMatchObject({ apiCalls: 4, toolRounds: 3 });
  });

  it("拒絕回答與截斷會反映在 finish", async () => {
    const refused = await makeLlm([turn({ finish: "refused" })]).llm.runWithTools("s", [], tools, async () => "");
    expect(refused.finish).toBe("refused");
    const truncated = await makeLlm([turn({ finish: "truncated", text: "講到一半" })]).llm.runWithTools(
      "s",
      [],
      tools,
      async () => "",
    );
    expect(truncated).toMatchObject({ finish: "truncated", text: "講到一半" });
  });
});

describe("Llm.complete", () => {
  it("依用途選模型，固定用最低思考強度", async () => {
    const { llm, provider } = makeLlm([turn({ text: "摘要" })]);
    expect((await llm.complete("summary", "請摘要", 2000)).text).toBe("摘要");
    expect(provider.calls[0]!.request).toEqual({
      model: "summary-model",
      messages: [{ role: "user", content: "請摘要" }],
      maxTokens: 2000,
      effort: "low",
    });
  });

  it("拒絕回答或沒有文字時丟出 LlmError，避免把空字串存檔", async () => {
    await expect(makeLlm([turn({ finish: "refused", text: "不行" })]).llm.complete("compress", "p", 100)).rejects.toThrow(
      LlmError,
    );
    await expect(makeLlm([turn({ finish: "truncated", text: "  " })]).llm.complete("compress", "p", 100)).rejects.toThrow(
      LlmError,
    );
  });
});
