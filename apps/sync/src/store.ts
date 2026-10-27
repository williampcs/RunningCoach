/**
 * 同步服務的儲存（規格 12.10）：每個同步空間只存加密後的紀錄，以及配對時暫放的公開金鑰與加密的金鑰.
 * 伺服器沒有解密用的金鑰；憑證只存雜湊；不存 IP 或任何請求的紀錄.
 */
import type { SqlDriver, SqlValue } from "@running-coach/core";

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS spaces (
    id          TEXT PRIMARY KEY,
    token_hash  TEXT NOT NULL,
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
    commitment  TEXT NOT NULL,
    old_pub     TEXT,
    nonce       TEXT,
    box         TEXT,
    expires_at  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS space_modes (
    space         TEXT PRIMARY KEY,
    devices_at    INTEGER NOT NULL,
    legacy_until  INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS devices (
    space         TEXT NOT NULL,
    id            TEXT NOT NULL,
    sign_pub      TEXT NOT NULL,
    box_pub       TEXT NOT NULL,
    label         TEXT NOT NULL,
    joined_at     INTEGER NOT NULL,
    last_seen_at  INTEGER NOT NULL,
    legacy        INTEGER NOT NULL DEFAULT 0,
    removed_at    INTEGER,
    proof         TEXT,
    box           TEXT,
    PRIMARY KEY (space, id)
  );
  CREATE TABLE IF NOT EXISTS moves (
    space      TEXT PRIMARY KEY,
    moved_to   TEXT NOT NULL,
    moved_at   INTEGER NOT NULL,
    signer     TEXT NOT NULL,
    statement  TEXT NOT NULL,
    signature  TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sig_nonces (
    nonce       TEXT PRIMARY KEY,
    expires_at  INTEGER NOT NULL
  );
`;

/** D1 的 batch 是一個交易；沒有 batch 的（Node 的 SQLite）用 BEGIN／COMMIT */
export interface SyncSqlDriver extends SqlDriver {
  batch?(statements: { sql: string; params: SqlValue[] }[]): Promise<void>;
}

/** 同步空間的裝置模式（規格 12.27）：devicesAt 起只接受登記過的裝置；legacyUntil 前用舊憑證登記的算「升級前就在同步」 */
export interface SpaceMode {
  devicesAt: number;
  legacyUntil: number;
}

export interface DeviceRow {
  id: string;
  signPub: string;
  boxPub: string;
  /** 以同步金鑰加密的名稱與平台，伺服器看不到 */
  label: string;
  joinedAt: number;
  lastSeenAt: number;
  legacy: boolean;
  removedAt: number | null;
  /** 移除的那台留下的證明（舊同步金鑰的 HMAC），被移除的裝置用來確認不是伺服器亂說 */
  proof: string | null;
  /** 換金鑰後，給這台的新同步金鑰（加密的） */
  box: string | null;
}

export interface RekeyPlan {
  newSpace: string;
  /** 換金鑰的那台：它已經先建立新的空間、登記自己、把資料送過去 */
  caller: string;
  keep: { id: string; label: string; box: string }[];
  remove: { id: string; proof: string | null }[];
  /** 換金鑰的那台簽的聲明（舊空間、新空間、留下與移除的裝置、每份新金鑰的雜湊），收到的裝置用來確認 */
  statement: string;
  signature: string;
}

/** 換過金鑰的空間：搬到哪裡、誰換的、簽過的聲明 */
export interface MoveRow {
  movedTo: string;
  signer: string;
  statement: string;
  signature: string;
}

export interface SyncRecord {
  id: string;
  seq: number;
  blob: string;
}

export interface PairSlot {
  newPub: string;
  /** 新裝置亂數的雜湊（承諾） */
  commitment: string;
  oldPub: string | null;
  /** 新裝置在收到 oldPub 之後才公開的亂數 */
  nonce: string | null;
  box: string | null;
}

export class SyncStore {
  constructor(
    private readonly driver: SyncSqlDriver,
    readonly now: () => Date = () => new Date(),
  ) {}

  /** 全部成功或全部不做 */
  private async batch(statements: { sql: string; params: SqlValue[] }[]): Promise<void> {
    if (this.driver.batch) return this.driver.batch(statements);
    await this.driver.exec("BEGIN");
    try {
      for (const s of statements) await this.driver.run(s.sql, s.params);
      await this.driver.exec("COMMIT");
    } catch (e) {
      await this.driver.exec("ROLLBACK");
      throw e;
    }
  }

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

  /** 刪除空間；換金鑰之前的舊空間（只剩「搬到哪裡」與裝置紀錄）也一起刪掉 */
  async deleteSpace(space: string): Promise<void> {
    let target = space;
    for (let hop = 0; hop < 50; hop++) {
      const before = (await this.driver.all("SELECT space FROM moves WHERE moved_to=?", [target]))[0];
      await this.deleteOne(target);
      if (!before) return;
      target = String(before.space);
    }
  }

  private async deleteOne(space: string): Promise<void> {
    await this.batch(
      ["DELETE FROM records WHERE space=?", "DELETE FROM devices WHERE space=?", "DELETE FROM space_modes WHERE space=?", "DELETE FROM moves WHERE space=?", "DELETE FROM spaces WHERE id=?"].map(
        (sql) => ({ sql, params: [space] }),
      ),
    );
  }

  // -------------------------------------------------------------------------
  // 裝置（規格 12.27）
  // -------------------------------------------------------------------------

  async spaceMode(space: string): Promise<SpaceMode | null> {
    const row = (await this.driver.all("SELECT devices_at, legacy_until FROM space_modes WHERE space=?", [space]))[0];
    return row ? { devicesAt: Number(row.devices_at), legacyUntil: Number(row.legacy_until) } : null;
  }

  /** 已經是裝置模式時不變 */
  async setSpaceMode(space: string, mode: SpaceMode): Promise<void> {
    await this.driver.run("INSERT INTO space_modes (space, devices_at, legacy_until) VALUES (?, ?, ?) ON CONFLICT(space) DO NOTHING", [
      space,
      mode.devicesAt,
      mode.legacyUntil,
    ]);
  }

  /** 換過金鑰的空間：搬到哪裡 */
  async movedTo(space: string): Promise<string | null> {
    return (await this.move(space))?.movedTo ?? null;
  }

  async move(space: string): Promise<MoveRow | null> {
    const row = (await this.driver.all("SELECT moved_to, signer, statement, signature FROM moves WHERE space=?", [space]))[0];
    return row ? { movedTo: String(row.moved_to), signer: String(row.signer), statement: String(row.statement), signature: String(row.signature) } : null;
  }

  /** 這個空間是換金鑰搬進來的：搬進來的時間（毫秒）；不是的話 null */
  async movedInAt(space: string): Promise<number | null> {
    const row = (await this.driver.all("SELECT MAX(moved_at) AS t FROM moves WHERE moved_to=?", [space]))[0];
    return row?.t === null || row?.t === undefined ? null : Number(row.t);
  }

  /** 空間建立的時間（毫秒） */
  async spaceCreatedAt(space: string): Promise<number | null> {
    const row = (await this.driver.all("SELECT created_at FROM spaces WHERE id=?", [space]))[0];
    return row ? Date.parse(String(row.created_at)) : null;
  }

  private static device(r: Record<string, unknown>): DeviceRow {
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return {
      id: String(r.id),
      signPub: String(r.sign_pub),
      boxPub: String(r.box_pub),
      label: String(r.label),
      joinedAt: Number(r.joined_at),
      lastSeenAt: Number(r.last_seen_at),
      legacy: Number(r.legacy) === 1,
      removedAt: r.removed_at === null || r.removed_at === undefined ? null : Number(r.removed_at),
      proof: text(r.proof),
      box: text(r.box),
    };
  }

  async devices(space: string): Promise<DeviceRow[]> {
    const rows = await this.driver.all("SELECT * FROM devices WHERE space=? ORDER BY joined_at, id", [space]);
    return rows.map((r) => SyncStore.device(r));
  }

  async device(space: string, id: string): Promise<DeviceRow | null> {
    const row = (await this.driver.all("SELECT * FROM devices WHERE space=? AND id=?", [space, id]))[0];
    return row ? SyncStore.device(row) : null;
  }

  /** 回傳是否新增（同一個 id 已經存在時不動） */
  async addDevice(space: string, d: { id: string; signPub: string; boxPub: string; label: string; legacy: boolean }): Promise<boolean> {
    const now = this.now().getTime();
    const result = await this.driver.run(
      "INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(space, id) DO NOTHING",
      [space, d.id, d.signPub, d.boxPub, d.label, now, now, d.legacy ? 1 : 0],
    );
    return result.changes > 0;
  }

  /** 最後同步的時間：一分鐘內只寫一次 */
  async touchDevice(space: string, id: string): Promise<void> {
    const now = this.now().getTime();
    await this.driver.run("UPDATE devices SET last_seen_at=? WHERE space=? AND id=? AND last_seen_at<?", [now, space, id, now - 60_000]);
  }

  async setLabel(space: string, id: string, label: string): Promise<boolean> {
    return (await this.driver.run("UPDATE devices SET label=? WHERE space=? AND id=? AND removed_at IS NULL", [label, space, id])).changes > 0;
  }

  /** 這台自己停止同步 */
  async deleteDevice(space: string, id: string): Promise<void> {
    await this.driver.run("DELETE FROM devices WHERE space=? AND id=?", [space, id]);
  }

  /** 簽章的一次性亂數：用過的回傳 false. 過期的偶爾清掉 */
  async useNonce(nonce: string, expiresAt: number): Promise<boolean> {
    const now = this.now().getTime();
    if (Math.random() < 0.02) await this.driver.run("DELETE FROM sig_nonces WHERE expires_at<?", [now]);
    const result = await this.driver.run("INSERT INTO sig_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT(nonce) DO NOTHING", [nonce, expiresAt]);
    return result.changes > 0;
  }

  /**
   * 換金鑰（一個交易）. 新的空間由換金鑰的那台先建立、登記自己、把重新加密的資料送過去；這裡才把
   * 留下的裝置搬過去（加入時間不變；換金鑰的那台在新空間的那一列換成舊空間的）、給留下的每台存一份加密的新同步金鑰、
   * 標記移除的、刪掉舊空間的紀錄. 舊空間只留裝置與「搬到哪裡」. 舊空間已經搬過時整個失敗
   */
  async rekey(space: string, plan: RekeyPlan): Promise<void> {
    const now = this.now().getTime();
    const stamp = this.now().toISOString();
    await this.batch([
      {
        sql: "INSERT INTO moves (space, moved_to, moved_at, signer, statement, signature) VALUES (?, ?, ?, ?, ?, ?)",
        params: [space, plan.newSpace, now, plan.caller, plan.statement, plan.signature],
      },
      { sql: "DELETE FROM devices WHERE space=?", params: [plan.newSpace] },
      ...plan.keep.flatMap((k) => [
        {
          sql:
            "INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy)" +
            " SELECT ?, id, sign_pub, box_pub, ?, joined_at, last_seen_at, legacy FROM devices WHERE space=? AND id=? AND removed_at IS NULL",
          params: [plan.newSpace, k.label, space, k.id],
        },
        { sql: "UPDATE devices SET box=? WHERE space=? AND id=?", params: [k.box, space, k.id] },
      ]),
      ...plan.remove.map((r) => ({ sql: "UPDATE devices SET removed_at=?, proof=? WHERE space=? AND id=?", params: [now, r.proof, space, r.id] as SqlValue[] })),
      { sql: "DELETE FROM records WHERE space=?", params: [space] },
      { sql: "UPDATE spaces SET bytes=0, updated_at=? WHERE id=?", params: [stamp, space] },
    ]);
  }

  /** since 之後（不含）的紀錄，依序號排序 */
  async changes(space: string, since: number, limit: number): Promise<SyncRecord[]> {
    const rows = await this.driver.all("SELECT id, seq, blob FROM records WHERE space=? AND seq>? ORDER BY seq LIMIT ?", [space, since, limit]);
    return rows.map((r) => ({ id: String(r.id), seq: Number(r.seq), blob: String(r.blob) }));
  }

  /** 全部同步空間的數量與大小：限制整個服務的用量 */
  async totals(): Promise<{ spaces: number; bytes: number }> {
    // 換過金鑰的舊空間（只剩很小的紀錄）不算進空間的數量
    const row = (await this.driver.all("SELECT (SELECT COUNT(*) FROM spaces WHERE id NOT IN (SELECT space FROM moves)) AS n, COALESCE(SUM(bytes), 0) AS b FROM spaces"))[0];
    return { spaces: Number(row?.n ?? 0), bytes: Number(row?.b ?? 0) };
  }

  async activeSlots(): Promise<number> {
    return Number((await this.driver.all("SELECT COUNT(*) AS n FROM pair_slots WHERE expires_at>=?", [this.now().getTime()]))[0]?.n ?? 0);
  }

  /**
   * 寫入一筆：只有伺服器上的版本還是 base（客戶端上次看到的序號；新的一筆是 0）時才寫入，
   * 否則是衝突，客戶端要先取回別台的變更。回傳新的序號，衝突時是 null
   */
  async put(space: string, id: string, base: number, blob: string): Promise<number | null> {
    const current = (await this.driver.all("SELECT seq, LENGTH(blob) AS size FROM records WHERE space=? AND id=?", [space, id]))[0];
    if ((current ? Number(current.seq) : 0) !== base) return null;
    // 配序號和寫入在同一個 SQL 敘述裡完成（這個空間目前最大的序號加一）：
    // 同時有好幾台在送出時，別台取回的序號不會跳過還沒寫入的那筆.
    // 寫入時再檢查一次版本：同時有兩台寫同一筆時，後到的會失敗
    const written = (
      await this.driver.all(
        "INSERT INTO records (space, id, seq, blob) VALUES (?, ?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM records WHERE space=?), ?)" +
          " ON CONFLICT(space, id) DO UPDATE SET seq=excluded.seq, blob=excluded.blob WHERE records.seq=? RETURNING seq",
        [space, id, space, blob, base],
      )
    )[0];
    if (!written) return null;
    await this.driver.run("UPDATE spaces SET bytes=bytes+?, updated_at=? WHERE id=?", [blob.length - Number(current?.size ?? 0), this.now().toISOString(), space]);
    return Number(written.seq);
  }

  // -------------------------------------------------------------------------
  // 配對：依序是新裝置的臨時公開金鑰與承諾、舊裝置的臨時公開金鑰、新裝置公開的亂數、
  // 加密後的同步金鑰；每一項只能寫一次，十分鐘後失效
  // -------------------------------------------------------------------------

  async createSlot(slot: string, newPub: string, commitment: string, ttlMs: number): Promise<boolean> {
    const now = this.now().getTime();
    await this.driver.run("DELETE FROM pair_slots WHERE expires_at<?", [now]);
    const result = await this.driver.run(
      "INSERT INTO pair_slots (slot, new_pub, commitment, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(slot) DO NOTHING",
      [slot, newPub, commitment, now + ttlMs],
    );
    return result.changes > 0;
  }

  async getSlot(slot: string): Promise<PairSlot | null> {
    const row = (
      await this.driver.all("SELECT new_pub, commitment, old_pub, nonce, box FROM pair_slots WHERE slot=? AND expires_at>=?", [slot, this.now().getTime()])
    )[0];
    if (!row) return null;
    const text = (v: unknown) => (v === null || v === undefined ? null : String(v));
    return { newPub: String(row.new_pub), commitment: String(row.commitment), oldPub: text(row.old_pub), nonce: text(row.nonce), box: text(row.box) };
  }

  /** 新裝置的亂數：舊裝置的公開金鑰要先到、只能設一次 */
  async setSlotNonce(slot: string, nonce: string): Promise<boolean> {
    const result = await this.driver.run(
      "UPDATE pair_slots SET nonce=? WHERE slot=? AND old_pub IS NOT NULL AND nonce IS NULL AND expires_at>=?",
      [nonce, slot, this.now().getTime()],
    );
    return result.changes > 0;
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

  /** 加密後的同步金鑰：新裝置的亂數要先公開、只能設一次 */
  async setSlotBox(slot: string, box: string): Promise<boolean> {
    const result = await this.driver.run(
      "UPDATE pair_slots SET box=? WHERE slot=? AND nonce IS NOT NULL AND box IS NULL AND expires_at>=?",
      [box, slot, this.now().getTime()],
    );
    return result.changes > 0;
  }

  async deleteSlot(slot: string): Promise<void> {
    await this.driver.run("DELETE FROM pair_slots WHERE slot=?", [slot]);
  }
}
