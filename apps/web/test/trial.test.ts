/** 網頁版的免費試用（邀請碼，規格 12.39）：兌換、剩幾則、用完的說明. 和真的代理（apps/proxy）接起來測. */
import Anthropic from "@anthropic-ai/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createProxy } from "../../proxy/src/handler";
import { DEFAULT_POLICY } from "../../proxy/src/policy";
import { AccountStore } from "../../proxy/src/store";
import { defaultSettings, llmProblem, suggestedModels, type AppSettings } from "../src/settings";
import {
  trialThinkingLabel,
  codeKind,
  createLinkCode,
  deleteTrialAccount,
  fetchTrialUsage,
  limitText,
  listTrialDevices,
  modelLabel,
  redeemInvite,
  removeTrialDevice,
  resetText,
  trialLimitOf,
  TrialError,
} from "../src/trial";

let driver: NodeSqliteDriver;
let proxyFetch: typeof fetch;

beforeEach(async () => {
  driver = openNodeSqlite(":memory:");
  const store = new AccountStore(driver);
  await store.init();
  const proxy = createProxy({
    store,
    policy: { ...DEFAULT_POLICY, dailyMessages: 1 },
    upstream: { baseUrl: "https://upstream.test", apiKey: "x" },
    adminToken: "admin",
    allowedOrigins: ["*"],
    fetch: (async () =>
      Response.json({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })) as typeof fetch,
    now: () => new Date("2026-11-10T04:00:00Z"),
  });
  proxyFetch = ((input: string | URL | Request, init?: RequestInit) => proxy(new Request(input, init))) as typeof fetch;
});

afterEach(() => driver.close());

const PROXY = "https://proxy.test";

async function newCode(): Promise<string> {
  const response = await proxyFetch(`${PROXY}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin" }, body: "{}" });
  return ((await response.json()) as any).invites[0].code;
}

function trialSettings(token: string): AppSettings {
  return { ...defaultSettings(), llmMode: "proxy", proxy: { url: PROXY, token }, models: suggestedModels("proxy", "anthropic") };
}

describe("免費試用", () => {
  it("兌換邀請碼拿到憑證；用過的碼顯示代理的說明", async () => {
    const code = await newCode();
    const { token, model } = await redeemInvite(code, PROXY, proxyFetch);
    expect(token).toMatch(/^rc_/);
    expect(model).toBe("claude-haiku-5-5");
    await expect(redeemInvite(code, PROXY, proxyFetch)).rejects.toThrow("這個邀請碼已經用過了");
    await expect(redeemInvite("abc", PROXY, proxyFetch)).rejects.toThrow("格式不對");
    expect(codeKind("rc-abcd-efgh-jkmn")).toBe("invite");
    expect(codeKind("ABCDEFGHJKMN")).toBe("invite");
    expect(codeKind("abcd-efgh")).toBe("link");
    expect(codeKind("abc")).toBeNull();
    await expect(redeemInvite(code, PROXY, (async () => Promise.reject(new TypeError("offline"))) as typeof fetch)).rejects.toBeInstanceOf(TrialError);
  });

  it("查今天還剩幾則；用完時 SDK 的錯誤看得出是哪一種、明天幾點恢復；可以刪除帳號", async () => {
    const { token } = await redeemInvite(await newCode(), PROXY, proxyFetch);
    const settings = trialSettings(token);
    expect((await fetchTrialUsage(settings, proxyFetch)).today).toEqual({ messagesUsed: 0, messagesLimit: 1, autoUsed: 0, autoLimit: 2, resetsAt: "2026-11-11T00:00:00+08:00" });
    // 免費試用是 Haiku、思考強度 low（規格 12.43），畫面寫「少量思考」
    const usage = await fetchTrialUsage(settings, proxyFetch);
    expect(usage).toMatchObject({ model: "claude-haiku-5-5", thinking: true, effort: "low" });
    expect(trialThinkingLabel(usage)).toBe("少量思考");
    expect(trialThinkingLabel(null)).toBe("少量思考");
    expect(trialThinkingLabel({ thinking: false, effort: null })).toBe("不思考");

    const client = new Anthropic({ apiKey: token, baseURL: PROXY, fetch: proxyFetch, maxRetries: 0 });
    const ask = () => client.messages.create({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "嗨" }] });
    await ask();
    expect((await fetchTrialUsage(settings, proxyFetch)).today.messagesUsed).toBe(1);
    const error = await ask().catch((e: unknown) => e);
    const limit = trialLimitOf(error);
    expect(limit).toEqual({ type: "daily_limit", resetsAt: "2026-11-11T00:00:00+08:00" });
    expect(limitText(limit!, 15, new Date("2026-11-10T04:00:00Z"))).toBe("今天的 15 則用完了，明天 00:00（台灣時間）恢復。");
    expect(trialLimitOf(new Error("其他錯誤"))).toBeNull();

    await deleteTrialAccount(settings, proxyFetch);
    await expect(fetchTrialUsage(settings, proxyFetch)).rejects.toThrow("試用憑證無效");
    // 已經刪掉的再刪一次不算錯
    await deleteTrialAccount(settings, proxyFetch);
  });

  it("恢復的時間、模型的名字、設定不完整的說明", () => {
    const now = new Date("2026-11-10T04:00:00Z");
    expect(resetText("2026-11-11T00:00:00+08:00", now)).toBe("明天 00:00（台灣時間）");
    expect(resetText("2026-12-01T00:00:00+08:00", now)).toBe("12 月 1 日");
    expect(resetText(null, now)).toBe("之後");
    expect(limitText({ type: "beta_budget", resetsAt: "2026-12-01T00:00:00+08:00" }, undefined, now)).toBe("這個月的免費額度用完了（所有試用的人合計），12 月 1 日恢復。");
    expect(modelLabel("claude-haiku-5-5")).toBe("Claude Haiku 5.5");

    const empty = { ...defaultSettings(), llmMode: "proxy" as const, proxy: { url: PROXY, token: "" } };
    expect(llmProblem(empty)).toBe("還沒輸入免費試用的邀請碼");
    expect(llmProblem({ ...empty, proxy: { url: "", token: "" } })).toBe("這個版本沒有提供免費試用");
    expect(suggestedModels("proxy", "openai")).toEqual({ chat: "claude-haiku-5-5", summary: "claude-haiku-5-5", compress: "claude-haiku-5-5" });
  });
});

describe("在另一台裝置使用", () => {
  it("連結碼讓另一台拿到自己的憑證；列出裝置、移除另一台", async () => {
    const { token } = await redeemInvite(await newCode(), PROXY, proxyFetch);
    const phone = trialSettings(token);
    const { code, expiresAt } = await createLinkCode(phone, proxyFetch);
    expect(expiresAt).toBe("2026-11-10T04:10:00.000Z");
    const laptop = trialSettings((await redeemInvite(code, PROXY, proxyFetch)).token);
    await expect(redeemInvite(code, PROXY, proxyFetch)).rejects.toThrow("這個連結碼已經用過了");

    const devices = await listTrialDevices(laptop, proxyFetch);
    expect(devices.map((d) => d.current)).toEqual([false, true]);
    await removeTrialDevice(laptop, devices[0]!.id, proxyFetch);
    await expect(fetchTrialUsage(phone, proxyFetch)).rejects.toThrow("試用憑證無效");
    expect((await fetchTrialUsage(laptop, proxyFetch)).today.messagesLimit).toBe(1);
  });
});
