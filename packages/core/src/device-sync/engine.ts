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
import { deriveKeys, fromBase64url, newRootKey, open, recordId, seal, toBase64url, type SyncKeys } from "./crypto";
import {
  boxHash,
  openLabel,
  openRekeyBox,
  removalProof,
  sealLabel,
  sealRekeyBox,
  signRequest,
  signStatement,
  verifyRemovalProof,
  verifyStatement,
  type DeviceIdentity,
  type DeviceLabel,
  type RekeyStatement,
} from "./device";
import { applyEntity, hashOf, isAttached, isKnown, modifiedOf, snapshot, type EntityData, type Snapshot, type Sql } from "./entities";
import { trimTrailingSlashes } from "../text-match";

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
  415: "同步服務不接受這個請求（格式不對）",
  429: "剛換過金鑰，請等一分鐘再試",
  503: "同步服務暫時無法使用（可能已滿），請稍後再試",
};

/** 依伺服器回的狀態顯示的說明（比狀態碼的通用說明清楚） */
const STATE_TEXT: Record<string, string> = {
  rate_limited: "同步太頻繁了，請稍後再試",
  human_check: "人機驗證沒有通過或已經過期，請再試一次",
  human_check_unavailable: "人機驗證暫時無法使用，請稍後再試",
  daily_limit: "今天的同步量已達上限，明天會自動恢復；資料都還在這台",
  network_full: "這個網路建立的同步空間已達總容量上限，新的資料暫時送不上去；資料都還在這台",
  rekey_limit: "今天換金鑰的額度用完了，明天會自動接著做；資料都還在這台，原本的同步照常",
  rekey_pending: "正在換新的同步金鑰，換好之後才能加入新的裝置；請稍後再試",
  rekey_in_progress: "另一台正在換金鑰。要改由這台重新開始，按「改由這台換」（另一台的換金鑰會取消）",
  rekey_too_large: "資料太多，目前的服務方案一天搬不完，暫時無法換金鑰（移除裝置）；原本的同步照常",
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
    /** 等一段時間（被頻率限制時）；測試時可以換掉 */
    readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.base = trimTrailingSlashes(baseUrl);
  }

  /** headers：另外帶的標頭（例：人機驗證的 token，x-turnstile） */
  async request<T>(method: string, path: string, body?: unknown, auth?: SyncAuth, headers?: Record<string, string>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.send<T>(method, path, body, auth, headers);
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

  private async send<T>(method: string, path: string, body: unknown, auth: SyncAuth | undefined, extra: Record<string, string> = {}): Promise<T> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const headers: Record<string, string> = { ...extra };
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
      // 逾時：伺服器一直沒有回應（例如太忙）
      if (e instanceof Error && e.name === "TimeoutError") throw new SyncApiError(0, "同步服務 30 秒沒有回應，請稍後再試");
      throw new SyncApiError(0, `連不上同步服務：${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // 錯誤訊息用這裡寫好的，不顯示伺服器傳來的文字（伺服器不受信任）
    if (!response.ok) {
      const { error: _ignored, ...detail } = json;
      const message = (typeof detail.state === "string" ? STATE_TEXT[detail.state] : undefined) ?? ERROR_TEXT[response.status];
      throw new SyncApiError(response.status, message ?? `同步服務發生錯誤（${response.status}）`, detail);
    }
    return json as T;
  }
}

/**
 * 換金鑰進行到哪裡（畫面顯示用）：取回資料、複製到新的空間（done／total 筆）、被頻率限制時等待（seconds 秒）、送出換金鑰、改用新的金鑰
 */
export type RekeyProgress =
  | { step: "fetch" }
  | { step: "copy"; done: number; total: number }
  | { step: "wait"; seconds: number }
  | { step: "rekey" }
  | { step: "switch" };

/** 換金鑰時被頻率限制，最多等這麼久（每小時的位元組上限）；更久的就停下來 */
const MAX_RATE_WAIT_MS = 65 * 60_000;

/** 換金鑰最後一步的結果不確定（連不上或伺服器出錯，伺服器可能已經換好）：沒有清掉任何東西 */
export class SyncRekeyUnknownError extends Error {
  constructor() {
    super("換金鑰的結果還不確定（同步服務沒有回應）。資料都還在：請稍後重新整理，已經換好的話這台會自動改用新的金鑰，到「顯示復原碼」看新的復原碼；沒有換成的話再試一次。");
  }
}

/** 換金鑰的每日額度用完（規格 12.10）：做到一半的保留著，resumeAt（毫秒）之後接著做 */
export class SyncRekeyPausedError extends Error {
  constructor(
    readonly done: number,
    readonly total: number,
    readonly resumeAt: number,
  ) {
    super(`今天換金鑰的額度用完了：已完成 ${done}／${total} 筆，明天會自動接著做`);
  }
}

/** 換到一半的換金鑰（畫面顯示用）：新空間、已經複製的筆數、先移除的裝置、今天的額度用完時幾點之後接著做（0 表示現在就可以） */
export interface PendingRekey {
  space: string;
  resumeAt: number;
  done: number;
  total: number;
  removed: string[];
}

/** 存在這台的同步狀態裡（sync_meta）：新的同步金鑰只在這台 */
interface StoredRekey extends PendingRekey {
  root: string;
  from: string;
  /** 開始時（使用者確認過的）裝置清單 */
  expected?: string[];
}

const REKEY_META = "rekey_pending";

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
   * 裝置模式時新的空間一開始就只接受登記過的裝置，並登記這台.
   * humanToken：人機驗證（Turnstile）拿到的 token；同步服務有開人機驗證時，建立新的空間要有它
   */
  async ensureSpace(humanToken?: string): Promise<boolean> {
    const keys = await this.keys;
    const { created } = await this.api.request<{ created: boolean }>(
      "PUT",
      `/v1/spaces/${keys.space}?create=1${this.device ? "&devices=1" : ""}`,
      undefined,
      keys.token,
      humanToken ? { "x-turnstile": humanToken } : undefined,
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
    let raw: RawDevices;
    try {
      raw = await this.api.request<RawDevices>("GET", `/v1/spaces/${keys.space}/devices`, undefined, this.auth(keys));
    } catch (e) {
      if (!(e instanceof SyncApiError && e.state === "unknown_device")) throw e;
      raw = await this.register(keys);
    }
    this.rawDevices = raw;
    await this.remember(keys, raw);
    return raw;
  }

  /**
   * 記住驗證過的裝置（裝置紀錄用同步金鑰解得開，公開金鑰和紀錄綁在一起）：id → 簽章的公開金鑰.
   * 收到「已搬家」「已被移除」時，只接受這裡記得的裝置簽的聲明. 同一個 id 換了公開金鑰的不採用
   */
  private async remember(keys: SyncKeys, raw: RawDevices): Promise<void> {
    const known = await this.knownDevices();
    let changed = false;
    for (const d of raw.devices) {
      if (known[d.id] || !(await openLabel(keys, d, d.label))) continue;
      known[d.id] = d.signPub;
      changed = true;
    }
    if (changed) await this.db.syncTransaction((sql) => setMeta(sql, "known_devices", JSON.stringify(known)));
  }

  private async knownDevices(): Promise<Record<string, string>> {
    const text = await this.db.syncTransaction((sql) => getMeta(sql, "known_devices"));
    const known: Record<string, string> = {};
    try {
      Object.assign(known, JSON.parse(text ?? "{}") as Record<string, string>);
    } catch {
      // 壞掉就重新記
    }
    if (this.device) known[this.device.identity.id] = this.device.identity.signPub;
    return known;
  }

  /** 「已搬家」「已被移除」附的聲明：本機記得的裝置簽的、從這個空間換出去、簽的那台沒有被移除 */
  private async checkStatement(e: SyncApiError, from: string): Promise<RekeyStatement | null> {
    const signer = e.detail.signer;
    if (typeof signer !== "string") return null;
    const pub = (await this.knownDevices())[signer];
    if (!pub) return null;
    const statement = await verifyStatement(pub, e.detail.statement, e.detail.signature);
    if (!statement || statement.from !== from || statement.remove.includes(signer) || !statement.keep.includes(signer)) return null;
    return statement;
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
   * 換金鑰（規格 12.27、12.10「換金鑰可以跨天完成」），同時移除 remove 列出的裝置（只換金鑰時是空的）.
   * expected 是使用者確認時看到的裝置 id：現在的清單和它不同（中間有裝置加入或被換掉）就停止，請使用者重新確認.
   * 1. 先同步；產生新的同步金鑰，建立新的空間（換到一半的新空間存在這台，之後接著做）
   * 2. 有要移除的：馬上請伺服器把它們標成已移除（之後拒絕它們；它們下次連線拿到這台簽的聲明與證明）
   * 3. 把舊空間的紀錄用新金鑰重新加密送到新空間（版本號不變）. 換金鑰的每日額度用完時停下（SyncRekeyPausedError），
   *    隔天從斷掉的地方接著送（resumeRekey）；比對新空間已經有的紀錄與版本，不重送
   * 4. 給留下的每台加密一份新金鑰，簽一份聲明，送出換金鑰（附上已經複製到舊空間的哪個序號）：伺服器在一個交易裡
   *    搬過留下的裝置、刪掉舊空間的紀錄；這段時間舊空間又有新的寫入時伺服器拒絕，補送後再試
   * 5. 這台改用新的金鑰，再同步一次
   * 解不開裝置紀錄的（伺服器塞的、或不是用這組同步金鑰登記的）不給新金鑰，也不算它的移除證明.
   * 回傳新的同步金鑰（已經用 onRootChanged 存起來），App 顯示新的復原碼
   */
  async rekey(
    remove: string[] = [],
    expected?: string[],
    onProgress?: (step: RekeyProgress) => void,
    /** replace：伺服器上已經有一個這台不知道的換到一半的（另一台開始的、或這台的紀錄不見了）時，使用者明確選了改由這台重新開始 */
    opts: { replace?: boolean } = {},
  ): Promise<Uint8Array> {
    if (!this.device) throw new Error("換金鑰要開啟裝置清單");
    const { identity } = this.device;
    await this.sync();
    const keys = await this.keys;
    const raw = await this.fetchDevices(keys);
    if (raw.serverTime < raw.cooldownUntil) throw new SyncCooldownError(raw.cooldownUntil);
    const ids = raw.devices.map((d) => d.id);
    if (new Set(ids).size !== ids.length) throw new Error("裝置清單不對（同一台出現兩次），停止換金鑰。");
    const self = raw.devices.find((d) => d.id === identity.id);
    if (!self || self.signPub !== identity.signPub || self.boxPub !== identity.boxPub) throw new Error("裝置清單裡這台的金鑰不對，停止換金鑰。");
    if (expected && (expected.length !== ids.length || expected.some((id) => !ids.includes(id)))) {
      throw new SyncApiError(409, "裝置清單剛剛變了，請重新確認後再試", { state: "devices_changed" });
    }
    if (remove.some((id) => !ids.includes(id) || id === identity.id)) throw new Error("要移除的裝置不在清單裡");

    // 已經有換到一半的（這台開始的）：接著做那一個，不重新開始
    let pending = await this.loadPending(keys);
    if (!pending) {
      const root = newRootKey();
      const newKeys = await deriveKeys(root);
      // 帶上舊空間並用這台的金鑰簽：伺服器確認是舊空間裡的裝置在換金鑰（一換一），不受整個服務的空間數限制.
      // 伺服器上已經有一個這台不知道的（另一台正在換）：409 rekey_in_progress；使用者明確選了改由這台重新開始才取代它
      await this.api.request("PUT", `/v1/spaces/${newKeys.space}?create=1&devices=1&from=${keys.space}${opts.replace ? "&replace=1" : ""}`, undefined, {
        device: identity,
        token: newKeys.token,
      });
      // 使用者確認過的清單（換到一半時不會有別的裝置加入；萬一有，停下來請使用者重新確認）
      pending = {
        root,
        keys: newKeys,
        stored: { root: toBase64url(root), space: newKeys.space, from: keys.space, resumeAt: 0, done: 0, total: 0, removed: [], expected: ids },
      };
      await this.savePending(pending.stored);
    }
    if (remove.length) await this.removeNow(keys, pending, raw, remove);
    return this.finishRekey(keys, pending, onProgress);
  }

  /** 換到一半的換金鑰（這台開始的、還沒完成）；沒有的話 null */
  async pendingRekey(): Promise<PendingRekey | null> {
    const pending = await this.loadPending(await this.keys);
    if (!pending) return null;
    const { space, resumeAt, done, total, removed } = pending.stored;
    return { space, resumeAt, done, total, removed };
  }

  /** 接著做換到一半的換金鑰（隔天、或關掉頁面再打開時）；沒有換到一半的時回傳 null */
  async resumeRekey(onProgress?: (step: RekeyProgress) => void): Promise<Uint8Array | null> {
    if (!this.device) return null;
    const keys = await this.keys;
    const pending = await this.loadPending(keys);
    if (!pending) return null;
    await this.sync();
    // 同步時跟著別台換到新的空間（另一台換好了）：這台換到一半的已經沒有用
    if ((await this.keys).space !== keys.space) return null;
    return this.finishRekey(keys, pending, onProgress);
  }

  /** 放棄換到一半的換金鑰：刪掉新的空間（已經移除的裝置維持移除，換好金鑰之前不能加入新的裝置） */
  async cancelRekey(): Promise<void> {
    const keys = await this.keys;
    const pending = await this.loadPending(keys);
    if (!pending) return;
    // 在舊空間簽章（這台還沒登記到新空間時也放得掉）
    await this.api.request("DELETE", `/v1/spaces/${keys.space}/rekey`, undefined, this.auth(keys)).catch((e: unknown) => {
      // 舊空間已經不在：也就沒有換到一半的了
      if (!(e instanceof SyncApiError && e.status === 404)) throw e;
    });
    await this.clearPending();
  }

  private async loadPending(keys: SyncKeys): Promise<{ root: Uint8Array; keys: SyncKeys; stored: StoredRekey } | null> {
    const text = await this.db.syncTransaction((sql) => getMeta(sql, REKEY_META));
    if (!text) return null;
    try {
      const stored = JSON.parse(text) as StoredRekey;
      // 從別的空間開始的（之後換過金鑰、或重新開始同步）：不適用
      if (stored.from !== keys.space || typeof stored.root !== "string") return null;
      const root = fromBase64url(stored.root);
      const newKeys = await deriveKeys(root);
      if (newKeys.space !== stored.space) return null;
      return { root, keys: newKeys, stored: { ...stored, removed: Array.isArray(stored.removed) ? stored.removed : [] } };
    } catch {
      return null;
    }
  }

  private savePending(stored: StoredRekey): Promise<void> {
    return this.db.syncTransaction((sql) => setMeta(sql, REKEY_META, JSON.stringify(stored)));
  }

  private clearPending(): Promise<void> {
    return this.db.syncTransaction(async (sql) => {
      await sql.run("DELETE FROM sync_meta WHERE k=?", [REKEY_META]);
    });
  }

  /**
   * 移除馬上生效：伺服器把這幾台標成已移除，之後拒絕它們. 附上用舊同步金鑰算的證明與這台簽的聲明
   * （從舊空間換到這個新空間、留下這台、移除它們），它們收到時驗得過才清掉自己的同步金鑰
   */
  private async removeNow(keys: SyncKeys, pending: { keys: SyncKeys; stored: StoredRekey }, raw: RawDevices, remove: string[]): Promise<void> {
    const identity = this.device!.identity;
    const targets = raw.devices.filter((d) => remove.includes(d.id));
    const signed = await signStatement(identity, { v: 1, from: keys.space, to: pending.keys.space, keep: [identity.id], remove: targets.map((d) => d.id), boxes: {} });
    const body = { space: pending.keys.space, remove: await Promise.all(targets.map(async (d) => ({ id: d.id, proof: await removalProof(keys, d.id) }))), ...signed };
    try {
      this.rawDevices = await this.api.request<RawDevices>("POST", `/v1/spaces/${keys.space}/remove`, body, this.auth(keys));
    } catch (e) {
      await this.dropIfGone(e);
      throw this.cooldownOf(e) ?? e;
    }
    pending.stored.removed = [...new Set([...pending.stored.removed, ...targets.map((d) => d.id)])];
    await this.savePending(pending.stored);
  }

  /** 開始之後才出現的裝置（伺服器不該讓它加入）：不默默給它新的金鑰，放棄這次、請使用者重新確認 */
  private async checkExpected(raw: RawDevices, stored: StoredRekey): Promise<void> {
    const expected = stored.expected;
    if (!expected || raw.devices.every((d) => expected.includes(d.id))) return;
    await this.cancelRekey().catch(() => undefined);
    throw new SyncApiError(409, "裝置清單剛剛變了，請重新確認後再試", { state: "devices_changed" });
  }

  /** 換到一半的新空間已經不在（放棄太久被清掉、被另一台取代）：這台的紀錄也清掉，下次重新開始 */
  private async dropIfGone(e: unknown): Promise<void> {
    if (e instanceof SyncApiError && (e.state === "rekey_conflict" || (e.status === 404 && !e.state))) await this.clearPending();
  }

  /** 換金鑰的 3～5 步：接著複製、補上這段時間的變更、送出換金鑰、改用新的金鑰 */
  private async finishRekey(
    keys: SyncKeys,
    pending: { root: Uint8Array; keys: SyncKeys; stored: StoredRekey },
    onProgress?: (step: RekeyProgress) => void,
  ): Promise<Uint8Array> {
    const { identity } = this.device!;
    const newKeys = pending.keys;
    let rekeySent = false;
    let copied: Map<string, { env: Envelope; seq: number }>;
    try {
      const raw0 = await this.fetchDevices(keys);
      await this.checkExpected(raw0, pending.stored);
      const self0 = raw0.devices.find((d) => d.id === identity.id);
      const selfLabel = (self0 && (await openLabel(keys, self0, self0.label))) ?? this.device!.label();
      // 在新空間登記這台（已經登記過時伺服器照樣回清單）
      await this.api.request(
        "POST",
        `/v1/spaces/${newKeys.space}/devices`,
        { id: identity.id, signPub: identity.signPub, boxPub: identity.boxPub, label: await sealLabel(newKeys, identity, selfLabel) },
        { device: identity, token: newKeys.token },
      );
      onProgress?.({ step: "fetch" });
      const old = await this.fetchRemote(keys, 0);
      // 新空間已經有的（之前幾天送過的）：版本一樣的不重送
      copied = (await this.fetchRemote(newKeys, 0)).remote;
      let since = old.since;
      for (let round = 0; ; round++) {
        await this.copyMissing(newKeys, old.remote, copied, pending.stored, onProgress);
        const raw = await this.fetchDevices(keys);
        await this.checkExpected(raw, pending.stored);
        const keep: { id: string; label: string; box: string }[] = [];
        const removed: { id: string; proof: string | null }[] = [];
        for (const d of raw.devices) {
          if (d.id === identity.id) {
            keep.push({ id: d.id, label: await sealLabel(newKeys, identity, selfLabel), box: await sealRekeyBox(keys, pending.root, newKeys.space, identity) });
            continue;
          }
          const label = await openLabel(keys, d, d.label);
          if (label) keep.push({ id: d.id, label: await sealLabel(newKeys, d, label), box: await sealRekeyBox(keys, pending.root, newKeys.space, d) });
          else removed.push({ id: d.id, proof: null });
        }
        const boxes: Record<string, string> = {};
        for (const k of keep) boxes[k.id] = await boxHash(k.box);
        const signed = await signStatement(identity, { v: 1, from: keys.space, to: newKeys.space, keep: keep.map((k) => k.id), remove: removed.map((r) => r.id), boxes });
        onProgress?.({ step: "rekey" });
        rekeySent = true;
        try {
          await this.api.request(
            "POST",
            `/v1/spaces/${keys.space}/rekey`,
            { space: newKeys.space, token: newKeys.token, keep, remove: removed, seq: since, ...signed },
            this.auth(keys),
          );
          break;
        } catch (e) {
          // 這段時間舊空間又有新的寫入（別台照常在同步）：補送之後再試
          if (!(e instanceof SyncApiError && e.state === "rekey_behind") || round >= 5) throw e;
          rekeySent = false;
          const more = await this.fetchRemote(keys, since);
          for (const [name, item] of more.remote) old.remote.set(name, item);
          since = more.since;
        }
      }
    } catch (e) {
      if (e instanceof SyncApiError && e.state === "rekey_limit") {
        // 今天換金鑰的額度用完：停下來，隔天（UTC 日界）接著做
        const seconds = typeof e.detail.retryAfter === "number" && e.detail.retryAfter > 0 ? e.detail.retryAfter : 3600;
        pending.stored.resumeAt = this.now().getTime() + seconds * 1000;
        await this.savePending(pending.stored);
        throw new SyncRekeyPausedError(pending.stored.done, pending.stored.total, pending.stored.resumeAt);
      }
      // 送出換金鑰之後連不上或伺服器出錯：伺服器可能已經換好了. 先問舊空間，不確定時什麼都不動
      if (!(rekeySent && e instanceof SyncApiError && (e.status === 0 || e.status >= 500))) {
        await this.dropIfGone(e);
        throw this.cooldownOf(e) ?? e;
      }
      const outcome = await this.rekeyOutcome(keys, newKeys.space);
      if (outcome === "unknown") throw new SyncRekeyUnknownError();
      if (outcome === "not_done") throw e;
      copied = (await this.fetchRemote(newKeys, 0)).remote;
    }
    onProgress?.({ step: "switch" });
    // 這台對舊空間的同步狀態：版本和新空間的一樣的才記成已同步（別台這段時間的變更這台還沒取回的，之後照常取回）
    const before = await this.db.syncTransaction((sql) => loadState(sql));
    await this.switchTo(pending.root, newKeys);
    await this.db.syncTransaction(async (sql) => {
      for (const [name, { env, seq }] of copied) {
        const mine = before.get(name);
        if (mine && mine.v === env.v) await saveState(sql, name, mine.hash, seq, env.v);
      }
    });
    await this.sync();
    return pending.root;
  }

  /** 改用新的同步金鑰：存起來、清掉這台對舊空間的同步狀態（暫存的別台資料留著） */
  private async switchTo(root: Uint8Array, keys: SyncKeys): Promise<void> {
    await this.device!.onRootChanged(root);
    this.keys = Promise.resolve(keys);
    this.spaceReady = false;
    this.rawDevices = null;
    await this.db.syncTransaction(async (sql) => {
      await sql.run("DELETE FROM sync_state");
      await sql.run("DELETE FROM sync_meta WHERE k NOT IN ('last_sync', 'known_devices')");
      await setMeta(sql, "space", keys.space);
    });
  }

  /** 把舊空間的紀錄用新的金鑰重新加密送到新的空間（版本號不變）；回傳每一筆在新空間的狀態，換過去之後才記 */
  /** 換金鑰送出之後結果不明：舊空間說「搬到這個新空間」就是換好了；舊空間照常回答就是沒有換；問不到是不確定 */
  private async rekeyOutcome(oldKeys: SyncKeys, newSpace: string): Promise<"done" | "not_done" | "unknown"> {
    try {
      await this.api.request("GET", `/v1/spaces/${oldKeys.space}/devices`, undefined, this.auth(oldKeys));
      return "not_done";
    } catch (e) {
      if (e instanceof SyncApiError && e.status === 410 && e.state === "moved") return e.detail.space === newSpace ? "done" : "unknown";
      return "unknown";
    }
  }

  /** 被頻率限制（state: rate_limited）時照伺服器說的時間等一下再送同一個請求；等太久的停下來 */
  private async patiently<T>(send: () => Promise<T>, onWait?: (seconds: number) => void): Promise<T> {
    let waited = 0;
    for (;;) {
      try {
        return await send();
      } catch (e) {
        if (!(e instanceof SyncApiError && e.status === 429 && e.state === "rate_limited")) throw e;
        const seconds = typeof e.detail.retryAfter === "number" && e.detail.retryAfter > 0 ? e.detail.retryAfter : 60;
        waited += seconds * 1000;
        if (waited > MAX_RATE_WAIT_MS) throw e;
        onWait?.(seconds);
        await this.api.sleep(seconds * 1000);
      }
    }
  }

  /**
   * 把舊空間有、新空間還沒有（或版本比較舊）的紀錄用新的金鑰重新加密送過去（版本號不變），copied 跟著更新.
   * 資料多的時候會碰到自己的頻率限制：等時間窗過了接著送，不整個重來；換金鑰的每日額度用完時丟 rekey_limit
   */
  private async copyMissing(
    keys: SyncKeys,
    remote: Map<string, { env: Envelope; seq: number }>,
    copied: Map<string, { env: Envelope; seq: number }>,
    progress: StoredRekey,
    onProgress?: (step: RekeyProgress) => void,
  ): Promise<void> {
    const todo = [...remote.values()]
      .filter(({ env }) => copied.get(env.k)?.env.v !== env.v)
      .sort((a, b) => order(a.env.k) - order(b.env.k) || a.seq - b.seq);
    const total = remote.size;
    let done = total - todo.length;
    const report = async () => {
      progress.done = done;
      progress.total = total;
      progress.resumeAt = 0;
      await this.savePending(progress);
      onProgress?.({ step: "copy", done, total });
    };
    await report();
    for (let i = 0; i < todo.length; i += PUSH_BATCH) {
      const batch = todo.slice(i, i + PUSH_BATCH);
      const items = await Promise.all(
        batch.map(async ({ env }) => {
          const id = await recordId(keys, env.k);
          return { id, base: copied.get(env.k)?.seq ?? 0, blob: await seal(keys, id, env) };
        }),
      );
      const response = await this.patiently(
        () => this.api.request<{ applied: { id: string; seq: number }[]; conflicts: string[] }>("POST", `/v1/spaces/${keys.space}/changes`, { items }, this.auth(keys)),
        (seconds) => onProgress?.({ step: "wait", seconds }),
      );
      const seqById = new Map(response.applied.map((a) => [a.id, a.seq]));
      for (const [index, { env }] of batch.entries()) {
        const seq = seqById.get(items[index]!.id);
        if (seq === undefined) continue;
        copied.set(env.k, { env, seq });
        done++;
      }
      // 只有這台寫新的空間，不應該有衝突；有的話停下來，下次重新比對
      if (response.conflicts.length) throw new Error("換金鑰時新的空間的資料對不上，請再試一次");
      await report();
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
    // 換金鑰的聲明：要是這台記得的裝置簽的，而且這台在留下的名單、給這台的新金鑰就是簽過的那一份
    const statement = await this.checkStatement(e, oldKeys.space);
    if (!statement || statement.to !== newSpace || !statement.keep.includes(this.device!.identity.id) || statement.boxes[this.device!.identity.id] !== (await boxHash(box))) {
      throw new Error("同步金鑰已經換了，但無法確認是你的哪一台換的（這台不認得換金鑰的那台，或內容不對）。這台的資料保留；請用配對或新的復原碼重新加入。");
    }
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

  /**
   * 伺服器說這台已被移除：要有本機記得的裝置簽的聲明（這台在移除的名單、簽的那台沒有被移除），
   * 加上用舊同步金鑰算的證明，都對得上才清資料（伺服器、或只拿到復原碼的人騙不了這台清掉資料）
   */
  private async checkRemoved(e: SyncApiError): Promise<never> {
    const keys = await this.keys;
    const statement = await this.checkStatement(e, keys.space);
    if (
      this.device &&
      statement?.remove.includes(this.device.identity.id) &&
      (await verifyRemovalProof(keys, this.device.identity.id, e.detail.proof))
    ) {
      throw new SyncRemovedError();
    }
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
