/**
 * 免費試用的帳號掛進加密的同步（規格 12.44 第 1 步）：和真的代理（apps/proxy）、同步服務（apps/sync）與同步引擎接起來測.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, isKnownSyncName, newDeviceIdentity, newRootKey, SyncApi, SyncEngine, type DeviceIdentity } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createProxy } from "../../proxy/src/handler";
import { DEFAULT_POLICY } from "../../proxy/src/policy";
import { AccountStore } from "../../proxy/src/store";
import { createSyncHandler } from "../../sync/src/handler";
import { SyncStore } from "../../sync/src/store";
import { defaultSettings, suggestedModels, type AppSettings } from "../src/settings";
import { fetchTrialUsage, listTrialDevices, redeemInvite } from "../src/trial";
import {
  autoRecoverable,
  ensureTrialRecord,
  forgetTrialRecord,
  markDeclined,
  needsTrial,
  recoverFromSync,
  rotateTrialSecrets,
  STALE_MS,
  syncedTrials,
} from "../src/trial-sync";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const PROXY = "https://proxy.test";
const HOUR = 3600_000;

let now: Date;
let proxyDriver: NodeSqliteDriver;
let syncDriver: NodeSqliteDriver;
let proxyFetch: typeof fetch;
let api: SyncApi;
/** 經過代理的請求與回應的內容（檢查有沒有把秘密送到不該去的地方） */
let syncTraffic: string[];

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  now = new Date("2026-11-13T04:00:00Z");
  proxyDriver = openNodeSqlite(":memory:");
  const accounts = new AccountStore(proxyDriver);
  await accounts.init();
  const proxy = createProxy({
    store: accounts,
    policy: { ...DEFAULT_POLICY, dailyMessages: 1 },
    upstream: { baseUrl: "https://upstream.test", apiKey: "x" },
    adminToken: "admin",
    allowedOrigins: ["*"],
    fetch: (async () =>
      Response.json({ id: "m", type: "message", role: "assistant", content: [{ type: "text", text: "好" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } })) as typeof fetch,
    now: () => now,
  });
  proxyFetch = ((input: string | URL | Request, init?: RequestInit) => proxy(new Request(input, init))) as typeof fetch;

  syncDriver = openNodeSqlite(":memory:");
  const syncStore = new SyncStore(syncDriver, () => now);
  await syncStore.init();
  const handle = createSyncHandler({ store: syncStore, allowedOrigins: [] });
  syncTraffic = [];
  api = new SyncApi("http://sync.test", async (input, init) => {
    if (typeof init?.body === "string") syncTraffic.push(init.body);
    const response = await handle(new Request(input as string, init));
    syncTraffic.push(await response.clone().text());
    return response;
  });
});

interface Device {
  db: Db;
  driver: NodeSqliteDriver;
  root: Uint8Array;
  identity: DeviceIdentity;
  engine: SyncEngine;
  settings: AppSettings;
}

async function device(root: Uint8Array, settings: AppSettings = defaultSettings()): Promise<Device> {
  const driver = openNodeSqlite(":memory:");
  const db = new Db(driver, { now: () => now, today: () => now.toISOString().slice(0, 10) });
  await db.init();
  const d = { db, driver, root: Uint8Array.from(root), identity: await newDeviceIdentity(), settings } as Device;
  d.engine = new SyncEngine(db, api, d.root, () => now, {
    identity: d.identity,
    label: () => ({ name: "test", platform: "test" }),
    onRootChanged: async (next) => {
      d.root = next;
    },
  });
  return d;
}

async function newInvite(): Promise<string> {
  const response = await proxyFetch(`${PROXY}/admin/invites`, { method: "POST", headers: { authorization: "Bearer admin" }, body: "{}" });
  return ((await response.json()) as any).invites[0].code;
}

async function trialSettings(): Promise<AppSettings> {
  const { token, account } = await redeemInvite(await newInvite(), PROXY, proxyFetch);
  return { ...defaultSettings(), llmMode: "proxy", proxy: { url: PROXY, token, account }, models: suggestedModels("proxy", "anthropic") };
}

const chat = (s: AppSettings) =>
  proxyFetch(`${PROXY}/v1/messages`, {
    method: "POST",
    headers: { "x-api-key": s.proxy.token },
    body: JSON.stringify({ model: "claude-haiku-5-5", max_tokens: 100, messages: [{ role: "user", content: "嗨" }] }),
  });

/** A：用著免費試用、開了同步，紀錄已經存好並送上去 */
async function deviceA(): Promise<Device> {
  const a = await device(newRootKey(), await trialSettings());
  await a.engine.ensureSpace();
  expect(await ensureTrialRecord(a.db, a.root, a.settings, PROXY, proxyFetch)).toMatchObject({ account: a.settings.proxy.account, wrote: true });
  await a.engine.sync();
  return a;
}

describe("試用帳號掛進加密的同步", () => {
  it("A 開著同步：存一筆（本機只有密文、同步服務看不到帳號與密鑰）；B 用復原碼還原後自動取回：同一個帳號、自己的憑證、同一份每天的則數", async () => {
    const a = await deviceA();
    const [record] = await a.db.listTrialAccounts();
    expect(record).toMatchObject({ account: a.settings.proxy.account, proxy_url: PROXY });
    const [synced] = await syncedTrials(a.db, a.root, PROXY);
    expect(synced!.secret).toMatch(/^rcs_[0-9a-f]{64}$/);
    // 資料庫與同步服務裡都沒有明文的密鑰；同步服務也看不到帳號與代理的網址
    expect(JSON.stringify(await a.driver.all("SELECT * FROM trial_accounts"))).not.toContain(synced!.secret.slice(4));
    const traffic = syncTraffic.join("\n");
    for (const plain of [synced!.secret.slice(4), a.settings.proxy.account!, "proxy.test"]) expect(traffic).not.toContain(plain);
    expect(JSON.stringify(await syncDriver.all("SELECT * FROM records"))).not.toContain(a.settings.proxy.account!);
    // 已經有了就不再換
    expect(await ensureTrialRecord(a.db, a.root, a.settings, PROXY, proxyFetch)).toMatchObject({ wrote: false });

    const b = await device(a.root);
    await b.engine.sync();
    const [trial] = await syncedTrials(b.db, b.root, PROXY);
    expect(trial).toMatchObject({ account: a.settings.proxy.account, secret: synced!.secret });
    expect(needsTrial(b.settings) && autoRecoverable(b.settings, trial!)).toBe(true);
    const next = await recoverFromSync(b.settings, trial!, PROXY, proxyFetch);
    expect(next).toMatchObject({ llmMode: "proxy", proxy: { url: PROXY, account: a.settings.proxy.account } });
    expect(next.proxy.token).not.toBe(a.settings.proxy.token);
    expect((await fetchTrialUsage(next, proxyFetch)).account).toBe(a.settings.proxy.account);
    // 同一份每天的則數（上限 1 則）
    expect((await chat(a.settings)).status).toBe(200);
    expect((await chat(next)).status).toBe(403);
    // 裝置清單有兩台
    expect(await listTrialDevices(next, proxyFetch)).toHaveLength(2);
  });

  it("C 用自己的 API key：不自動取回，按了才取回；這台被移除過的帳號也不自動", async () => {
    const a = await deviceA();
    const c = await device(a.root, { ...defaultSettings(), apiKey: "sk-own" });
    await c.engine.sync();
    const [trial] = await syncedTrials(c.db, c.root, PROXY);
    expect(autoRecoverable(c.settings, trial!)).toBe(false);
    const manual = await recoverFromSync(c.settings, trial!, PROXY, proxyFetch);
    expect(manual.llmMode).toBe("proxy");
    // 這台自己移除過：清掉憑證後也不自動取回
    markDeclined(trial!.account);
    expect(autoRecoverable({ ...manual, proxy: { ...manual.proxy, token: "" } }, trial!)).toBe(false);
    // 有憑證（即使已經被別台移除、失效）時不自動取回
    expect(autoRecoverable({ ...defaultSettings(), llmMode: "proxy", proxy: { url: PROXY, token: "rc_dead" } }, { ...trial!, account: "acct_other" })).toBe(false);
  });

  it("代理的網址不同（staging 的資料到正式版）：不取回", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    expect(await syncedTrials(b.db, b.root, "https://other-proxy.test")).toEqual([]);
    expect(await syncedTrials(b.db, b.root, `${PROXY}/`)).toHaveLength(1);
  });

  it("A 刪除試用帳號：紀錄刪掉，別台下次同步也刪掉；代理那邊取回不了", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    const [trial] = await syncedTrials(b.db, b.root, PROXY);
    await proxyFetch(`${PROXY}/v1/account`, { method: "DELETE", headers: { "x-api-key": a.settings.proxy.token } });
    await forgetTrialRecord(a.db, a.settings.proxy.account);
    await a.engine.sync();
    await b.engine.sync();
    expect(await b.db.listTrialAccounts()).toEqual([]);
    await expect(recoverFromSync(b.settings, trial!, PROXY, proxyFetch)).rejects.toThrow("不對");
  });

  it("同步移除某台後換金鑰：留下的那台換一把新的復原密鑰，被移除的那台知道的舊的被拒；別台跟著拿到新的", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    now = new Date(now.getTime() + 25 * HOUR);
    const removed = await device(a.root);
    await removed.engine.sync();
    const [stolen] = await syncedTrials(removed.db, removed.root, PROXY);
    now = new Date(now.getTime() + 25 * HOUR);

    const before = await syncedTrials(a.db, a.root, PROXY);
    const newRoot = await a.engine.rekey([removed.identity.id]);
    expect(await rotateTrialSecrets(a.db, newRoot, a.settings, PROXY, before, proxyFetch)).toBe(1);
    await a.engine.sync();

    // 被移除的那台：舊的密鑰不能再取回
    await expect(recoverFromSync(removed.settings, stolen!, PROXY, proxyFetch)).rejects.toThrow("不對");
    // B 跟著換到新的同步金鑰，拿到新的密鑰，取回得了
    await b.engine.sync();
    const [fresh] = await syncedTrials(b.db, b.root, PROXY);
    expect(fresh!.secret).not.toBe(stolen!.secret);
    expect((await recoverFromSync(b.settings, fresh!, PROXY, proxyFetch)).proxy.token).toMatch(/^rc_/);
    // 舊的紀錄（舊的同步金鑰加密的）用新的金鑰解不開
    expect(await syncedTrials(removed.db, b.root, PROXY)).toEqual([]);
  });

  it("換金鑰的那台用自己的 API key（沒有試用的憑證）：用換之前的那一把向代理換新的", async () => {
    const a = await deviceA();
    now = new Date(now.getTime() + 25 * HOUR);
    const c = await device(a.root, { ...defaultSettings(), apiKey: "sk-own" });
    await c.engine.sync();
    const removed = await device(a.root);
    await removed.engine.sync();
    now = new Date(now.getTime() + 25 * HOUR);
    const before = await syncedTrials(c.db, c.root, PROXY);
    const newRoot = await c.engine.rekey([removed.identity.id]);
    expect(await rotateTrialSecrets(c.db, newRoot, c.settings, PROXY, before, proxyFetch)).toBe(1);
    await expect(recoverFromSync(removed.settings, before[0]!, PROXY, proxyFetch)).rejects.toThrow("不對");
    const [fresh] = await syncedTrials(c.db, newRoot, PROXY);
    expect((await recoverFromSync(defaultSettings(), fresh!, PROXY, proxyFetch)).proxy.account).toBe(a.settings.proxy.account);
  });

  it("紀錄用現在的同步金鑰解不開（換金鑰的那台還沒換新）：有憑證的那台先等，太久沒換才自己換", async () => {
    const a = await deviceA();
    const otherRoot = newRootKey();
    const start = Date.now();
    expect(await ensureTrialRecord(a.db, otherRoot, a.settings, PROXY, proxyFetch, start)).toMatchObject({ wrote: false });
    expect(await ensureTrialRecord(a.db, otherRoot, a.settings, PROXY, proxyFetch, start + STALE_MS - 1)).toMatchObject({ wrote: false });
    expect(await ensureTrialRecord(a.db, otherRoot, a.settings, PROXY, proxyFetch, start + STALE_MS + 1)).toMatchObject({ wrote: true });
    expect(await syncedTrials(a.db, otherRoot, PROXY)).toHaveLength(1);
  });

  it("沒有記得帳號的舊設定：問代理是哪個帳號", async () => {
    const s = await trialSettings();
    const a = await device(newRootKey(), { ...s, proxy: { url: s.proxy.url, token: s.proxy.token } });
    expect(await ensureTrialRecord(a.db, a.root, a.settings, PROXY, proxyFetch)).toMatchObject({ account: s.proxy.account, wrote: true });
  });

  it("舊版不認得 ta: 的紀錄（不套用也不當成刪除送出）", () => {
    expect(isKnownSyncName("ta:acct_x")).toBe(true);
    // 這一版之前的種類清單（engine 對不認得的種類不套用、不刪，見 apps/sync/test/engine.test.ts「這個版本不認得的種類」）
    const before = /^(p|r|pl|ps|ck|c|cs|m|in|w|ws|wd|af|as|mw|fw|fo):/;
    expect(before.test("ta:acct_x")).toBe(false);
  });
});
