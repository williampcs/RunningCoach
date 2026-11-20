/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47）：和真的同步服務（apps/sync）與同步引擎接起來測.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, isKnownSyncName, newDeviceIdentity, newRootKey, openSyncedSecret, sealSyncedSecret, SyncApi, SyncEngine, type DeviceIdentity } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createSyncHandler } from "../../sync/src/handler";
import { SyncStore } from "../../sync/src/store";
import { adoptedText, beforeSecretRekey, forgetSyncedSecrets, reconcileSecrets, setShare, shareEnabled, syncedSecrets, UNKNOWN_STAMP, withSecret } from "../src/secret-sync";
import { defaultSettings, disableLock, enableLock, saveSettings, secretOf, secretStamps, type AppSettings, type SecretName } from "../src/settings";

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
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
}

const HOUR = 3600_000;
const KEY_A = "fake-key-device-a";
const KEY_B = "fake-key-device-b";
const INTERVALS_KEY = "fake-intervals-key";
const TOKEN = "fake-intervals-token";

let now: Date;
let syncDriver: NodeSqliteDriver;
let api: SyncApi;
/** 同步服務收到與送出的內容（檢查有沒有明文的 key） */
let syncTraffic: string[];

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  now = new Date("2026-11-20T04:00:00Z");
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
  stamps: Partial<Record<SecretName, string>>;
}

async function device(root: Uint8Array, settings: AppSettings = defaultSettings()): Promise<Device> {
  const driver = openNodeSqlite(":memory:");
  const db = new Db(driver, { now: () => now, today: () => now.toISOString().slice(0, 10) });
  await db.init();
  const d = { db, driver, root: Uint8Array.from(root), identity: await newDeviceIdentity(), settings, stamps: {} } as Device;
  d.engine = new SyncEngine(db, api, d.root, () => now, {
    identity: d.identity,
    label: () => ({ name: "test", platform: "test" }),
    onRootChanged: async (next) => {
      d.root = next;
    },
  });
  return d;
}

const withKey = (apiKey: string): AppSettings => ({ ...defaultSettings(), apiKey });

/** 改 key（記下這台改的時間） */
function change(d: Device, next: AppSettings) {
  for (const name of ["llm", "intervals"] as const) {
    if (JSON.stringify(secretOf(d.settings, name)) !== JSON.stringify(secretOf(next, name))) d.stamps[name] = now.toISOString();
  }
  d.settings = next;
}

/** 同步完看一次（App 的 useSecretSync 做的事）；有寫入就再同步一次送出 */
async function reconcile(d: Device) {
  const { wrote, adopt } = await reconcileSecrets(d.db, d.root, d.settings, d.stamps);
  for (const [name, item] of Object.entries(adopt) as [SecretName, NonNullable<(typeof adopt)[SecretName]>][]) {
    d.settings = withSecret(d.settings, name, item.value);
    d.stamps[name] = item.at;
  }
  if (wrote) await d.engine.sync();
  return { wrote, adopt };
}

/** A：填了 API key 與 Intervals.icu、開了同步，key 已經送上去 */
async function deviceA(): Promise<Device> {
  const a = await device(newRootKey());
  change(a, { ...withKey(KEY_A), intervals: { apiKey: INTERVALS_KEY, athleteId: "i123", accessToken: "", account: null } });
  await a.engine.ensureSpace();
  await a.engine.sync();
  expect((await reconcile(a)).wrote).toBe(true);
  return a;
}

describe("API key 與 Intervals.icu 的連線跟著加密的同步", () => {
  it("A 設 key → B 加入後自動有；本機的資料庫與同步服務都只有密文", async () => {
    const a = await deviceA();
    expect(JSON.stringify(await a.driver.all("SELECT * FROM synced_secrets"))).not.toContain(KEY_A);
    const traffic = syncTraffic.join("\n");
    for (const plain of [KEY_A, INTERVALS_KEY, "i123"]) expect(traffic).not.toContain(plain);
    expect(JSON.stringify(await syncDriver.all("SELECT * FROM records"))).not.toContain(KEY_A);

    const b = await device(a.root);
    await b.engine.sync();
    const { adopt } = await reconcile(b);
    expect(adopt.llm).toMatchObject({ replaced: false });
    expect(b.settings).toMatchObject({ llmMode: "byok", provider: "anthropic", apiKey: KEY_A });
    expect(b.settings.intervals).toMatchObject({ apiKey: INTERVALS_KEY, athleteId: "i123" });
    expect(adoptedText(adopt)).toBe("已從另一台帶入 API key；已從另一台帶入 Intervals.icu 的連線。");
    // 套用之後兩台一樣：不再來回
    expect(await reconcile(b)).toEqual({ wrote: false, adopt: {} });
    expect(await reconcile(a)).toEqual({ wrote: false, adopt: {} });
    // 資料流向的確認不帶過去（每台自己確認）
    expect(b.settings.consents).toEqual([]);
  });

  it("B 改 key → A 跟著換並看到提示；之後 A 再改又換回 B", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    await reconcile(b);

    now = new Date(now.getTime() + HOUR);
    change(b, { ...b.settings, apiKey: KEY_B });
    expect((await reconcile(b)).wrote).toBe(true);
    await a.engine.sync();
    const { adopt } = await reconcile(a);
    expect(adopt.llm).toMatchObject({ replaced: true });
    expect(adopt.intervals).toBeUndefined();
    expect(a.settings.apiKey).toBe(KEY_B);
    expect(adoptedText(adopt)).toBe("API key 已經更新成另一台設定的。");

    now = new Date(now.getTime() + HOUR);
    change(a, { ...a.settings, apiKey: KEY_A });
    await reconcile(a);
    await b.engine.sync();
    await reconcile(b);
    expect(b.settings.apiKey).toBe(KEY_A);
  });

  it("兩台都改了、還沒同步：最後改的為準", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    await reconcile(b);

    now = new Date(now.getTime() + HOUR);
    change(b, { ...b.settings, apiKey: KEY_B });
    now = new Date(now.getTime() + HOUR);
    change(a, { ...a.settings, apiKey: "fake-key-a-later" });
    // 先改的 B 先送上去，晚改的 A 後送：A 的贏
    await reconcile(b);
    await a.engine.sync();
    await reconcile(a);
    await b.engine.sync();
    await reconcile(b);
    expect(b.settings.apiKey).toBe("fake-key-a-later");
    expect(a.settings.apiKey).toBe("fake-key-a-later");

    // 反過來：晚改的先送上去，先改的那台同步後拿到晚改的（引擎比時間，不會被舊的蓋掉）
    now = new Date(now.getTime() + HOUR);
    change(a, { ...a.settings, apiKey: "fake-key-a-earlier" });
    now = new Date(now.getTime() + HOUR);
    change(b, { ...b.settings, apiKey: "fake-key-b-latest" });
    await reconcile(b);
    await reconcileSecrets(a.db, a.root, a.settings, a.stamps);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe("fake-key-b-latest");
  });

  it("這個功能之前就填好的（兩台都有 key、不知道誰改的）：後加入的那台用雲端已經有的", async () => {
    const a = await device(newRootKey(), withKey(KEY_A));
    await a.engine.ensureSpace();
    await a.engine.sync();
    await reconcile(a);
    expect((await syncedSecrets(a.db, a.root)).llm?.at).toBe(UNKNOWN_STAMP);
    const b = await device(a.root, withKey(KEY_B));
    await b.engine.sync();
    const { adopt } = await reconcile(b);
    expect(adopt.llm?.replaced).toBe(true);
    expect(b.settings.apiKey).toBe(KEY_A);
  });

  it("取消勾選：雲端那筆刪掉，B 不再收到、也不會再送上去；B 留著自己的", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    await reconcile(b);
    expect(await shareEnabled(b.db)).toBe(true);

    await setShare(a.db, false, now);
    await a.engine.sync();
    await b.engine.sync();
    expect(await shareEnabled(b.db)).toBe(false);
    expect(await syncedSecrets(b.db, b.root)).toEqual({});
    expect(b.settings.apiKey).toBe(KEY_A);

    now = new Date(now.getTime() + HOUR);
    change(b, { ...b.settings, apiKey: KEY_B });
    expect(await reconcile(b)).toEqual({ wrote: false, adopt: {} });
    await a.engine.sync();
    expect(await syncedSecrets(a.db, a.root)).toEqual({});
    expect(a.settings.apiKey).toBe(KEY_A);

    // B 在取消之前（還沒同步到）就送了一筆：同步到 off 之後刪掉
    await b.db.saveSyncedSecret({ name: "llm", box: await sealSyncedSecret(b.root, "llm", JSON.stringify(secretOf(b.settings, "llm"))), updated_at: now.toISOString() });
    expect((await reconcile(b)).wrote).toBe(true);
    expect(await b.db.listSyncedSecrets()).toEqual([expect.objectContaining({ name: "share", box: "off" })]);

    // 再勾回來：重新帶
    now = new Date(now.getTime() + HOUR);
    await setShare(b.db, true, now);
    await reconcile(b);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe(KEY_B);
  });

  it("免費試用的憑證不放進同步；這台用著免費試用時不拿別台的 API key 蓋掉", async () => {
    const trial: AppSettings = { ...defaultSettings(), llmMode: "proxy", proxy: { url: "https://proxy.test", token: "fake-trial-token", account: "acct_1" } };
    expect(secretOf(trial, "llm")).toBeNull();
    const t = await device(newRootKey(), trial);
    await t.engine.ensureSpace();
    await t.engine.sync();
    expect(await reconcile(t)).toEqual({ wrote: false, adopt: {} });
    expect(syncTraffic.join("\n")).not.toContain("fake-trial-token");

    const a = await deviceA();
    const t2 = await device(a.root, trial);
    await t2.engine.sync();
    const { adopt } = await reconcile(t2);
    expect(adopt.llm).toBeUndefined();
    expect(t2.settings.llmMode).toBe("proxy");
    expect(t2.settings.proxy.token).toBe("fake-trial-token");
    // Intervals.icu 的連線照樣帶過來
    expect(adopt.intervals).toBeDefined();
  });

  it("Intervals.icu 用登入的 token：一樣帶過去", async () => {
    const a = await device(newRootKey());
    change(a, { ...defaultSettings(), intervals: { apiKey: "", athleteId: "", accessToken: TOKEN, account: { id: "i9", name: "跑者" } } });
    await a.engine.ensureSpace();
    await a.engine.sync();
    await reconcile(a);
    expect(syncTraffic.join("\n")).not.toContain(TOKEN);
    const b = await device(a.root);
    await b.engine.sync();
    await reconcile(b);
    expect(b.settings.intervals).toEqual({ apiKey: "", athleteId: "", accessToken: TOKEN, account: { id: "i9", name: "跑者" } });
  });

  it("換金鑰（移除某台）：換金鑰的那台用新的金鑰重新加密，留下的那台跟著拿到；舊的金鑰解不開", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    await reconcile(b);
    now = new Date(now.getTime() + 25 * HOUR);
    const removed = await device(a.root);
    await removed.engine.sync();
    await reconcile(removed);
    const oldRoot = Uint8Array.from(a.root);
    now = new Date(now.getTime() + 25 * HOUR);

    const reseal = await beforeSecretRekey(a.db, a.root);
    const newRoot = await a.engine.rekey([removed.identity.id]);
    expect(await reseal(newRoot)).toBe(2);
    await a.engine.sync();
    const at = (await syncedSecrets(a.db, newRoot)).llm?.at;
    expect(at).toBe(a.stamps.llm);
    expect(await syncedSecrets(a.db, oldRoot)).toEqual({});

    await b.engine.sync();
    expect(Buffer.from(b.root).equals(Buffer.from(newRoot))).toBe(true);
    expect((await syncedSecrets(b.db, b.root)).llm?.value).toMatchObject({ apiKey: KEY_A });
    expect(await reconcile(b)).toEqual({ wrote: false, adopt: {} });

    // 被移除的那台：App 清掉 key 與同步金鑰，資料庫裡的密文也刪掉
    await forgetSyncedSecrets(removed.db);
    expect(await removed.db.listSyncedSecrets()).toEqual([]);
  });

  it("解不開、被改過、或名稱對不上的：不用", async () => {
    const root = newRootKey();
    const box = await sealSyncedSecret(root, "llm", "{}");
    expect(await openSyncedSecret(root, "llm", box)).toBe("{}");
    expect(await openSyncedSecret(newRootKey(), "llm", box)).toBeNull();
    expect(await openSyncedSecret(root, "intervals", box)).toBeNull();
    expect(await openSyncedSecret(root, "llm", `${box.slice(0, -2)}AA`)).toBeNull();

    // 形狀不對（別的版本、壞掉的）：當成沒有，這台有的就存上去
    const d = await device(root, withKey(KEY_A));
    await d.db.saveSyncedSecret({ name: "llm", box: await sealSyncedSecret(root, "llm", JSON.stringify({ provider: "nope", apiKey: 1 })), updated_at: now.toISOString() });
    expect(await syncedSecrets(d.db, root)).toEqual({});
    expect((await reconcileSecrets(d.db, root, d.settings, {})).wrote).toBe(true);
    expect((await syncedSecrets(d.db, root)).llm?.value).toMatchObject({ apiKey: KEY_A });
  });

  it("存設定時記下改的時間；密碼鎖開著時一樣（key 用這台的密碼加密後才存）", async () => {
    await saveSettings(withKey(KEY_A));
    const first = secretStamps().llm;
    expect(first).toBeDefined();
    expect(secretStamps().intervals).toBeUndefined();
    // 沒改 key 的存檔不動時間
    await new Promise((r) => setTimeout(r, 5));
    await saveSettings({ ...withKey(KEY_A), timeZone: "Asia/Tokyo" });
    expect(secretStamps().llm).toBe(first);

    await enableLock("correct horse battery", withKey(KEY_A));
    await saveSettings(withKey(KEY_B));
    expect(secretStamps().llm! > first!).toBe(true);
    const stored = [...Array((localStorage as unknown as MemoryStorage).length).keys()].map((i) => localStorage.getItem((localStorage as unknown as MemoryStorage).key(i)!)).join("\n");
    expect(stored).not.toContain(KEY_B);
    expect(stored).not.toContain(KEY_A);
    disableLock(withKey(KEY_B));
  });

  it("舊版不認得 sk: 的紀錄（不套用也不當成刪除送出）", () => {
    expect(isKnownSyncName("sk:llm")).toBe(true);
    // 這一版之前的種類清單（engine 對不認得的種類不套用、不刪，見 apps/sync/test/engine.test.ts「這個版本不認得的種類」）
    const before = /^(p|r|pl|ps|ck|c|cs|m|in|w|ws|wd|af|as|mw|fw|fo|ta):/;
    expect(before.test("sk:llm")).toBe(false);
  });
});
