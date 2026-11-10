/** 代理的部署設定（tools/proxy-config.ts）與管理工具（tools/proxy-admin.ts），規格 12.39. */
import { readFileSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createProxy } from "../../apps/proxy/src/handler";
import { DEFAULT_POLICY, loadPolicy } from "../../apps/proxy/src/policy";
import { AccountStore } from "../../apps/proxy/src/store";
import { run, targetFromEnv } from "../proxy-admin";
import { fillProxyWranglerToml } from "../proxy-config";

const TOML = readFileSync(new URL("../../apps/proxy/wrangler.toml", import.meta.url), "utf8");
const ID = "00000000-1111-2222-3333-444444444444";

describe("proxy-config", () => {
  it("填入名稱、D1 的 id、允許的來源；沒有政策時用預設", () => {
    const out = fillProxyWranglerToml(TOML, {
      workerName: "running-coach-proxy-staging",
      databaseName: "running-coach-proxy-staging",
      databaseId: ID,
      webUrls: "https://staging.zone2mate.com/",
    });
    expect(out).toContain('name = "running-coach-proxy-staging"');
    expect(out).toContain(`database_id = "${ID}"`);
    expect(out).toContain('ALLOWED_ORIGINS = "https://staging.zone2mate.com"');
    expect(out).toContain('PROXY_POLICY = ""');
    expect(out).toContain('crons = ["0 19 * * *"]');
  });

  it("政策寫成 TOML 字串，代理讀回來一樣", () => {
    const out = fillProxyWranglerToml(TOML, { databaseId: ID, webUrls: "https://app.zone2mate.com", policy: '{ "dailyMessages": 20, "totalMonthlyBudgetUsd": 80 }' });
    const line = /^PROXY_POLICY = (.*)$/m.exec(out)![1]!;
    const policy = loadPolicy(JSON.parse(line));
    expect(policy).toMatchObject({ dailyMessages: 20, totalMonthlyBudgetUsd: 80, forceModel: "claude-haiku-5-5" });
  });

  it("政策格式錯、模型沒有價格、沒有網址時失敗", () => {
    const base = { databaseId: ID, webUrls: "https://app.zone2mate.com" };
    expect(() => fillProxyWranglerToml(TOML, { ...base, policy: "{dailyMessages:20" })).toThrow("PROXY_POLICY 不對");
    expect(() => fillProxyWranglerToml(TOML, { ...base, policy: '{"forceModel":"claude-fable-5-2"}' })).toThrow("不在 models 裡");
    expect(() => fillProxyWranglerToml(TOML, { ...base, policy: '{"dailyMessages":-1}' })).toThrow("dailyMessages");
    expect(() => fillProxyWranglerToml(TOML, { databaseId: ID, webUrls: "" })).toThrow("沒有任何允許的網頁網址");
  });
});

describe("proxy-admin", () => {
  let driver: NodeSqliteDriver;
  let proxyFetch: typeof fetch;

  beforeEach(async () => {
    driver = openNodeSqlite(":memory:");
    const store = new AccountStore(driver);
    await store.init();
    const proxy = createProxy({
      store,
      policy: DEFAULT_POLICY,
      upstream: { baseUrl: "https://upstream.test", apiKey: "x" },
      adminToken: "admin-secret",
      allowedOrigins: [],
      now: () => new Date("2026-11-10T04:00:00Z"),
    });
    proxyFetch = ((input: string | URL | Request, init?: RequestInit) => proxy(new Request(input, init))) as typeof fetch;
  });

  afterEach(() => driver.close());

  const target = { url: "https://proxy.test", token: "admin-secret" };

  it("產生邀請碼、列出、停用；帳號的停用與刪除", async () => {
    const created = await run(["invite", "--count", "2", "--expires", "2026-12-31", "--label", "第一批"], target, proxyFetch);
    expect(created).toContain("產生了 2 張邀請碼（只會顯示這一次）");
    const codes = [...created.matchAll(/RC-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/g)].map((m) => m[0]);
    expect(codes).toHaveLength(2);
    expect(created).toContain("到期：2026-12-31");

    const listed = await run(["invites"], target, proxyFetch);
    expect(listed.split("\n")).toHaveLength(2);
    expect(listed).toContain("沒用過  第一批");
    expect(listed).not.toContain(codes[0]);

    const inviteId = /inv_[0-9a-f]+/.exec(listed)![0];
    expect(await run(["revoke", inviteId], target, proxyFetch)).toBe(`已停用 ${inviteId}`);

    const redeemed = await proxyFetch("https://proxy.test/v1/redeem", { method: "POST", body: JSON.stringify({ code: codes[1] }) });
    const accountId = ((await redeemed.json()) as any).account_id as string;
    expect(await run(["accounts"], target, proxyFetch)).toContain(`${accountId}  使用中  本月 US$0.0000／US$10.0000  今天 0 則、自動 0 次`);
    expect(await run(["suspend", accountId], target, proxyFetch)).toBe(`${accountId} 已停用`);
    expect(await run(["summary"], target, proxyFetch)).toContain("帳號 1 個（使用中 0），沒用過的邀請碼 0 張");
    expect(await run(["delete", accountId], target, proxyFetch)).toContain("已刪除");
    expect(await run(["accounts"], target, proxyFetch)).toBe("還沒有帳號。");
  });

  it("管理憑證錯時顯示代理的錯誤；不認得的指令說明有哪些", async () => {
    await expect(run(["summary"], { ...target, token: "wrong" }, proxyFetch)).rejects.toThrow("401 管理憑證無效");
    await expect(run(["oops"], target, proxyFetch)).rejects.toThrow("指令：summary");
  });

  it("從 .env 讀網址與管理憑證；--staging 讀 staging 的", () => {
    const env = { PROXY_URL: "https://p.test/", PROXY_ADMIN_TOKEN: "a", STAGING_PROXY_URL: "https://s.test", STAGING_PROXY_ADMIN_TOKEN: "b" };
    expect(targetFromEnv(env, false)).toEqual({ url: "https://p.test", token: "a" });
    expect(targetFromEnv(env, true)).toEqual({ url: "https://s.test", token: "b" });
    expect(() => targetFromEnv({}, true)).toThrow("STAGING_PROXY_URL");
  });
});
