/**
 * 多裝置同步的流程（規格 12.10）：
 * 1. 取回伺服器上次之後的變更，解密，套用到這台（這台在上次同步後也改過的，比時間，新的為準）
 * 2. 和上次同步時的雜湊比，找出這台改過、新增或刪掉的，加密後送出
 * 3. 送出時附上「上次看到的序號」，別台在這中間改過同一筆時伺服器拒絕，回到第 1 步再來一次
 * 伺服器只看到加密後的資料與隨機的 id.
 */
import type { Db } from "../db";
import { nowIso } from "../dates";
import { deriveKeys, open, recordId, seal, type SyncKeys } from "./crypto";
import { applyEntity, hashOf, isAttached, modifiedOf, snapshot, type EntityData, type Snapshot, type Sql } from "./entities";

const DELETED = "deleted";
const PUSH_BATCH = 100;
const MAX_ROUNDS = 4;

/** 伺服器上的一筆：解密後是 { k: 名稱, m: 修改時間, d: 內容或 null（刪除） } */
interface Envelope {
  k: string;
  m: string;
  d: EntityData | null;
}

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
    if (!response.ok) throw new SyncApiError(response.status, typeof json.error === "string" ? json.error : `同步服務回應 ${response.status}`);
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

  /** 建立同步空間（第一台）或確認憑證（之後的裝置）；已存在時回傳 false */
  async ensureSpace(): Promise<boolean> {
    const keys = await this.keys;
    const { created } = await this.api.request<{ created: boolean }>("PUT", `/v1/spaces/${keys.space}`, undefined, keys.token);
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
    return this.db.syncTransaction(async (sql) => {
      await sql.run("DELETE FROM sync_state");
      await sql.run("DELETE FROM sync_pending");
      await sql.run("DELETE FROM sync_meta");
    });
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
    if (!this.spaceReady) await this.ensureSpace();
    const result: SyncResult = { received: 0, sent: 0, pending: 0, at: nowIso(this.now()) };
    for (let round = 0; round < MAX_ROUNDS; round++) {
      result.received += await this.pull(keys);
      const { sent, conflicts } = await this.push(keys);
      result.sent += sent;
      if (!conflicts) break;
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
      const page = await this.api.request<{ items: { id: string; seq: number; blob: string }[]; latest: number; more: boolean }>(
        "GET",
        `/v1/spaces/${keys.space}/changes?since=${since}`,
        undefined,
        keys.token,
      );
      for (const item of page.items) {
        const env = (await open(keys, item.id, item.blob)) as Envelope;
        // 名稱和 id 對不上：伺服器把別筆的內容放到這個 id 下
        if ((await recordId(keys, env.k)) !== item.id) throw new Error("同步資料的 id 不符，停止同步");
        remote.set(env.k, { env, seq: item.seq });
        since = Math.max(since, item.seq);
      }
      if (!page.more) {
        since = Math.max(since, page.latest);
        break;
      }
    }

    return this.db.syncTransaction(async (sql) => {
      let applied = 0;
      const snap = await snapshot(sql);
      const state = await loadState(sql);
      // 之前暫存的（例如那趟跑步這台當時還沒有）再試一次
      for (const row of await sql.all("SELECT key, data FROM sync_pending")) {
        const name = String(row.key);
        if (remote.has(name)) continue;
        if ((await applyEntity(sql, name, JSON.parse(String(row.data)) as EntityData, snap)) === "applied") {
          await sql.run("DELETE FROM sync_pending WHERE key=?", [name]);
          applied++;
        }
      }
      for (const [name, { env, seq }] of [...remote].sort((a, b) => order(a[0]) - order(b[0]) || a[1].seq - b[1].seq)) {
        const before = state.get(name);
        // 這台自己送出的那一版又被取回：不用再套用
        if (before && before.seq === seq) continue;
        const local = snap.data.get(name) ?? null;
        const localHash = local ? await hashOf(local) : null;
        const remoteHash = env.d ? await hashOf(env.d) : DELETED;
        // 這台在上次同步後改過、而且內容和伺服器上的不同：比時間，這台的比較新就保留（之後送出）
        const changedHere = before
          ? (localHash ?? DELETED) !== before.hash && !(localHash === null && isAttached(name))
          : localHash !== null;
        if (changedHere && (localHash ?? DELETED) !== remoteHash) {
          const mine = modifiedOf(local) ?? nowIso(this.now());
          if (mine > env.m) {
            await saveState(sql, name, before?.hash ?? "", seq);
            continue;
          }
        }
        const outcome = await applyEntity(sql, name, env.d, snap);
        if (outcome === "pending") await sql.run("INSERT OR REPLACE INTO sync_pending (key, data) VALUES (?, ?)", [name, JSON.stringify(env.d)]);
        else await sql.run("DELETE FROM sync_pending WHERE key=?", [name]);
        await saveState(sql, name, remoteHash, seq);
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
      const out: { name: string; data: EntityData | null; hash: string; base: number }[] = [];
      for (const [name, data] of snap.data) {
        const hash = await hashOf(data);
        const before = state.get(name);
        if (!before || before.hash !== hash) out.push({ name, data, hash, base: before?.seq ?? 0 });
      }
      for (const [name, before] of state) {
        if (!snap.data.has(name) && before.hash !== DELETED && !isAttached(name)) out.push({ name, data: null, hash: DELETED, base: before.seq });
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
          const env: Envelope = { k: o.name, m: modifiedOf(o.data) ?? nowIso(this.now()), d: o.data };
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
            await saveState(sql, o.name, o.hash, seq);
            sent++;
          }
        }
      });
      if (response.conflicts.length) conflicts = true;
    }
    return { sent, conflicts };
  }
}

/** 套用的順序：課表要在課之前 */
const order = (name: string) => (name.startsWith("pl:") ? 0 : name.startsWith("ps:") ? 2 : 1);

async function loadState(sql: Sql): Promise<Map<string, { hash: string; seq: number }>> {
  const rows = await sql.all("SELECT key, hash, seq FROM sync_state");
  return new Map(rows.map((r) => [String(r.key), { hash: String(r.hash), seq: Number(r.seq) }]));
}

async function saveState(sql: Sql, name: string, hash: string, seq: number): Promise<void> {
  await sql.run("INSERT OR REPLACE INTO sync_state (key, hash, seq) VALUES (?, ?, ?)", [name, hash, seq]);
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
