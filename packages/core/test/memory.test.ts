import { describe, expect, it } from "vitest";

import { localDayStartUtc, MEMORY_MAX_ITEMS } from "../src";
import { makeCoach, NOW, toolTurn, turn } from "./helpers";

describe("記住的事", () => {
  it("新增、改寫、刪除；空的、太長、超過上限都不行", async () => {
    const { coach } = await makeCoach();
    const id = await coach.db.addMemory("  週三晚上要接小孩，不能練 ", "user");
    expect(await coach.db.getMemories()).toMatchObject([{ id, content: "週三晚上要接小孩，不能練", source: "user" }]);
    expect(await coach.db.updateMemory(id, "週三、週五晚上不能練")).toBe(true);
    expect((await coach.db.getMemories())[0]!.content).toBe("週三、週五晚上不能練");
    await expect(coach.db.addMemory("  ", "user")).rejects.toThrow("空的");
    await expect(coach.db.addMemory("長".repeat(301), "user")).rejects.toThrow("一句話");
    expect(await coach.db.deleteMemory(id)).toBe(true);
    expect(await coach.db.deleteMemory(id)).toBe(false);
    for (let i = 0; i < MEMORY_MAX_ITEMS; i++) await coach.db.addMemory(`第 ${i} 條`, "coach");
    await expect(coach.db.addMemory("再一條", "user")).rejects.toThrow("上限");
  });

  it("每次對話都在系統提示裡；教練用 remember、forget 記下與刪掉", async () => {
    const { coach, provider } = await makeCoach([
      toolTurn("remember", { content: "鞋子跑到 600 公里要換" }),
      turn({ text: "已記下：鞋子跑到 600 公里要換" }),
      toolTurn("remember", { content: "鞋子跑到 700 公里要換", replace_id: 1 }),
      toolTurn("forget", { memory_id: 99 }),
      turn({ text: "改好了" }),
    ]);
    await coach.db.addMemory("週三晚上不能練", "user");
    await coach.chat("幫我記住，鞋子 600 公里要換");
    expect(provider.calls[0]!.request.system).toContain("- [1] 週三晚上不能練（2026-10-10，選手記的）");
    expect(provider.calls[1]!.toolResults![0]!.content).toBe("已記下（id=2）：鞋子跑到 600 公里要換");
    expect(await coach.db.getMemories()).toMatchObject([
      { content: "週三晚上不能練", source: "user" },
      { content: "鞋子跑到 600 公里要換", source: "coach" },
    ]);

    await coach.chat("其實是 700");
    expect(provider.calls[2]!.request.system).toContain("- [2] 鞋子跑到 600 公里要換（2026-10-10，教練記的）");
    // replace_id=1 改寫的是第一條；不存在的 id 回報失敗
    expect(provider.calls[3]!.toolResults![0]!.content).toBe("已改寫（id=1）：鞋子跑到 700 公里要換");
    expect(provider.calls[4]!.toolResults![0]!.content).toBe("執行失敗：找不到 id=99 的記住的事");
  });
});

describe("完整的對話紀錄", () => {
  it("壓縮後原文保留：對話頁看得到（標成已整理）、教練只帶入還沒整理的；一段一段往前讀", async () => {
    let clock = NOW.getTime();
    const { coach } = await makeCoach([], { now: () => new Date((clock += 60_000)) });
    const ids: number[] = [];
    for (let i = 0; i < 6; i++) ids.push(await coach.db.appendConversation(i % 2 ? "assistant" : "user", `第 ${i} 則`));
    await coach.db.applyCompression("摘要", ids[3]!);
    expect(await coach.db.countConversations()).toBe(2);
    expect((await coach.db.getRecentConversations(10)).map((c) => c.content)).toEqual(["第 4 則", "第 5 則"]);
    expect((await coach.db.getMemorySnapshot(10)).conversations.map((c) => c.content)).toEqual(["第 4 則", "第 5 則"]);
    expect(await coach.db.getOldestConversations(10)).toHaveLength(2);

    const latest = await coach.db.getConversationPage(4);
    expect(latest.map((c) => [c.content, c.archived])).toEqual([
      ["第 2 則", true],
      ["第 3 則", true],
      ["第 4 則", false],
      ["第 5 則", false],
    ]);
    const older = await coach.db.getConversationPage(4, { timestamp: latest[0]!.timestamp!, id: latest[0]!.id });
    expect(older.map((c) => c.content)).toEqual(["第 0 則", "第 1 則"]);
    expect((await coach.db.getConversation(ids[0]!))?.content).toBe("第 0 則");
  });

  it("search_conversations：依當地日期與關鍵字找，包含已整理的；% 這類字元照字面比對", async () => {
    const times = ["2026-10-02T23:30:00Z", "2026-10-03T01:00:00Z", "2026-10-05T12:00:00Z", "2026-10-09T03:00:00Z"];
    let i = 0;
    const { coach, provider } = await makeCoach(
      [
        toolTurn("search_conversations", { from: "2026-10-03", to: "2026-10-03" }),
        toolTurn("search_conversations", { keyword: "小腿" }),
        toolTurn("search_conversations", { keyword: "100%" }),
        toolTurn("search_conversations", {}),
        turn({ text: "找到了" }),
      ],
      { now: () => new Date(times[i++] ?? "2026-10-10T04:00:00Z") },
    );
    const first = await coach.db.appendConversation("user", "週五間歇後小腿很緊"); // 台北 10/3 07:30
    await coach.db.appendConversation("assistant", "下週先換成輕鬆跑"); // 台北 10/3 09:00
    await coach.db.appendConversation("user", "強度 100% 跑完了"); // 台北 10/5
    await coach.db.appendConversation("user", "小腿好多了"); // 台北 10/9
    await coach.db.applyCompression("摘要", first);
    await coach.chat("上週六聊了什麼？");
    const results = provider.calls.slice(1).map((c) => c.toolResults![0]!.content);
    expect(results[0]).toBe(
      "找到的對話（舊的在前）：\n" +
        "[message_id=1] 2026-10-03（星期六）07:30 選手：週五間歇後小腿很緊\n" +
        "[message_id=2] 2026-10-03（星期六）09:00 教練：下週先換成輕鬆跑",
    );
    expect(results[1]).toContain("[message_id=1]");
    expect(results[1]).toContain("[message_id=4]");
    expect(results[2]).toContain("強度 100% 跑完了");
    expect(results[2]!.split("\n")).toHaveLength(2);
    expect(results[3]).toBe("執行失敗：至少要給 from、to 或 keyword");
  });

  it("當地日期換成 UTC：台北的 10/18 00:00 是 10/17 16:00 UTC；日光節約時間也對", () => {
    expect(localDayStartUtc("2026-10-18", "Asia/Taipei")).toBe("2026-10-17T16:00:00Z");
    expect(localDayStartUtc("2026-07-01", "America/New_York")).toBe("2026-07-01T04:00:00Z");
    expect(localDayStartUtc("2026-01-01", "America/New_York")).toBe("2026-01-01T05:00:00Z");
    expect(localDayStartUtc("2026-03-08", "America/New_York")).toBe("2026-03-08T05:00:00Z");
  });
});

describe("回覆", () => {
  it("選手回覆某一則：存下摘錄，教練看到回覆的是哪一則", async () => {
    const { coach, provider } = await makeCoach([turn({ text: "週四的節奏跑" }), turn({ text: "可以換到週五" })]);
    await coach.chat("這週的課表？");
    const [, reply] = await coach.db.getRecentConversations(10);
    await coach.chat("這堂可以換天嗎", undefined, { replyTo: { role: "assistant", timestamp: reply!.timestamp!, text: reply!.content } });
    const rows = await coach.db.getRecentConversations(10);
    expect(rows[2]!.reply_to).toEqual({ role: "assistant", timestamp: reply!.timestamp, text: "週四的節奏跑" });
    const last = provider.calls[1]!.request.messages.at(-1)!;
    expect(last.content).toContain("（回覆 [2026-10-10（星期六）12:00，今天] 教練的訊息：「週四的節奏跑」）\n這堂可以換天嗎");
  });
});
