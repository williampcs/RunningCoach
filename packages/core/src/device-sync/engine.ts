/**
 * 多裝置同步的流程（規格 12.10）：
 * 1. 取回伺服器上次之後的變更，解密，套用到這台（這台在上次同步後也改過的，比時間，新的為準）
 * 2. 和上次同步時的雜湊比，找出這台改過、新增或刪掉的，加密後送出
 * 3. 送出時附上「上次看到的序號」，別台在這中間改過同一筆時伺服器拒絕，回到第 1 步再來一次
 * 伺服器只看到加密後的資料與隨機的 id. 每一筆加密的內容裡有版本號，每次送出加一；
 * 伺服器把某一筆換回之前的版本（或別筆的內容）時會被發現，停止同步.
 */
import type { Db } from "../db";
import { nowIso } from "../dates";
import { deriveKeys, newRootKey, open, recordId, seal, type SyncKeys } from "./crypto";
import {
  openLabel,
  openRekeyBox,
  removalProof,
  sealLabel,
  sealRekeyBox,
  signRequest,
  verifyRemovalProof,
  type DeviceIdentity,
  type DeviceLabel,
} from "./device";
import { applyEntity, hashOf, isAttached, isKnown, modifiedOf, snapshot, type EntityData, type Snapshot, type Sql } from "./entities";

const DELETED = "deleted";
const PUSH_BATCH = 100;
const MAX_ROUNDS = 4;

/** 伺服器上的一筆：解密後是 { k: 名稱, v: 版本號, m: 修改時間, d: 內容或 null（刪除） } */
interface Envelope {
  k: string;
  v: number;
  m: string;
  d: EntityData | null;
}

const ERROR_TEXT: Record<number, string> = {
  400: "同步服務不接受這個請求（格式不對）",
  401: "同步金鑰不符",
  403: "同步金鑰不符",
  404: "找不到：配對碼已經過期，或雲端的同步資料已經刪除",
  409: "配對碼已經被使用、順序不對或已經過期",
  410: "同步金鑰已經換了，或這台已從同步移除",
  413: "同步的資料超過上限",
  503: "同步服務暫時無法使用（可能已滿），請稍後再試",
};

export class SyncApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** 伺服器回的狀態（例如 removed、moved、cooldown）與附帶的欄位；不直接顯示 */
    readonly detail: Record<string, unknown> = {},
  ) {
    super(message);
  }

  get state(): string | null {
    return typeof this.detail.state === "string" ? this.detail.state : null;
  }
}

/** 這台已從同步移除（規格 12.27）：伺服器附上的證明對得上，App 清掉這台的資料 */
export class SyncRemovedError extends Error {
  constructor() {
    super("這台已從同步移除");
  }
}

/** 加入未滿冷卻期（規格 12.27）：until 是可以移除別台、換金鑰的時間（毫秒） */
export class SyncCooldownError extends Error {
  constructor(readonly until: number) {
    super("這台加入還不到 24 小時，還不能移除別台或換金鑰");
  }
}

/** 請求的身分：舊的憑證（從同步金鑰導出），或這台自己的金鑰簽章；登記時兩者都要 */
export type SyncAuth = string | { device: DeviceIdentity; token?: string };

/** 同步服務的 HTTP 介面（apps/sync） */
export class SyncApi {
  private readonly base: string;
  /** 伺服器與這台的時間差：簽章的時間要在伺服器的前後 5 分鐘內，不準時以伺服器的為準 */
  private clockOffset = 0;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, auth?: SyncAuth): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, body, auth);
      } catch (e) {
        // 這台的時鐘不準：以伺服器的時間校正後再送一次
        if (attempt === 0 && e instanceof SyncApiError && e.state === "clock" && typeof e.detail.serverTime === "number") {
          this.clockOffset = e.detail.serverTime - Date.now();
          continue;
        }
        throw e;
      }
    }
  }

  private async send<T>(method: string, path: string, body: unknown, auth: SyncAuth | undefined): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = {};
    const token = typeof auth === "string" ? auth : auth?.token;
    if (token) headers.authorization = `Bearer ${token}`;
    if (auth && typeof auth !== "string") Object.assign(headers, await signRequest(auth.device, method, path, text, Date.now() + this.clockOffset));
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : text,
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new SyncApiError(0, `連不上同步服務：${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // 錯誤訊息用這裡寫好的，不顯示伺服器傳來的文字（伺服器不受信任）
    if (!response.ok) {
      const { error: _ignored, ...detail } = json;
      throw new SyncApiError(response.status, ERROR_TEXT[response.status] ?? `同步服務發生錯誤（${response.status}）`, detail);
    }
    return json as T;
  }
}

/** 裝置清單的一台（規格 12.27） */
export interface SyncDevice {
  id: string;
  /** 解不開裝置紀錄（不是用這組同步金鑰登記的，或伺服器改過）時是 null；換金鑰時會被移除 */
  label: DeviceLabel | null;
  joinedAt: number;
  /** 伺服器記的最後同步時間 */
  lastSeenAt: number;
  /** 升級成裝置模式之前就在同步（不受冷卻期限制，不提醒新裝置加入） */
  legacy: boolean;
  self: boolean;
}

export interface SyncDevices {
  devices: SyncDevice[];
  /** 這台可以移除別台、換金鑰的時間（毫秒）；0 表示沒有限制 */
  cooldownUntil: number;
  serverTime: number;
}

interface RawDevice {
  id: string;
  signPub: string;
  boxPub: string;
  label: string;
  joinedAt: number;
  lastSeenAt: number;
  legacy: boolean;
}

interface RawDevices {
  devices: RawDevice[];
  self: string;
  cooldownUntil: number;
  serverTime: number;
}

/** 裝置模式（功能開關 devices）：這台自己的金鑰、第一次登記的名稱、同步金鑰換了時存起來 */
export interface SyncDeviceOptions {
  identity: DeviceIdentity;
  label: () => DeviceLabel;
  onRootChanged: (root: Uint8Array) => Promise<void>;
}

export interface SyncResult {
  /** 從別台套用的筆數 */
  received: number;
  /** 送出的筆數 */
  sent: number;
  /** 還在等這台有對應跑步的筆數 */
  pending: number;
  /** 這台和雲端一致的筆數（不含刪除） */
  total: number;
  at: string;
  /** 裝置模式時的裝置清單 */
  devices: SyncDevices | null;
}

export class SyncEngine {
  private keys: Promise<SyncKeys>;
  private spaceReady = false;
  private running: Promise<SyncResult> | null = null;
  /** 上次取得的裝置清單（含公開金鑰；改名、換金鑰用） */
  private rawDevices: RawDevices | null = null;

  constructor(
    private readonly db: Db,
    private readonly api: SyncApi,
    root: Uint8Array,
    private readonly now: () => Date = () => new Date(),
    private readonly device: SyncDeviceOptions | null = null,
  ) {
    this.keys = deriveKeys(root);
  }

  /** 請求用的身分：裝置模式用這台的簽章，否則用舊的憑證 */
  private auth(keys: SyncKeys): SyncAuth {
    return this.device ? { device: this.device.identity } : keys.token;
  }

  /**
   * 「開始同步」的第一台：建立同步空間；已存在時回傳 false.
   * 之後的同步只確認憑證，空間不存在（在別台刪除了）時不會再建立.
   * 裝置模式時新的空間一開始就只接受登記過的裝置，並登記這台
   */
  async ensureSpace(): Promise<boolean> {
    const keys = await this.keys;
    const { created } = await this.api.request<{ created: boolean }>(
      "PUT",
      `/v1/spaces/${keys.space}?create=1${this.device ? "&devices=1" : ""}`,
      undefined,
      keys.token,
    );
    if (this.device) await this.register(keys);
    this.spaceReady = true;
    return created;
  }

  /** 刪除伺服器上的整個同步空間（這台的資料不動），並清掉這台的同步狀態 */
  async deleteRemote(): Promise<void> {
    const keys = await this.keys;
    await this.api.request("DELETE", `/v1/spaces/${keys.space}`, undefined, this.auth(keys)).catch((e) => {
      throw this.cooldownOf(e) ?? e;
    });
    await this.forget();
  }

  /** 停止這台的同步：裝置模式時先從伺服器的裝置清單移除自己（連不上也照樣停止） */
  async leave(): Promise<void> {
    if (this.device) {
      const keys = await this.keys;
      await this.api.request("DELETE", `/v1/spaces/${keys.space}/devices/${this.device.identity.id}`, undefined, this.auth(keys)).catch(() => undefined);
    }
    await this.forget();
  }

  private cooldownOf(e: unknown): SyncCooldownError | null {
    return e instanceof SyncApiError && e.state === "cooldown" ? new SyncCooldownError(Number(e.detail.until) || 0) : null;
  }

  // -------------------------------------------------------------------------
  // 裝置（規格 12.27）
  // -------------------------------------------------------------------------

  /** 登記這台（舊的憑證證明知道同步金鑰，加上這台的簽章） */
  private async register(keys: SyncKeys): Promise<RawDevices> {
    const device = this.device!;
    const { identity } = device;
    const label = await sealLabel(keys, identity, device.label());
    this.rawDevices = await this.api.request<RawDevices>(
      "POST",
      `/v1/spaces/${keys.space}/devices`,
      { id: identity.id, signPub: identity.signPub, boxPub: identity.boxPub, label },
      { device: identity, token: keys.token },
    );
    return this.rawDevices;
  }

  /** 取得裝置清單；這台還沒登記在這個空間時先登記（既有的空間在新版第一次同步時自動升級） */
  private async fetchDevices(keys: SyncKeys): Promise<RawDevices> {
    try {
      this.rawDevices = await this.api.request<RawDevices>("GET", `/v1/spaces/${keys.space}/devices`, undefined, this.auth(keys));
      return this.rawDevices;
    } catch (e) {
      if (e instanceof SyncApiError && e.state === "unknown_device") return this.register(keys);
      throw e;
    }
  }

  private async devicesView(keys: SyncKeys, raw: RawDevices): Promise<SyncDevices> {
    const devices = await Promise.all(
      raw.devices.map(async (d) => ({
        id: d.id,
        label: await openLabel(keys, d, d.label),
        joinedAt: d.joinedAt,
        lastSeenAt: d.lastSeenAt,
        legacy: d.legacy,
        self: d.id === this.device?.identity.id,
      })),
    );
    return { devices, cooldownUntil: raw.cooldownUntil, serverTime: raw.serverTime };
  }

  /** 改名（任何一台都可以替任何一台改） */
  async renameDevice(id: string, label: DeviceLabel): Promise<SyncDevices> {
    const keys = await this.keys;
    const raw = this.rawDevices ?? (await this.fetchDevices(keys));
    const target = raw.devices.find((d) => d.id === id);
    if (!target) throw new Error("找不到這台裝置，請重新整理");
    await this.api.request("PUT", `/v1/spaces/${keys.space}/devices/${id}/label`, { label: await sealLabel(keys, target, label) }, this.auth(keys));
    return this.devicesView(keys, await this.fetchDevices(keys));
  }

  /**
   * 換金鑰（規格 12.27），同時移除 remove 列出的裝置（只換金鑰時是空的）：
   * 1. 先同步，取回雲端所有的紀錄（解密後放在記憶體）
   * 2. 產生新的同步金鑰；留下的每台各加密一份（解不開裝置紀錄的也一起移除），移除的附上證明
   * 3. 伺服器在一個交易裡建立新的空間、搬過留下的裝置、刪掉舊空間的紀錄（冷卻期由伺服器檢查）
   * 4. 這台改用新的金鑰，把剛才取回的紀錄用新金鑰重新加密送到新的空間，再同步一次
   * 回傳新的同步金鑰（已經用 onRootChanged 存起來），App 顯示新的復原碼
   */
  async rekey(remove: string[] = []): Promise<Uint8Array> {
    if (!this.device) throw new Error("換金鑰要開啟裝置清單");
    const device = this.device;
    await this.sync();
    for (let attempt = 0; ; attempt++) {
      const keys = await this.keys;
      const raw = await this.fetchDevices(keys);
      if (raw.serverTime < raw.cooldownUntil) throw new SyncCooldownError(raw.cooldownUntil);
      // 雲端所有的紀錄（含這台還沒有對應跑步的、這個版本不認得的、刪除的標記）：換到新的空間時原樣帶過去
      const { remote } = await this.fetchRemote(keys, 0);
      const newRoot = newRootKey();
      const newKeys = await deriveKeys(newRoot);
      const keep: { id: string; label: string; box: string }[] = [];
      const removed: { id: string; proof: string }[] = [];
      for (const d of raw.devices) {
        const label = await openLabel(keys, d, d.label);
        if (d.id !== device.identity.id && (remove.includes(d.id) || !label)) removed.push({ id: d.id, proof: await removalProof(keys, d.id) });
        else
          keep.push({
            id: d.id,
            label: await sealLabel(newKeys, d, label ?? device.label()),
            box: await sealRekeyBox(keys, newRoot, newKeys.space, d),
          });
      }
      try {
        await this.api.request("POST", `/v1/spaces/${keys.space}/rekey`, { space: newKeys.space, token: newKeys.token, keep, remove: removed }, this.auth(keys));
      } catch (e) {
        // 中間有新裝置加入：重新取清單再試一次
        if (attempt === 0 && e instanceof SyncApiError && e.state === "devices_changed") continue;
        throw this.cooldownOf(e) ?? e;
      }
      await this.switchTo(newRoot, newKeys);
      await this.copyInto(newKeys, remote);
      await this.sync();
      return newRoot;
    }
  }

  /** 改用新的同步金鑰：存起來、清掉這台對舊空間的同步狀態（暫存的別台資料留著） */
  private async switchTo(root: Uint8Array, keys: SyncKeys): Promise<void> {
    await this.device!.onRootChanged(root);
    this.keys = Promise.resolve(keys);
    this.spaceReady = false;
    this.rawDevices = null;
    await this.db.syncTransaction(async (sql) => {
      await sql.run("DELETE FROM sync_state");
      await sql.run("DELETE FROM sync_meta WHERE k<>'last_sync'");
      await setMeta(sql, "space", keys.space);
    });
  }

  /** 把舊空間的紀錄用新的金鑰重新加密送到新的空間（版本號不變）；別台已經先送了同一筆的就以它的為準 */
  private async copyInto(keys: SyncKeys, remote: Map<string, { env: Envelope; seq: number }>): Promise<void> {
    const all = [...remote.values()].sort((a, b) => order(a.env.k) - order(b.env.k) || a.seq - b.seq);
    for (let i = 0; i < all.length; i += PUSH_BATCH) {
      const batch = all.slice(i, i + PUSH_BATCH);
      const items = await Promise.all(
        batch.map(async ({ env }) => {
          const id = await recordId(keys, env.k);
          return { id, base: 0, blob: await seal(keys, id, env) };
        }),
      );
      const response = await this.api.request<{ applied: { id: string; seq: number }[]; conflicts: string[] }>(
        "POST",
        `/v1/spaces/${keys.space}/changes`,
        { items },
        this.auth(keys),
      );
      const seqById = new Map(response.applied.map((a) => [a.id, a.seq]));
      await this.db.syncTransaction(async (sql) => {
        for (const [index, { env }] of batch.entries()) {
          const seq = seqById.get(items[index]!.id);
          if (seq !== undefined) await saveState(sql, env.k, env.d ? await hashOf(env.d) : DELETED, seq, env.v);
        }
      });
    }
  }

  /**
   * 換過金鑰的空間（伺服器回「已搬家」與給這台的新同步金鑰）：解開、確認導出的空間 id 對得上，改用新的空間.
   * 新的同步金鑰要用舊的同步金鑰才解得開，伺服器假造不出來
   */
  private async followMove(e: SyncApiError): Promise<void> {
    const oldKeys = await this.keys;
    const newSpace = e.detail.space;
    const box = e.detail.box;
    if (typeof newSpace !== "string" || typeof box !== "string") throw new Error("同步金鑰已經換了，但伺服器沒有給這台新的金鑰。請用配對或新的復原碼重新加入。");
    let root: Uint8Array;
    try {
      root = await openRekeyBox(oldKeys, this.device!.identity, newSpace, box);
    } catch {
      throw new Error("同步金鑰已經換了，但這台解不開新的金鑰。請用配對或新的復原碼重新加入。");
    }
    const keys = await deriveKeys(root);
    if (keys.space !== newSpace) throw new Error("新的同步金鑰對不上，停止同步。");
    await this.switchTo(root, keys);
  }

  /** 伺服器說這台已被移除：證明要用同步金鑰才算得出來，對得上才清資料（伺服器不能騙這台清掉資料） */
  private async checkRemoved(e: SyncApiError): Promise<never> {
    const keys = await this.keys;
    if (this.device && (await verifyRemovalProof(keys, this.device.identity.id, e.detail.proof))) throw new SyncRemovedError();
    throw new Error("同步服務說這台已被移除，但無法確認；這台的資料保留。");
  }


  /** 清掉這台的同步狀態（停止同步時）；下次加入時會和雲端的資料合併 */
  forget(): Promise<void> {
    return this.db.syncTransaction(clearState);
  }

  /** 同一時間只跑一次；重疊的呼叫拿到同一個結果 */
  sync(): Promise<SyncResult> {
    this.running ??= this.run().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  /** 裝置模式：同步金鑰換過時跟著換到新的空間（離線很久、換過好幾次的也一路跟上） */
  private async run(): Promise<SyncResult> {
    for (let hop = 0; ; hop++) {
      try {
        return await this.runOnce();
      } catch (e) {
        if (this.device && e instanceof SyncApiError && e.status === 410) {
          if (e.state === "removed") await this.checkRemoved(e);
          if (e.state === "moved" && hop < 8) {
            await this.followMove(e);
            continue;
          }
        }
        throw e;
      }
    }
  }

  private async runOnce(): Promise<SyncResult> {
    const keys = await this.keys;
    await this.db.syncTransaction(async (sql) => {
      // 這台記得雲端已經刪除：不再連線（即使有人用同一把金鑰把空間建回來，也不會把資料送過去）
      if ((await getMeta(sql, "gone")) === keys.space) throw new SyncApiError(404, "雲端的同步資料已經刪除");
      // 上次同步的是另一組金鑰（例如清除設定後重新開始）：舊的同步狀態不適用
      const space = await getMeta(sql, "space");
      if (space !== null && space !== keys.space) await clearState(sql);
      await setMeta(sql, "space", keys.space);
    });
    const result: SyncResult = { received: 0, sent: 0, pending: 0, total: 0, at: nowIso(this.now()), devices: null };
    try {
      // 裝置模式：每次先取裝置清單（也確認這台還在、記下最後同步的時間）；還沒登記就登記
      if (this.device) {
        result.devices = await this.devicesView(keys, await this.fetchDevices(keys));
        this.spaceReady = true;
      } else if (!this.spaceReady) {
        await this.api.request("PUT", `/v1/spaces/${keys.space}`, undefined, keys.token);
        this.spaceReady = true;
      }
      for (let round = 0; round < MAX_ROUNDS; round++) {
        result.received += await this.pull(keys);
        const { sent, conflicts } = await this.push(keys);
        result.sent += sent;
        if (!conflicts) break;
      }
    } catch (e) {
      // 空間不存在：在別台刪除了。記住，之後不再連線，直到使用者在這台停止同步
      if (e instanceof SyncApiError && e.status === 404) await this.db.syncTransaction((sql) => setMeta(sql, "gone", keys.space));
      throw e;
    }
    result.total = Number(
      (await this.db.syncTransaction((sql) => sql.all("SELECT COUNT(*) AS n FROM sync_state WHERE hash<>?", [DELETED])))[0]?.n ?? 0,
    );
    result.pending = Number(
      (await this.db.syncTransaction((sql) => sql.all("SELECT COUNT(*) AS n FROM sync_pending")))[0]?.n ?? 0,
    );
    await this.db.syncTransaction((sql) => setMeta(sql, "last_sync", result.at));
    return result;
  }

  /** 取回 since 之後的紀錄並解密（依序號；同一筆只留最後一版）；回傳最後的序號 */
  private async fetchRemote(keys: SyncKeys, from: number): Promise<{ remote: Map<string, { env: Envelope; seq: number }>; since: number }> {
    let since = from;
    const remote = new Map<string, { env: Envelope; seq: number }>();
    for (;;) {
      const page = await this.api.request<{ items: { id: string; seq: number; blob: string }[]; more: boolean }>(
        "GET",
        `/v1/spaces/${keys.space}/changes?since=${since}`,
        undefined,
        this.auth(keys),
      );
      for (const item of page.items) {
        const env = (await open(keys, item.id, item.blob)) as Envelope;
        // 名稱和 id 對不上：伺服器把別筆的內容放到這個 id 下
        if (typeof env.k !== "string" || (await recordId(keys, env.k)) !== item.id) throw new Error("同步資料的 id 不符，停止同步");
        if (!Number.isSafeInteger(env.v) || env.v < 1) throw new Error("同步資料的版本號不對，停止同步");
        const earlier = remote.get(env.k);
        if (earlier && env.v <= earlier.env.v) throw new Error("同步服務送回了比這台看過的更舊的資料，停止同步");
        remote.set(env.k, { env, seq: item.seq });
        since = Math.max(since, item.seq);
      }
      // 只依收到的紀錄前進，不採用伺服器說的其他序號
      if (!page.more || !page.items.length) break;
    }
    return { remote, since };
  }

  /** 取回並套用；回傳套用的筆數 */
  private async pull(keys: SyncKeys): Promise<number> {
    const { remote, since } = await this.fetchRemote(keys, Number((await this.db.syncTransaction((sql) => getMeta(sql, "last_seq"))) ?? 0));

    return this.db.syncTransaction(async (sql) => {
      let applied = 0;
      const snap = await snapshot(sql);
      const state = await loadState(sql);
      const pending = await pendingNames(sql);
      // 之前暫存的（例如那趟跑步這台當時還沒有）再試一次
      for (const row of await sql.all("SELECT key, data FROM sync_pending")) {
        const name = String(row.key);
        if (remote.has(name)) continue;
        if ((await applyEntity(sql, name, JSON.parse(String(row.data)) as EntityData, snap)) === "applied") {
          await sql.run("DELETE FROM sync_pending WHERE key=?", [name]);
          pending.delete(name);
          applied++;
        }
      }
      for (const [name, { env, seq }] of [...remote].sort((a, b) => order(a[0]) - order(b[0]) || a[1].seq - b[1].seq)) {
        const before = state.get(name);
        // 這台自己送出的那一版又被取回：不用再套用
        if (before && before.seq === seq) continue;
        // 版本號只會變大：比這台看過的舊，表示伺服器送回了之前的版本
        if (before && env.v <= before.v) throw new Error("同步服務送回了比這台看過的更舊的資料，停止同步");
        const local = snap.data.get(name) ?? null;
        const localHash = local ? await hashOf(local) : null;
        const remoteHash = env.d ? await hashOf(env.d) : DELETED;
        // 這台在上次同步後改過、而且內容和伺服器上的不同：比時間，這台的比較新就保留（之後送出）
        const changedHere = before
          ? (localHash ?? DELETED) !== before.hash && !(localHash === null && absentIsNotDeleted(name, pending))
          : localHash !== null;
        if (changedHere && (localHash ?? DELETED) !== remoteHash) {
          const mine = modifiedOf(local) ?? nowIso(this.now());
          if (mine > env.m) {
            await saveState(sql, name, before?.hash ?? "", seq, env.v);
            continue;
          }
        }
        const outcome = await applyEntity(sql, name, env.d, snap);
        if (outcome === "pending") {
          await sql.run("INSERT OR REPLACE INTO sync_pending (key, data) VALUES (?, ?)", [name, JSON.stringify(env.d)]);
          pending.add(name);
        } else {
          await sql.run("DELETE FROM sync_pending WHERE key=?", [name]);
          pending.delete(name);
        }
        await saveState(sql, name, remoteHash, seq, env.v);
        applied++;
      }
      await setMeta(sql, "last_seq", String(since));
      return applied;
    });
  }

  /** 送出這台的變更；回傳送出的筆數與有沒有衝突 */
  private async push(keys: SyncKeys): Promise<{ sent: number; conflicts: boolean }> {
    const outgoing = await this.db.syncTransaction(async (sql) => {
      const snap = await snapshot(sql);
      const state = await loadState(sql);
      const pending = await pendingNames(sql);
      const out: { name: string; data: EntityData | null; hash: string; base: number; v: number }[] = [];
      for (const [name, data] of snap.data) {
        const hash = await hashOf(data);
        const before = state.get(name);
        if (!before || before.hash !== hash) out.push({ name, data, hash, base: before?.seq ?? 0, v: (before?.v ?? 0) + 1 });
      }
      for (const [name, before] of state) {
        if (!snap.data.has(name) && before.hash !== DELETED && !absentIsNotDeleted(name, pending))
          out.push({ name, data: null, hash: DELETED, base: before.seq, v: before.v + 1 });
      }
      return out.sort((a, b) => order(a.name) - order(b.name));
    });

    let sent = 0;
    let conflicts = false;
    for (let i = 0; i < outgoing.length; i += PUSH_BATCH) {
      const batch = outgoing.slice(i, i + PUSH_BATCH);
      const items = await Promise.all(
        batch.map(async (o) => {
          const id = await recordId(keys, o.name);
          const env: Envelope = { k: o.name, v: o.v, m: modifiedOf(o.data) ?? nowIso(this.now()), d: o.data };
          return { id, base: o.base, blob: await seal(keys, id, env) };
        }),
      );
      const response = await this.api.request<{ applied: { id: string; seq: number }[]; conflicts: string[] }>(
        "POST",
        `/v1/spaces/${keys.space}/changes`,
        { items },
        this.auth(keys),
      );
      const seqById = new Map(response.applied.map((a) => [a.id, a.seq]));
      await this.db.syncTransaction(async (sql) => {
        for (const [index, o] of batch.entries()) {
          const seq = seqById.get(items[index]!.id);
          if (seq !== undefined) {
            await saveState(sql, o.name, o.hash, seq, o.v);
            sent++;
          }
        }
      });
      if (response.conflicts.length) conflicts = true;
    }
    return { sent, conflicts };
  }
}

/**
 * 這台沒有、但不代表刪掉了的：掛在跑步上的（這台可能還沒有那趟跑步）、還在暫存的
 * （例如課表還沒到的課）、這個版本不認得的種類. 這些不會被當成刪除送出
 */
const absentIsNotDeleted = (name: string, pending: Set<string>) => isAttached(name) || !isKnown(name) || pending.has(name);

async function pendingNames(sql: Sql): Promise<Set<string>> {
  return new Set((await sql.all("SELECT key FROM sync_pending")).map((r) => String(r.key)));
}

/** 套用的順序：課表要在課之前 */
const order = (name: string) => (name.startsWith("pl:") ? 0 : name.startsWith("ps:") ? 2 : 1);

async function loadState(sql: Sql): Promise<Map<string, { hash: string; seq: number; v: number }>> {
  const rows = await sql.all("SELECT key, hash, seq, v FROM sync_state");
  return new Map(rows.map((r) => [String(r.key), { hash: String(r.hash), seq: Number(r.seq), v: Number(r.v) }]));
}

async function saveState(sql: Sql, name: string, hash: string, seq: number, v: number): Promise<void> {
  await sql.run("INSERT OR REPLACE INTO sync_state (key, hash, seq, v) VALUES (?, ?, ?, ?)", [name, hash, seq, v]);
}

async function clearState(sql: Sql): Promise<void> {
  await sql.run("DELETE FROM sync_state");
  await sql.run("DELETE FROM sync_pending");
  await sql.run("DELETE FROM sync_meta");
}

async function getMeta(sql: Sql, key: string): Promise<string | null> {
  const row = (await sql.all("SELECT v FROM sync_meta WHERE k=?", [key]))[0];
  return row ? String(row.v) : null;
}

async function setMeta(sql: Sql, key: string, value: string): Promise<void> {
  await sql.run("INSERT OR REPLACE INTO sync_meta (k, v) VALUES (?, ?)", [key, value]);
}

/** 上次同步完成的時間（ISO）；還沒同步過是 null */
export function lastSyncAt(db: Db): Promise<string | null> {
  return db.syncTransaction((sql) => getMeta(sql, "last_sync"));
}

export type { Snapshot };
