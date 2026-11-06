import { describe, expect, it } from "vitest";

import { STOPPED_MARK, stoppedReply, type ChatEvent } from "../src";
import { makeCoach, toolTurn, turn } from "./helpers";

/** 模擬供應商被中斷：等到 signal 中斷時丟出（和 fetch、Anthropic SDK 一樣） */
const aborted = (signal?: AbortSignal) =>
  new Promise<never>((_, reject) => {
    const fail = () => reject(new DOMException("aborted", "AbortError"));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail);
  });

describe("停止回覆（規格 12.38）", () => {
  it("串流到一半停止：存成已經寫出的部分＋（已停止），不是錯誤；下一則對話的歷史是一問一答", async () => {
    const controller = new AbortController();
    const { coach, provider } = await makeCoach([
      (call) => {
        call.onText?.("這週先");
        call.onText?.("輕鬆跑");
        controller.abort();
        return aborted(call.signal);
      },
      turn({ text: "好的" }),
    ]);
    const events: ChatEvent[] = [];
    const result = await coach.chat("這週怎麼練", (e) => events.push(e), { signal: controller.signal });
    expect(result.stopped).toBe(true);
    expect(result.reply).toBe(`這週先輕鬆跑\n\n${STOPPED_MARK}`);
    const rows = await coach.db.getRecentConversations(10);
    expect(rows.map((r) => [r.role, r.content])).toEqual([
      ["user", "這週怎麼練"],
      ["assistant", `這週先輕鬆跑\n\n${STOPPED_MARK}`],
    ]);

    // 停止後再問一次正常；送給模型的歷史沒有連著兩則選手的訊息
    expect((await coach.chat("再說一次")).reply).toBe("好的");
    const roles = provider.calls[1]!.request.messages.map((m) => m.role);
    expect(roles.slice(-3)).toEqual(["user", "assistant", "user"]);
    expect(provider.calls[1]!.request.messages.at(-2)!.content).toContain(STOPPED_MARK);
  });

  it("工具執行中停止：工具做完、不開始下一輪；已經做的寫入不還原，寫出做了什麼與怎麼改回", async () => {
    const controller = new AbortController();
    const { coach, provider } = await makeCoach([
      (call) => {
        call.onText?.("我先記下來");
        call.onToolStart?.("add_race");
        return toolTurn("add_race", { name: "萬金石", date: "2026-11-01", distance_km: 21.1 });
      },
      turn({ text: "不會用到" }),
    ]);
    const result = await coach.chat("幫我加萬金石", (e) => e.type === "tool" && controller.abort(), { signal: controller.signal });
    expect(provider.calls).toHaveLength(1);
    expect(await coach.db.getAllRaces()).toHaveLength(1);
    // 工具前的文字不是回覆，不存
    expect(result.reply).toBe(`${STOPPED_MARK}\n\n已經做的：新增了賽事。停止不會改回已經做的事；要改回的話：到「計畫」的賽事修改或刪除。`);
  });

  it("送出前就停止：不呼叫模型，一樣存一則（已停止）", async () => {
    const controller = new AbortController();
    controller.abort();
    const { coach, provider } = await makeCoach([turn({ text: "不會用到" })]);
    const result = await coach.chat("嗨", () => {}, { signal: controller.signal });
    expect(provider.calls).toHaveLength(0);
    expect(result.reply).toBe(STOPPED_MARK);
  });

  it("讀取的工具不算已經做的；同一種只寫一次", () => {
    expect(stoppedReply("", ["get_training_plan"])).toBe(STOPPED_MARK);
    expect(stoppedReply(" 好 ", ["save_training_plan", "save_training_plan", "remember"])).toBe(
      `好\n\n${STOPPED_MARK}\n\n已經做的：存了課表、記下了要記住的事。停止不會改回已經做的事；要改回的話：到「計畫」看，或請教練再改；到「記住的事」刪除。`,
    );
  });
});
