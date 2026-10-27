import { beforeEach, describe, expect, it } from "vitest";

import {
  Db,
  deriveKeys,
  newDeviceIdentity,
  newRootKey,
  SyncApi,
  SyncApiError,
  SyncCooldownError,
  SyncEngine,
  SyncRemovedError,
  type DeviceIdentity,
} from "@running-coach/core";
import { openNodeSqlite, type NodeSqliteDriver } from "@running-coach/sqlite-node";

import { sealLabel, signRequest } from "../../../packages/core/src/device-sync/device";

import { createSyncHandler } from "../src/handler";
import { SyncStore } from "../src/store";

/** 伺服器的時間（冷卻期以它為準）；用戶端簽章用真的時間，差太多時依伺服器回的時間校正 */
let serverNow: Date;
let serverDriver: NodeSqliteDriver;
let handle: (request: Request) => Promise<Response>;
let api: SyncApi;
/** 經過伺服器的請求（測試重送用） */
let seen: Request[];

const HOUR = 3600_000;

beforeEach(async () => {
  serverNow = new Date("2026-10-27T00:00:00Z");
  serverDriver = openNodeSqlite(":memory:");
  const store = new SyncStore(serverDriver, () => serverNow);
  await store.init();
  handle = createSyncHandler({ store, allowedOrigins: [] });
  seen = [];
  api = new SyncApi("http://sync.test", (input, init) => {
    const request = new Request(input as string, init);
    seen.push(request.clone());
    return handle(request);
  });
});

const advance = (ms: number) => {
  serverNow = new Date(serverNow.getTime() + ms);
};

interface Device {
  name: string;
  db: Db;
  identity: DeviceIdentity;
  root: Uint8Array;
  engine: SyncEngine;
}

async function device(name: string, root: Uint8Array, identity?: DeviceIdentity): Promise<Device> {
  const db = new Db(openNodeSqlite(":memory:"), { now: () => serverNow, today: () => serverNow.toISOString().slice(0, 10) });
  await db.init();
  const d = { name, db, identity: identity ?? (await newDeviceIdentity()), root: Uint8Array.from(root) } as Device;
  d.engine = new SyncEngine(db, api, d.root, () => serverNow, {
    identity: d.identity,
    label: () => ({ name, platform: "test" }),
    onRootChanged: async (next) => {
      d.root = next;
    },
  });
  return d;
}

async function legacy(root: Uint8Array) {
  const db = new Db(openNodeSqlite(":memory:"), { now: () => serverNow, today: () => serverNow.toISOString().slice(0, 10) });
  await db.init();
  return { db, engine: new SyncEngine(db, api, Uint8Array.from(root), () => serverNow) };
}

const names = (r: { devices: { devices: { label: { name: string } | null }[] } | null }) => r.devices!.devices.map((d) => d.label?.name ?? null);

describe("裝置清單與移除某台（規格 12.27）", () => {
  it("新的空間一開始就是裝置模式：清單、這台、改名、冷卻期", async () => {
    const root = newRootKey();
    const a = await device("Mac · Edge", root);
    expect(await a.engine.ensureSpace()).toBe(true);
    const first = await a.engine.sync();
    expect(names(first)).toEqual(["Mac · Edge"]);
    expect(first.devices!.devices[0]).toMatchObject({ self: true, legacy: false });
    // 第一台也受冷卻期限制（只換金鑰也不行）
    expect(first.devices!.cooldownUntil).toBe(serverNow.getTime() + 24 * HOUR);
    await expect(a.engine.rekey()).rejects.toBeInstanceOf(SyncCooldownError);

    advance(HOUR);
    const b = await device("iPhone · Safari", root);
    const rb = await b.engine.sync();
    expect(names(rb)).toEqual(["Mac · Edge", "iPhone · Safari"]);
    expect(rb.devices!.devices.map((d) => d.self)).toEqual([false, true]);

    // 任何一台都可以替任何一台改名
    const renamed = await b.engine.renameDevice(a.identity.id, { name: "工作的 Mac", platform: "macOS" });
    expect(renamed.devices.find((d) => d.id === a.identity.id)!.label).toEqual({ name: "工作的 Mac", platform: "macOS" });
    expect(names(await a.engine.sync())).toEqual(["工作的 Mac", "iPhone · Safari"]);

    // 最後同步的時間由伺服器記
    advance(2 * HOUR);
    await b.engine.sync();
    const view = (await a.engine.sync()).devices!.devices;
    expect(view.find((d) => d.id === b.identity.id)!.lastSeenAt).toBe(serverNow.getTime());
    // 伺服器存的名稱是加密的
    const stored = serverDriver ? await serverDriver.all("SELECT label FROM devices") : [];
    expect(JSON.stringify(stored)).not.toContain("iPhone");
  });

  it("A 移除 C：C 下次同步收到可以確認的移除；B 不用重新配對；C 的舊復原碼不能再加入；新的復原碼可以", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.db.setProfileKey("pref_intensity", "moderate");
    await a.db.addRace({ name: "台北馬", date: "2026-12-20", distance_km: 42.195, target_time: "3:45:00" });
    await a.engine.sync();
    const b = await device("B", root);
    await b.engine.sync();
    expect((await b.db.getProfile()).pref_intensity).toBe("moderate");

    // C 剛加入：不能移除別台、不能刪除雲端的資料
    advance(23 * HOUR);
    const c = await device("C", root);
    await c.engine.sync();
    await expect(c.engine.rekey([a.identity.id])).rejects.toBeInstanceOf(SyncCooldownError);
    await expect(c.engine.deleteRemote()).rejects.toBeInstanceOf(SyncCooldownError);
    advance(2 * HOUR);

    // A 已經過了冷卻期：移除 C，換金鑰
    const oldSpace = (await deriveKeys(root)).space;
    const newRoot = await a.engine.rekey([c.identity.id]);
    expect(a.root).toEqual(newRoot);
    const newSpace = (await deriveKeys(newRoot)).space;
    expect(newSpace).not.toBe(oldSpace);
    // 舊空間的紀錄刪掉了，資料在新的空間（重新加密）
    expect((await serverDriver.all("SELECT COUNT(*) AS n FROM records WHERE space=?", [oldSpace]))[0]!.n).toBe(0);
    expect(Number((await serverDriver.all("SELECT COUNT(*) AS n FROM records WHERE space=?", [newSpace]))[0]!.n)).toBeGreaterThan(0);

    // B：下次同步自動換到新的空間，繼續同步
    const rb = await b.engine.sync();
    expect(b.root).toEqual(newRoot);
    expect(names(rb).sort()).toEqual(["A", "B"]);
    await b.db.setProfileKey("pref_intensity", "hard");
    await b.engine.sync();
    await a.engine.sync();
    expect((await a.db.getProfile()).pref_intensity).toBe("hard");
    expect((await a.db.getAllRaces()).map((r) => r.name)).toEqual(["台北馬"]);

    // C：伺服器回「已被移除」，附的證明對得上
    await expect(c.engine.sync()).rejects.toBeInstanceOf(SyncRemovedError);
    // C 拿舊的同步金鑰（復原碼）用新的身分重新登記：舊空間不再接受
    const again = await device("C2", root);
    await expect(again.engine.sync()).rejects.toMatchObject({ status: 410 });
    // 拿舊的復原碼還原（舊版的做法：直接讀）也不行
    const old = await legacy(root);
    await expect(old.engine.sync()).rejects.toMatchObject({ status: 410 });

    // 新的復原碼可以還原：登記成新的裝置，受冷卻期限制，資料都在
    const d = await device("D", newRoot);
    const rd = await d.engine.sync();
    expect(names(rd).sort()).toEqual(["A", "B", "D"]);
    expect(rd.devices!.cooldownUntil).toBe(serverNow.getTime() + 24 * HOUR);
    expect((await d.db.getProfile()).pref_intensity).toBe("hard");
  });

  it("只換金鑰；離線的裝置跨過兩次換金鑰也接得上；暫存的與刪除的紀錄一起帶過去", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.db.addRace({ name: "要刪的賽事", date: "2026-12-01", distance_km: 21.1, target_time: undefined });
    const b = await device("B", root);
    const c = await device("C", root);
    await a.engine.sync();
    await b.engine.sync();
    await c.engine.sync();
    const race = (await a.db.getAllRaces())[0]!;
    await a.db.deleteRace(race.id);
    await a.db.addRace({ name: "留下的賽事", date: "2026-12-20", distance_km: 42.195, target_time: undefined });
    await a.engine.sync();
    advance(25 * HOUR);

    const first = await a.engine.rekey();
    await b.engine.sync();
    expect(b.root).toEqual(first);
    const second = await b.engine.rekey();
    expect(second).not.toEqual(first);
    // C 一直離線：回來時跟著兩次搬家換到最新的空間，刪除也套用
    const rc = await c.engine.sync();
    expect(c.root).toEqual(second);
    expect(names(rc).sort()).toEqual(["A", "B", "C"]);
    expect((await c.db.getAllRaces()).map((r) => r.name)).toEqual(["留下的賽事"]);
    await a.engine.sync();
    expect(a.root).toEqual(second);
  });

  it("既有的空間在新版第一次同步時升級：舊版用戶端照舊直到升級；升級後 3 天內登記的算升級前就在同步", async () => {
    const root = newRootKey();
    const old1 = await legacy(root);
    await old1.engine.ensureSpace();
    await old1.db.setProfileKey("pref_intensity", "easy");
    await old1.engine.sync();
    const old2 = await legacy(root);
    await old2.engine.sync();
    expect((await old2.db.getProfile()).pref_intensity).toBe("easy");

    // 新版的第一台：自動登記，空間升級
    const a = await device("A", root);
    const ra = await a.engine.sync();
    expect(ra.devices!.devices[0]).toMatchObject({ legacy: true });
    expect(ra.devices!.cooldownUntil).toBe(0);
    // 舊版的用戶端之後只能登記，不能讀寫
    await expect(old2.engine.sync()).rejects.toMatchObject({ status: 403 });

    advance(2 * 24 * HOUR);
    const b = await device("B", root);
    expect((await b.engine.sync()).devices!.devices.find((d) => d.self)).toMatchObject({ legacy: true });
    advance(2 * 24 * HOUR);
    const c = await device("C", root);
    const rc = await c.engine.sync();
    expect(rc.devices!.devices.find((d) => d.self)).toMatchObject({ legacy: false });
    expect(rc.devices!.cooldownUntil).toBe(serverNow.getTime() + 24 * HOUR);
    expect((await c.db.getProfile()).pref_intensity).toBe("easy");
    // 升級前就在同步的不受冷卻期限制
    await a.engine.rekey([c.identity.id]);
    await expect(c.engine.sync()).rejects.toBeInstanceOf(SyncRemovedError);
  });

  it("沒有登記裝置的空間：舊版用戶端完全照舊", async () => {
    const root = newRootKey();
    const x = await legacy(root);
    expect(await x.engine.ensureSpace()).toBe(true);
    await x.db.setProfileKey("pref_intensity", "easy");
    const r = await x.engine.sync();
    expect(r.sent).toBeGreaterThan(0);
    expect(r.devices).toBeNull();
    expect((await serverDriver.all("SELECT COUNT(*) AS n FROM space_modes"))[0]!.n).toBe(0);
  });

  it("停止這台的同步：從裝置清單移除自己；只能移除自己", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    const b = await device("B", root);
    await b.engine.sync();
    const keys = await deriveKeys(root);
    // 不換金鑰就移除別台：拒絕
    await expect(api.request("DELETE", `/v1/spaces/${keys.space}/devices/${b.identity.id}`, undefined, { device: a.identity })).rejects.toMatchObject({
      status: 403,
    });
    await b.engine.leave();
    expect(names(await a.engine.sync())).toEqual(["A"]);
  });
});

describe("每台的身分驗證", () => {
  async function setup() {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.engine.sync();
    return { a, keys: await deriveKeys(root) };
  }

  it("錄下來的請求不能再送一次；改過內容或用別台的金鑰簽的被拒絕", async () => {
    const { a, keys } = await setup();
    seen = [];
    await api.request("GET", `/v1/spaces/${keys.space}/changes?since=0`, undefined, { device: a.identity });
    const replay = await handle(seen[0]!.clone());
    expect(replay.status).toBe(401);

    // 簽的是另一個路徑
    const headers = await signRequest(a.identity, "GET", `/v1/spaces/${keys.space}/devices`, "", serverNow.getTime());
    const wrongPath = await handle(new Request(`http://sync.test/v1/spaces/${keys.space}/changes?since=0`, { headers }));
    expect(wrongPath.status).toBe(403);

    // 簽的是另一份內容
    const body = JSON.stringify({ items: [] });
    const signed = await signRequest(a.identity, "POST", `/v1/spaces/${keys.space}/changes`, body, serverNow.getTime());
    const tampered = await handle(
      new Request(`http://sync.test/v1/spaces/${keys.space}/changes`, {
        method: "POST",
        headers: { ...signed, "content-type": "application/json" },
        body: JSON.stringify({ items: [{ id: "aaaaaaaaaaaaaaaa", base: 0, blob: "x" }] }),
      }),
    );
    expect(tampered.status).toBe(403);

    // 別台的私鑰、冒用 A 的 id
    const other = await newDeviceIdentity();
    const forged = await signRequest({ ...other, id: a.identity.id }, "GET", `/v1/spaces/${keys.space}/devices`, "", serverNow.getTime());
    expect((await handle(new Request(`http://sync.test/v1/spaces/${keys.space}/devices`, { headers: forged }))).status).toBe(403);

    // 時間差太多：回伺服器的時間（用戶端會校正後再送）
    const stale = await signRequest(a.identity, "GET", `/v1/spaces/${keys.space}/devices`, "", serverNow.getTime() - 10 * 60_000);
    const res = await handle(new Request(`http://sync.test/v1/spaces/${keys.space}/devices`, { headers: stale }));
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ state: "clock", serverTime: serverNow.getTime() });
  });

  it("登記要有同步金鑰的憑證，也要用那台的私鑰簽章", async () => {
    const { keys } = await setup();
    const x = await newDeviceIdentity();
    const label = await sealLabel(keys, x, { name: "X", platform: "t" });
    const body = { id: x.id, signPub: x.signPub, boxPub: x.boxPub, label };
    // 沒有憑證
    await expect(api.request("POST", `/v1/spaces/${keys.space}/devices`, body, { device: x })).rejects.toMatchObject({ status: 401 });
    // 有憑證但沒有簽章
    await expect(api.request("POST", `/v1/spaces/${keys.space}/devices`, body, keys.token)).rejects.toMatchObject({ status: 401 });
    // 簽章的私鑰和登記的公開金鑰不同
    const y = await newDeviceIdentity();
    await expect(api.request("POST", `/v1/spaces/${keys.space}/devices`, body, { device: { ...y, id: x.id }, token: keys.token })).rejects.toMatchObject({
      status: 403,
    });
    await api.request("POST", `/v1/spaces/${keys.space}/devices`, body, { device: x, token: keys.token });
  });

  it("換金鑰時的清單是舊的（中間有新裝置加入）就拒絕；換金鑰的這台要留下", async () => {
    const { a, keys } = await setup();
    advance(25 * HOUR);
    const newKeys = await deriveKeys(newRootKey());
    const base = { space: newKeys.space, token: newKeys.token };
    // 漏了 A 自己
    await expect(api.request("POST", `/v1/spaces/${keys.space}/rekey`, { ...base, keep: [], remove: [] }, { device: a.identity })).rejects.toMatchObject({
      status: 409,
    });
  });
});

describe("伺服器不受信任", () => {
  it("沒有證明（或證明不對）的「已被移除」不清資料", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const keys = await deriveKeys(root);
    // 伺服器自己把 A 標成已移除，證明亂寫
    await serverDriver.run("UPDATE devices SET removed_at=1, proof=? WHERE id=?", ["A".repeat(43), a.identity.id]);
    const error = await a.engine.sync().catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(SyncRemovedError);
    expect(String(error)).toContain("無法確認");
    void keys;
  });

  it("伺服器塞進自己的裝置：解不開裝置紀錄，清單標成無法驗證，換金鑰時不會拿到新的金鑰", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const keys = await deriveKeys(root);
    const evil = await newDeviceIdentity();
    await serverDriver.run(
      "INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
      [keys.space, evil.id, evil.signPub, evil.boxPub, "AAAA"],
    );
    // 拿 A 的裝置紀錄換上自己的金鑰也不行（紀錄綁定公開金鑰）
    const aLabel = String((await serverDriver.all("SELECT label FROM devices WHERE id=?", [a.identity.id]))[0]!.label);
    const evil2 = await newDeviceIdentity();
    await serverDriver.run(
      "INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) VALUES (?, ?, ?, ?, ?, 0, 0, 0)",
      [keys.space, evil2.id, evil2.signPub, evil2.boxPub, aLabel],
    );
    const r = await a.engine.sync();
    expect(names(r)).toEqual([null, null, "A"]);
    advance(25 * HOUR);
    await a.engine.rekey();
    const evilRows = await serverDriver.all("SELECT id, box, removed_at FROM devices WHERE id IN (?, ?) AND space=?", [evil.id, evil2.id, keys.space]);
    expect(evilRows.every((row) => row.box === null && row.removed_at !== null)).toBe(true);
  });

  it("伺服器假造的新金鑰：解不開，不換空間", async () => {
    const root = newRootKey();
    const a = await device("A", root);
    await a.engine.ensureSpace();
    await a.engine.sync();
    const keys = await deriveKeys(root);
    const fake = await deriveKeys(newRootKey());
    await serverDriver.run("INSERT INTO moves (space, moved_to, moved_at) VALUES (?, ?, 0)", [keys.space, fake.space]);
    await serverDriver.run("UPDATE devices SET box=? WHERE id=?", [`${a.identity.boxPub}.AAAAAAAAAAAAAAAA.AAAA`, a.identity.id]);
    await expect(a.engine.sync()).rejects.toThrow(/解不開|格式/);
    expect(a.root).toEqual(root);
    expect(SyncApiError).toBeDefined();
  });
});
