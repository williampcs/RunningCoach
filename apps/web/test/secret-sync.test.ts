/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47）：和真的同步服務（apps/sync）與同步引擎接起來測.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { Db, isKnownSyncName, newDeviceIdentity, newRootKey, openSyncedSecret, sealSyncedSecret, SyncApi, SyncEngine, type DeviceIdentity } from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { createSyncHandler } from "../../sync/src/handler";
import { SyncStore } from "../../sync/src/store";
import {
  acceptableBaseUrl,
  adoptedStamp,
  adoptedText,
  beforeSecretRekey,
  clampStamp,
  forgetSyncedSecrets,
  keepLocalStamp,
  MAX_SKEW_MS,
  reconcileSecrets,
  setShare,
  shareEnabled,
  syncedSecrets,
  withSecret,
  type ReconcileResult,
} from "../src/secret-sync";
import {
  consentKey,
  defaultSettings,
  disableLock,
  enableLock,
  saveSettings,
  sameSecret,
  secretOf,
  secretSkipped,
  secretStamps,
  type AppSettings,
  type SecretName,
  type SecretStamp,
} from "../src/settings";

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
const NAMES: SecretName[] = ["llm", "intervals"];

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
  stamps: Partial<Record<SecretName, SecretStamp>>;
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
const later = (ms = HOUR) => (now = new Date(now.getTime() + ms));

const editStamp = (old: SecretStamp | undefined): SecretStamp => ({
  at: new Date(Math.max(now.getTime(), old ? Date.parse(old.at) + 1 : 0)).toISOString(),
  seen: old?.seen ?? null,
  edited: true,
});

/** 改 key（照 settings.ts 的 stampChanges：填了、換了算修改；變成空的不算） */
function change(d: Device, next: AppSettings) {
  for (const name of NAMES) {
    const value = secretOf(next, name);
    if (secretSkipped(next, name) || sameSecret(secretOf(d.settings, name), value)) continue;
    const old = d.stamps[name];
    if (value === null) {
      if (old) d.stamps[name] = { ...old, edited: false };
    } else d.stamps[name] = editStamp(old);
  }
  d.settings = next;
}

/** 使用者在畫面上清掉（同意帶 key 時，畫面呼叫 markUserCleared） */
function userClear(d: Device, next: AppSettings) {
  change(d, next);
  for (const name of NAMES) if (secretOf(next, name) === null && !secretSkipped(next, name)) d.stamps[name] = editStamp(d.stamps[name]);
}

/** 同步完看一次（App 的 useSecretSync 做的事）；有寫入就再同步一次送出 */
async function reconcile(d: Device, opts: { allowLocalHttp?: boolean; uploadAllowed?: boolean } = {}): Promise<ReconcileResult> {
  const result = await reconcileSecrets(d.db, d.root, d.settings, d.stamps, { now, ...opts });
  for (const name of NAMES) {
    const a = result.adopt[name];
    if (a) {
      d.settings = withSecret(d.settings, name, a.value);
      d.stamps[name] = adoptedStamp(a.remote);
    } else if (result.stamps[name]) d.stamps[name] = result.stamps[name]!;
  }
  if (result.wrote) await d.engine.sync();
  return result;
}

const nothing = { wrote: false, adopt: {}, pending: {} };

/** A：填了 API key 與 Intervals.icu、開了同步並勾了帶 key，key 已經送上去 */
async function deviceA(): Promise<Device> {
  const a = await device(newRootKey());
  change(a, { ...withKey(KEY_A), intervals: { apiKey: INTERVALS_KEY, athleteId: "i123", accessToken: "", account: null } });
  await a.engine.ensureSpace();
  await setShare(a.db, true, now);
  await a.engine.sync();
  expect((await reconcile(a)).wrote).toBe(true);
  return a;
}

/** B：加入 A 的同步、拿到 key */
async function joined(a: Device, settings?: AppSettings): Promise<Device> {
  const b = await device(a.root, settings);
  await b.engine.sync();
  await reconcile(b);
  return b;
}

describe("API key 與 Intervals.icu 的連線跟著加密的同步", () => {
  it("A 設 key → B 加入後自動有；本機的資料庫與同步服務都只有密文", async () => {
    const a = await deviceA();
    expect(JSON.stringify(await a.driver.all("SELECT * FROM synced_secrets"))).not.toContain(KEY_A);
    const traffic = syncTraffic.join("\n");
    for (const plain of [KEY_A, INTERVALS_KEY, "i123"]) expect(traffic).not.toContain(plain);

    const b = await device(a.root);
    await b.engine.sync();
    const result = await reconcile(b);
    expect(result.adopt.llm?.kind).toBe("added");
    expect(b.settings).toMatchObject({ llmMode: "byok", provider: "anthropic", apiKey: KEY_A });
    expect(b.settings.intervals).toMatchObject({ apiKey: INTERVALS_KEY, athleteId: "i123" });
    expect(adoptedText(result.adopt)).toBe("已從另一台帶入 API key；已從另一台帶入 Intervals.icu 的連線。");
    // 套用之後兩台一樣：不再來回
    expect(await reconcile(b)).toMatchObject(nothing);
    expect(await reconcile(a)).toMatchObject(nothing);
    // 資料流向的確認不帶過去（每台自己確認）
    expect(b.settings.consents).toEqual([]);
  });

  it("沒有勾（或這一版之前開的同步，沒有紀錄）：不帶", async () => {
    const a = await device(newRootKey(), withKey(KEY_A));
    await a.engine.ensureSpace();
    await a.engine.sync();
    expect(await shareEnabled(a.db)).toBe(false);
    expect(await reconcile(a)).toMatchObject(nothing);
    expect(await a.db.listSyncedSecrets()).toEqual([]);
  });

  it("B 改 key（同一個 AI 服務）→ A 跟著換並看到提示；之後 A 再改又換回 B", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    change(b, { ...b.settings, apiKey: KEY_B });
    expect((await reconcile(b)).wrote).toBe(true);
    await a.engine.sync();
    const result = await reconcile(a);
    expect(result.adopt.llm?.kind).toBe("replaced");
    expect(result.adopt.intervals).toBeUndefined();
    expect(a.settings.apiKey).toBe(KEY_B);
    expect(adoptedText(result.adopt)).toBe("API key 已經更新成另一台設定的。");

    later();
    change(a, { ...a.settings, apiKey: KEY_A });
    await reconcile(a);
    await b.engine.sync();
    await reconcile(b);
    expect(b.settings.apiKey).toBe(KEY_A);
  });

  it("換了 AI 服務或服務網址：不默默換，問使用者；同意綁在服務網址上", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    const compatible: AppSettings = { ...b.settings, provider: "openai-compatible", apiKey: KEY_B, baseURL: "https://llm.example.com/v1" };
    change(b, compatible);
    await reconcile(b);
    await a.engine.sync();
    const result = await reconcile(a);
    expect(result.adopt.llm).toBeUndefined();
    expect(result.pending.llm).toMatchObject({ reason: "recipient", recipient: "https://llm.example.com/v1" });
    expect(a.settings.apiKey).toBe(KEY_A);
    // 改用另一台的：同意要重新確認（綁在網址上）
    const accepted = withSecret({ ...a.settings, consents: [consentKey(a.settings)] }, "llm", result.pending.llm!.value);
    expect(accepted.consents).not.toContain(consentKey(accepted));
    expect(consentKey(accepted)).toBe("byok:openai-compatible:https://llm.example.com/v1");
    expect(consentKey({ ...accepted, baseURL: "https://other.example.com/v1" })).not.toBe(consentKey(accepted));
  });

  it("兩台都改了、還沒同步：這台的修改不會被默默蓋掉；選保留的那台送出、另一台跟著換", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    change(b, { ...b.settings, apiKey: KEY_B });
    later();
    change(a, { ...a.settings, apiKey: "fake-key-a-later" });
    await reconcile(b);
    await a.engine.sync();
    // A 改得比較晚：送 A 的
    await reconcile(a);
    await b.engine.sync();
    const onB = await reconcile(b);
    // B 自己的已經送出去了（不是還沒送的修改）：照最後改的換
    expect(onB.adopt.llm?.kind).toBe("replaced");
    expect(b.settings.apiKey).toBe("fake-key-a-later");

    // 反過來：B 先改、晚改的 A 先送上去，B 還沒送：B 被問，不會默默丟掉 B 的
    later();
    change(b, { ...b.settings, apiKey: "fake-key-b-early" });
    later();
    change(a, { ...a.settings, apiKey: "fake-key-a-latest" });
    await reconcile(a);
    await b.engine.sync();
    const asked = await reconcile(b);
    expect(asked.pending.llm?.reason).toBe("both-changed");
    expect(b.settings.apiKey).toBe("fake-key-b-early");
    // 保留這台的：送出，A 跟著換
    b.stamps.llm = keepLocalStamp(asked.pending.llm!.remote, now);
    await reconcile(b);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe("fake-key-b-early");
  });

  it("這個功能之前就填好的（兩台都有 key、不知道誰改的）：不蓋掉這台的供應商與 key，問使用者", async () => {
    const a = await device(newRootKey(), withKey(KEY_A));
    await a.engine.ensureSpace();
    await setShare(a.db, true, now);
    await a.engine.sync();
    await reconcile(a);
    const own: AppSettings = { ...defaultSettings(), provider: "openai-compatible", apiKey: KEY_B, baseURL: "https://mine.example.com/v1" };
    const b = await device(a.root, own);
    await b.engine.sync();
    const result = await reconcile(b);
    expect(result.pending.llm?.reason).toBe("unknown");
    expect(b.settings).toMatchObject({ provider: "openai-compatible", apiKey: KEY_B, baseURL: "https://mine.example.com/v1" });
  });

  it("遠未來的時間：比較時最多算到現在＋幾分鐘，這台之後的修改照樣送出、換金鑰時不原樣帶過去", async () => {
    const a = await deviceA();
    const b = await joined(a);
    // A 的時鐘亂了：寫了一筆 2100 年的
    later();
    const far = "2100-01-01T00:00:00.000Z";
    await a.db.saveSyncedSecret({ name: "llm", box: await sealSyncedSecret(a.root, "llm", JSON.stringify(secretOf(withKey("fake-key-future"), "llm"))), updated_at: far });
    await a.engine.sync();
    await b.engine.sync();
    const remote = (await syncedSecrets(b.db, b.root, now)).llm!;
    expect(remote.raw).toBe(far);
    expect(Date.parse(remote.at)).toBe(now.getTime() + MAX_SKEW_MS);
    await reconcile(b);
    expect(b.settings.apiKey).toBe("fake-key-future");
    // B 之後改：照樣送出（雲端在那之後沒變）
    later(60_000);
    change(b, { ...b.settings, apiKey: KEY_B });
    expect((await reconcile(b)).wrote).toBe(true);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe(KEY_B);
    // 換金鑰時：時間照比較用的
    await a.db.saveSyncedSecret({ name: "llm", box: await sealSyncedSecret(a.root, "llm", JSON.stringify(secretOf(a.settings, "llm"))), updated_at: far });
    const reseal = await beforeSecretRekey(a.db, a.root, now);
    const newRoot = newRootKey();
    await reseal(newRoot);
    expect((await a.db.listSyncedSecrets()).find((r) => r.name === "llm")!.updated_at).toBe(clampStamp(far, now));
    expect(clampStamp("not a date", now)).toBe("1970-01-01T00:00:00.000Z");
  });

  it("使用者在畫面上清掉 key、中斷 Intervals.icu：存一筆「已清除」，別台跟著清，不會再被帶回來", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    userClear(a, { ...a.settings, apiKey: "", intervals: { apiKey: "", athleteId: "i123", accessToken: "", account: null } });
    expect((await reconcile(a)).wrote).toBe(true);
    expect(JSON.stringify(await syncedSecrets(a.db, a.root, now))).toContain("cleared");
    // A 下一輪不會又被帶回來
    expect(await reconcile(a)).toMatchObject(nothing);
    expect(a.settings.apiKey).toBe("");
    await b.engine.sync();
    const result = await reconcile(b);
    expect(result.adopt.llm?.kind).toBe("cleared");
    expect(b.settings.apiKey).toBe("");
    expect(b.settings.intervals.apiKey).toBe("");
    expect(adoptedText(result.adopt)).toContain("另一台清掉了 API key，這台也清掉了");
    // 之後 B 再填：照樣帶過去
    later();
    change(b, { ...b.settings, apiKey: KEY_B });
    await reconcile(b);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe(KEY_B);
  });

  it("帶進來的服務網址要 https；只有在本機開發時 localhost 可以用 http", async () => {
    expect(acceptableBaseUrl("https://llm.example.com/v1", false)).toBe(true);
    expect(acceptableBaseUrl("http://llm.example.com/v1", true)).toBe(false);
    expect(acceptableBaseUrl("http://127.0.0.1:8788/v1", false)).toBe(false);
    expect(acceptableBaseUrl("http://127.0.0.1:8788/v1", true)).toBe(true);
    expect(acceptableBaseUrl("https://user:pw@llm.example.com", false)).toBe(false);

    const a = await device(newRootKey(), { ...defaultSettings(), provider: "openai-compatible", apiKey: KEY_A, baseURL: "http://evil.example.com/v1" });
    a.stamps.llm = { at: now.toISOString(), seen: null, edited: true };
    await a.engine.ensureSpace();
    await setShare(a.db, true, now);
    await a.engine.sync();
    await reconcile(a);
    const b = await device(a.root);
    await b.engine.sync();
    expect((await syncedSecrets(b.db, b.root, now)).llm).toBeUndefined();
    await reconcile(b);
    expect(b.settings.apiKey).toBe("");
  });

  it("取消勾選：雲端那筆刪掉，B 不再收到、也不會再送上去；B 留著自己的", async () => {
    const a = await deviceA();
    const b = await joined(a);
    expect(await shareEnabled(b.db)).toBe(true);

    await setShare(a.db, false, now);
    await a.engine.sync();
    await b.engine.sync();
    expect(await shareEnabled(b.db)).toBe(false);
    expect(await syncedSecrets(b.db, b.root, now)).toEqual({});
    expect(b.settings.apiKey).toBe(KEY_A);

    later();
    change(b, { ...b.settings, apiKey: KEY_B });
    expect(await reconcile(b)).toMatchObject(nothing);
    await a.engine.sync();
    expect(await syncedSecrets(a.db, a.root, now)).toEqual({});
    expect(a.settings.apiKey).toBe(KEY_A);

    // 再勾回來：重新帶
    later();
    await setShare(b.db, true, now);
    await reconcile(b);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe(KEY_B);
  });

  it("免費試用的憑證不放進同步；這台用著免費試用時不送也不拿別台的 API key", async () => {
    const trial: AppSettings = { ...defaultSettings(), llmMode: "proxy", proxy: { url: "https://proxy.test", token: "fake-trial-token", account: "acct_1" } };
    expect(secretOf(trial, "llm")).toBeNull();
    const a = await deviceA();
    const t = await device(a.root, trial);
    await t.engine.sync();
    const result = await reconcile(t);
    expect(result.adopt.llm).toBeUndefined();
    expect(result.pending.llm).toBeUndefined();
    expect(t.settings.llmMode).toBe("proxy");
    expect(syncTraffic.join("\n")).not.toContain("fake-trial-token");
    // Intervals.icu 的連線照樣帶過來
    expect(result.adopt.intervals).toBeDefined();
    // 換成免費試用不算清掉 key
    change(a, { ...a.settings, llmMode: "proxy" });
    expect(a.stamps.llm?.edited).toBe(false);
  });

  it("Intervals.icu 用登入的 token：一樣帶過去", async () => {
    const a = await device(newRootKey());
    change(a, { ...defaultSettings(), intervals: { apiKey: "", athleteId: "", accessToken: TOKEN, account: { id: "i9", name: "跑者" } } });
    await a.engine.ensureSpace();
    await setShare(a.db, true, now);
    await a.engine.sync();
    await reconcile(a);
    expect(syncTraffic.join("\n")).not.toContain(TOKEN);
    const b = await joined(a);
    expect(b.settings.intervals).toEqual({ apiKey: "", athleteId: "", accessToken: TOKEN, account: { id: "i9", name: "跑者" } });
  });

  it("換金鑰（移除某台）：用新的金鑰重新加密，留下的那台跟著拿到；舊的金鑰解不開", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later(25 * HOUR);
    const removed = await joined(a);
    const oldRoot = Uint8Array.from(a.root);
    later(25 * HOUR);

    const reseal = await beforeSecretRekey(a.db, a.root, now);
    const newRoot = await a.engine.rekey([removed.identity.id]);
    expect(await reseal(newRoot)).toBe(2);
    await a.engine.sync();
    expect(await syncedSecrets(a.db, oldRoot, now)).toEqual({});

    await b.engine.sync();
    expect(Buffer.from(b.root).equals(Buffer.from(newRoot))).toBe(true);
    expect((await syncedSecrets(b.db, b.root, now)).llm?.value).toMatchObject({ apiKey: KEY_A });
    expect(await reconcile(b)).toMatchObject(nothing);

    // 被移除的那台：App 清掉 key 與同步金鑰，資料庫裡的密文也刪掉
    await forgetSyncedSecrets(removed.db);
    expect((await removed.db.listSyncedSecrets()).map((r) => r.name)).toEqual(["share"]);
  });

  it("解不開、被改過、名稱對不上、形狀不對的：不用", async () => {
    const root = newRootKey();
    const box = await sealSyncedSecret(root, "llm", "{}");
    expect(await openSyncedSecret(root, "llm", box)).toBe("{}");
    expect(await openSyncedSecret(newRootKey(), "llm", box)).toBeNull();
    expect(await openSyncedSecret(root, "intervals", box)).toBeNull();
    expect(await openSyncedSecret(root, "llm", `${box.slice(0, -2)}AA`)).toBeNull();

    const d = await device(root, withKey(KEY_A));
    await setShare(d.db, true, now);
    await d.db.saveSyncedSecret({ name: "llm", box: await sealSyncedSecret(root, "llm", JSON.stringify({ provider: "nope", apiKey: 1 })), updated_at: now.toISOString() });
    expect(await syncedSecrets(d.db, root, now)).toEqual({});
    expect((await reconcileSecrets(d.db, root, d.settings, {}, { now })).wrote).toBe(true);
    expect((await syncedSecrets(d.db, root, now)).llm?.value).toMatchObject({ apiKey: KEY_A });
  });

  it("存設定時記下改的時間；密碼鎖開著時一樣（key 用這台的密碼加密後才存）", async () => {
    await saveSettings(withKey(KEY_A));
    const first = secretStamps().llm!;
    expect(first.edited).toBe(true);
    expect(secretStamps().intervals).toBeUndefined();
    await new Promise((r) => setTimeout(r, 5));
    await saveSettings({ ...withKey(KEY_A), timeZone: "Asia/Tokyo" });
    expect(secretStamps().llm).toEqual(first);

    await enableLock("correct horse battery", withKey(KEY_A));
    await saveSettings(withKey(KEY_B));
    expect(secretStamps().llm!.at > first.at).toBe(true);
    const store = localStorage as unknown as MemoryStorage;
    const stored = [...Array(store.length).keys()].map((i) => localStorage.getItem(store.key(i)!)).join("\n");
    expect(stored).not.toContain(KEY_B);
    expect(stored).not.toContain(KEY_A);
    disableLock(withKey(KEY_B));
  });

  it("舊版不認得 sk: 的紀錄；這一版只認得 llm、intervals、share", () => {
    expect(isKnownSyncName("sk:llm")).toBe(true);
    expect(isKnownSyncName("sk:share")).toBe(true);
    expect(isKnownSyncName("sk:anything-else")).toBe(false);
    // 這一版之前的種類清單（engine 對不認得的種類不套用、不刪，見 apps/sync/test/engine.test.ts「這個版本不認得的種類」）
    const before = /^(p|r|pl|ps|ck|c|cs|m|in|w|ws|wd|af|as|mw|fw|fo|ta):/;
    expect(before.test("sk:llm")).toBe(false);
  });

  it("App 自己清掉的（被移除、忘記密碼）不算修改：被移除的那台重新加入後，別台的 key 還在", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    // 被移除：清掉 key（存設定），再清掉這台的同步狀態（App.tsx 的 onRemoved）
    change(b, { ...b.settings, apiKey: "", intervals: { apiKey: "", athleteId: "", accessToken: "", account: null } });
    expect(b.stamps.llm?.edited).toBe(false);
    b.stamps = {};
    // 重新加入：沒有送「已清除」，反而拿回 A 的
    const again = await device(a.root, b.settings);
    again.stamps = b.stamps;
    await again.engine.sync();
    const result = await reconcile(again);
    expect(result.wrote).toBe(false);
    expect(again.settings.apiKey).toBe(KEY_A);
    await a.engine.sync();
    expect(await reconcile(a)).toMatchObject(nothing);
    expect(a.settings.apiKey).toBe(KEY_A);
    expect(a.settings.intervals.apiKey).toBe(INTERVALS_KEY);

    // 就算狀態沒清掉（只靠「變成空的不算修改」）也一樣
    const c = await joined(a);
    later();
    change(c, { ...c.settings, apiKey: "" });
    expect((await reconcile(c)).wrote).toBe(false);
    expect(c.settings.apiKey).toBe(KEY_A);
  });

  it("存設定時變成空的不算修改（真的 saveSettings）", async () => {
    await saveSettings(withKey(KEY_A));
    expect(secretStamps().llm?.edited).toBe(true);
    await saveSettings(withKey(""));
    expect(secretStamps().llm?.edited).toBe(false);
  });

  it("這台還沒同意帶上去：拿得到別台的，這台的不送", async () => {
    const a = await deviceA();
    const b = await device(a.root);
    await b.engine.sync();
    const got = await reconcile(b, { uploadAllowed: false });
    expect(got.adopt.llm?.kind).toBe("added");
    later();
    change(b, { ...b.settings, apiKey: KEY_B });
    expect((await reconcile(b, { uploadAllowed: false })).wrote).toBe(false);
    await a.engine.sync();
    expect(await reconcile(a)).toMatchObject(nothing);
    expect(a.settings.apiKey).toBe(KEY_A);
    // 同意之後才送
    expect((await reconcile(b, { uploadAllowed: true })).wrote).toBe(true);
    await a.engine.sync();
    await reconcile(a);
    expect(a.settings.apiKey).toBe(KEY_B);
  });

  it("這台改過、還沒送出，另一台後來清掉了：問使用者，不默默清掉這台的", async () => {
    const a = await deviceA();
    const b = await joined(a);
    later();
    // A 離線時填了新的 key（還沒送）
    change(a, { ...a.settings, apiKey: "fake-key-a-offline" });
    later();
    userClear(b, { ...b.settings, apiKey: "" });
    await reconcile(b);
    await a.engine.sync();
    const result = await reconcileSecrets(a.db, a.root, a.settings, a.stamps, { now });
    expect(result.adopt.llm).toBeUndefined();
    expect(result.pending.llm).toMatchObject({ reason: "both-changed", value: { cleared: true } });
    expect(a.settings.apiKey).toBe("fake-key-a-offline");

    // 反過來：這台清掉了（使用者）、還沒送，另一台後來填了新的：也問
    const c = await joined(a);
    later();
    userClear(c, { ...c.settings, apiKey: "" });
    later();
    change(a, { ...a.settings, apiKey: "fake-key-a-new" });
    a.stamps.llm = editStamp(a.stamps.llm);
    await reconcileSecrets(a.db, a.root, a.settings, a.stamps, { now }).then(async (r) => r.wrote && a.engine.sync());
    await c.engine.sync();
    const asked = await reconcileSecrets(c.db, c.root, c.settings, c.stamps, { now });
    expect(asked.pending.llm?.reason).toBe("both-changed");
    expect(c.settings.apiKey).toBe("");
  });

  it("不認得的 sk: 名稱：不存進資料庫", async () => {
    const a = await device(newRootKey());
    await a.engine.ensureSpace();
    await a.db.saveSyncedSecret({ name: "bogus", box: "x", updated_at: now.toISOString() });
    await a.engine.sync();
    const b = await device(a.root);
    await b.engine.sync();
    expect(await b.db.listSyncedSecrets()).toEqual([]);
  });
});
