/**
 * 同步服務的儲存（規格 12.10）：每個同步空間只存加密後的紀錄，以及配對時暫放的公開金鑰與加密的金鑰.
 * 伺服器沒有解密用的金鑰；憑證只存雜湊；不存 IP 或任何請求的紀錄.
 */
import type { SqlDriver } from "@running-coach/core";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spaces (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL,
    seq         INTEGER NOT NULL DEFAULT 0,
    bytes       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS records (
    space  TEXT NOT NULL,
    id     TEXT NOT NULL,
    seq    INTEGER NOT NULL,
    blob   TEXT NOT NULL,
    PRIMARY KEY (space, id)
  );
  CREATE INDEX IF NOT EXISTS records_seq ON records (space, seq);
  CREATE TABLE IF NOT EXISTS pair_slots (
    slot        TEXT PRIMARY KEY,
    new_pub     TEXT NOT NULL,
    old_pub     TEXT,
    box         TEXT,
    expires_at  INTEGER NOT NULL
  );
`;

export interface SyncRecord {
  id: string;
  seq: number;
  blob: string;
}

export interface PairSlot {
  newPub: string;
  oldPub: string | null;
  box: string | null;
}

export class SyncStore {
  constructor(
    private readonly driver: SqlDriver,
    private readonly now: () => Date = () => new Date(),
  ) {}

  init(): Promise<void> {
    return this.driver.exec(SCHEMA);
  }

  async spaceToken(space: string): Promise<string | null> {
    const row = (await this.driver.all("SELECT token_hash FROM spaces WHERE id=?", [space]))[0];
    return row ? String(row.token_hash) : null;
  }

  async spaceUsage(space: string): Promise<{ records: number; bytes: number }> {
    const row = (await this.driver.all("SELECT bytes, (SELECT COUNT(*) FROM records WHERE space=?) AS n FROM spaces WHERE id=?", [space, space]))[0];
    return { records: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /** 回傳是否新建立 */
  async createSpace(space: string, tokenHash: string): Promise<boolean> {
    const stamp = this.now().toISOString();
    const result = await this.driver.run(
      "INSERT INTO spaces (id, token_hash, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO NOTHING",
      [space, tokenHash, stamp, stamp],
    );
    return result.changes > 0;
  }

  async deleteSpace(space: string): Promise<void> {
    await this.driver.run("DELETE FROM records WHERE space=?", [space]);
    await this.driver.run("DELETE FROM spaces WHERE id=?", [space]);
  }

  /** since 之後（不含）的紀錄，依序號排序 */
  async changes(space: string, since: number, limit: number): Promise<{ items: SyncRecord[]; latest: number }> {
    const rows = await this.driver.all("SELECT id, seq, blob FROM records WHERE space=? AND seq>? ORDER BY seq LIMIT ?", [space, since, limit]);
    const latest = (await this.driver.all("SELECT seq FROM spaces WHERE id=?", [space]))[0];
    return {
      items: rows.map((r) => ({ id: String(r.id), seq: Number(r.seq), blob: String(r.blob) })),
      latest: Number(latest?.seq ?? 0),
    };
  }

  /**
   * 寫入一筆：只有伺服器上的版本還是 base（客戶端上次看到的序號；新的一筆是 0）時才寫入，
   * 否則是衝突，客戶端要先取回別台的變更。回傳新的序號，衝突時是 null
   */
  async put(space: string, id: string, base: number, blob: string): Promise<number | null> {
    const current = (await this.driver.all("SELECT seq, LENGTH(blob) AS size FROM records WHERE space=? AND id=?", [space, id]))[0];
    if ((current ? Number(current.seq) : 0) !== base) return null;
    const next = (await this.driver.all("UPDATE spaces SET seq=seq+1, updated_at=? WHERE id=? RETURNING seq", [this.now().toISOString(), space]))[0];
    const seq = Number(next?.seq);
    // 寫入時再檢查一次版本：同時有兩台寫同一筆時，後到的會失敗
    const written = await this.driver.run(
      "INSERT INTO records (space, id, seq, blob) VALUES (?, ?, ?, ?) ON CONFLICT(space, id) DO UPDATE SET seq=excluded.seq, blob=excluded.blob WHERE records.seq=?",
      [space, id, seq, blob, base],
    );
    if (written.changes === 0) return null;
    await this.driver.run("UPDATE spaces SET bytes=bytes+? WHERE id=?", [blob.length - Number(current?.size ?? 0), space]);
    return seq;
  }

  // -------------------------------------------------------------------------
  // 配對：新裝置的臨時公開金鑰、舊裝置的臨時公開金鑰與加密後的同步金鑰，十分鐘後失效
  // -------------------------------------------------------------------------

  async createSlot(slot: string, newPub: string, ttlMs: number): Promise<boolean> {
    const now = this.now().getTime();
    await this.driver.run("DELETE FROM pair_slots WHERE expires_at<?", [now]);
    const result = await this.driver.run(
      "INSERT INTO pair_slots (slot, new_pub, expires_at) VALUES (?, ?, ?) ON CONFLICT(slot) DO NOTHING",
      [slot, newPub, now + ttlMs],
    );
    return result.changes > 0;
  }

  async getSlot(slot: string): Promise<PairSlot | null> {
    const row = (await this.driver.all("SELECT new_pub, old_pub, box FROM pair_slots WHERE slot=? AND expires_at>=?", [slot, this.now().getTime()]))[0];
    if (!row) return null;
    return { newPub: String(row.new_pub), oldPub: row.old_pub === null ? null : String(row.old_pub), box: row.box === null ? null : String(row.box) };
  }

  /** 舊裝置的公開金鑰：只能設一次 */
  async setSlotHello(slot: string, oldPub: string): Promise<boolean> {
    const result = await this.driver.run("UPDATE pair_slots SET old_pub=? WHERE slot=? AND old_pub IS NULL AND expires_at>=?", [
      oldPub,
      slot,
      this.now().getTime(),
    ]);
    return result.changes > 0;
  }

  /** 加密後的同步金鑰：舊裝置的公開金鑰要先到、只能設一次 */
  async setSlotBox(slot: string, box: string): Promise<boolean> {
    const result = await this.driver.run(
      "UPDATE pair_slots SET box=? WHERE slot=? AND old_pub IS NOT NULL AND box IS NULL AND expires_at>=?",
      [box, slot, this.now().getTime()],
    );
    return result.changes > 0;
  }

  async deleteSlot(slot: string): Promise<void> {
    await this.driver.run("DELETE FROM pair_slots WHERE slot=?", [slot]);
  }
}
