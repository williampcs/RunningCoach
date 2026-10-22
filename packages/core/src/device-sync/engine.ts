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
import { deriveKeys, open, recordId, seal, type SyncKeys } from "./crypto";
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
  413: "同步的資料超過上限",
  503: "同步服務暫時無法使用（可能已滿），請稍後再試",
};

export class SyncApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 同步服務的 HTTP 介面（apps/sync） */
export class SyncApi {
  private readonly base: string;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.base = baseUrl.replace(/\/+$/, "");
  }

  async request<T>(method: string, path: string, body?: unknown, token?: string): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new SyncApiError(0, `連不上同步服務：${e instanceof Error ? e.message : String(e)}`);
    }
    const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    // 錯誤訊息用這裡寫好的，不顯示伺服器傳來的文字（伺服器不受信任）
    if (!response.ok) throw new SyncApiError(response.status, ERROR_TEXT[response.status] ?? `同步服務發生錯誤（${response.status}）`);
    return json as T;
  }
}

export interface SyncResult {
  /** 從別台套用的筆數 */
  received: number;
  /** 送出的筆數 */
  sent: number;
  /** 還在等這台有對應跑步的筆數 */
  pending: number;
  at: string;
}

export class SyncEngine {
  private keys: Promise<SyncKeys>;
  private spaceReady = false;
  private running: Promise<SyncResult> | null = null;

  constructor(
    private readonly db: Db,
    private readonly api: SyncApi,
    root: Uint8Array,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.keys = deriveKeys(root);
  }

  /**
   * 「開始同步」的第一台：建立同步空間；已存在時回傳 false.
   * 之後的同步只確認憑證，空間不存在（在別台刪除了）時不會再建立
   */
  async ensureSpace(): Promise<boolean> {
    const keys = await this.keys;
    const { created } = await this.api.request<{ created: boolean }>("PUT", `/v1/spaces/${keys.space}?create=1`, undefined, keys.token);
    this.spaceReady = true;
    return created;
  }

  /** 刪除伺服器上的整個同步空間（這台的資料不動），並清掉這台的同步狀態 */
  async deleteRemote(): Promise<void> {
    const keys = await this.keys;
    await this.api.request("DELETE", `/v1/spaces/${keys.space}`, undefined, keys.token);
    await this.forget();
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

  private async run(): Promise<SyncResult> {
    const keys = await this.keys;
    await this.db.syncTransaction(async (sql) => {
      // 這台記得雲端已經刪除：不再連線（即使有人用同一把金鑰把空間建回來，也不會把資料送過去）
      if ((await getMeta(sql, "gone")) === keys.space) throw new SyncApiError(404, "雲端的同步資料已經刪除");
      // 上次同步的是另一組金鑰（例如清除設定後重新開始）：舊的同步狀態不適用
      const space = await getMeta(sql, "space");
      if (space !== null && space !== keys.space) await clearState(sql);
      await setMeta(sql, "space", keys.space);
    });
    const result: SyncResult = { received: 0, sent: 0, pending: 0, at: nowIso(this.now()) };
    try {
      if (!this.spaceReady) {
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
    result.pending = Number(
      (await this.db.syncTransaction((sql) => sql.all("SELECT COUNT(*) AS n FROM sync_pending")))[0]?.n ?? 0,
    );
    await this.db.syncTransaction((sql) => setMeta(sql, "last_sync", result.at));
    return result;
  }

  /** 取回並套用；回傳套用的筆數 */
  private async pull(keys: SyncKeys): Promise<number> {
    // 先把伺服器上的變更全部取回（依序號；同一筆只留最後一版）
    let since = Number((await this.db.syncTransaction((sql) => getMeta(sql, "last_seq"))) ?? 0);
    const remote = new Map<string, { env: Envelope; seq: number }>();
    for (;;) {
      const page = await this.api.request<{ items: { id: string; seq: number; blob: string }[]; more: boolean }>(
        "GET",
        `/v1/spaces/${keys.space}/changes?since=${since}`,
        undefined,
        keys.token,
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
        keys.token,
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
