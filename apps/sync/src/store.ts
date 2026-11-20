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
    updated_at  TEXT NOT NULL,
    rekey_from  TEXT,
    network     TEXT,
    network_at  INTEGER,
    progress_at INTEGER,
    rekey_by    TEXT,
    handoff     TEXT
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
    removed_by    TEXT,
    removal_statement  TEXT,
    removal_signature  TEXT,
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

/**
 * 每筆紀錄除了內容之外，在資料庫裡的固定額外（id、序號、兩個索引）：空間的大小把它算進去，
 * 很多筆很小的紀錄也不會超過資料庫的容量
 */
export const RECORD_OVERHEAD = 200;

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
  /** 換金鑰完成之前就先移除的（規格 12.10「移除馬上生效」）：移除的那台與它簽的聲明 */
  removal: { signer: string; statement: string; signature: string } | null;
}

export interface RekeyPlan {
  newSpace: string;
  /** 新空間已經有舊空間到這個序號的資料：舊空間在這之後又有新的寫入時整個失敗（切換時不漏資料）；null 不檢查（舊版的用戶端） */
  copiedSeq?: number | null;
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

  async init(): Promise<void> {
    await this.driver.exec(SCHEMA);
    // 之前建的資料表沒有的欄：換金鑰的新空間從哪個空間換來（rekey_from）、建立者的網段的雜湊（network）、
    // 換到一半的新空間最後一次有進度的時間（progress_at）、換金鑰完成前先移除的那台的聲明（removed_by 等）
    for (const [table, column, type] of [
      ["spaces", "rekey_from", "TEXT"],
      ["spaces", "network", "TEXT"],
      ["spaces", "network_at", "INTEGER"],
      ["spaces", "progress_at", "INTEGER"],
      ["spaces", "rekey_by", "TEXT"],
      ["spaces", "handoff", "TEXT"],
      ["devices", "removed_by", "TEXT"],
      ["devices", "removal_statement", "TEXT"],
      ["devices", "removal_signature", "TEXT"],
    ]) {
      const has = async () => (await this.driver.all(`PRAGMA table_info(${table})`)).some((c) => String(c.name) === column);
      if (await has()) continue;
      try {
        await this.driver.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      } catch (e) {
        // 兩個執行個體同時加：另一個已經加好了就沒事
        if (!(await has())) throw e;
      }
    }
    await this.driver.exec("CREATE INDEX IF NOT EXISTS spaces_network ON spaces (network)");
  }

  async spaceToken(space: string): Promise<string | null> {
    const row = (await this.driver.all("SELECT token_hash FROM spaces WHERE id=?", [space]))[0];
    return row ? String(row.token_hash) : null;
  }

  async spaceUsage(space: string): Promise<{ records: number; bytes: number }> {
    const row = (await this.driver.all("SELECT bytes, (SELECT COUNT(*) FROM records WHERE space=?) AS n FROM spaces WHERE id=?", [space, space]))[0];
    return { records: Number(row?.n ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /**
   * 回傳是否新建立. maxSpaces：整個服務最多幾個空間（換過金鑰的舊空間不算）；null 表示不限.
   * rekeyFrom：換金鑰建立的新空間，從哪個空間換來（呼叫的人已經確認過）. 那個空間還沒有別的換到一半的新空間時才建立，
   * 不受空間數限制（換金鑰是一換一）；已經有一個換到一半的時不建立（接著做那一個，或先用 abandonPendingRekeys 清掉）.
   * 這些條件與寫入在同一個敘述裡，並行時不會一起通過. 已經存在、或條件不符時回傳 false.
   * network：建立者的網段的代碼（同一個網段建立的空間有總容量上限），記下的時間是 network_at；
   * 換金鑰的新空間沿用舊空間的代碼與記下的時間（忽略這裡給的），保存期限不會因為換金鑰延長
   */
  async createSpace(
    space: string,
    tokenHash: string,
    maxSpaces: number | null = null,
    rekeyFrom: string | null = null,
    network: string | null = null,
    /** 換金鑰的新空間：開始換金鑰的那台（舊空間裡的裝置 id）；只有它能登記到新空間、送複製 */
    rekeyBy: string | null = null,
  ): Promise<boolean> {
    const stamp = this.now().toISOString();
    const result = await this.driver.run(
      "INSERT INTO spaces (id, token_hash, created_at, updated_at, rekey_from, progress_at, network, network_at)" +
        " SELECT ?, ?, ?, ?, ?, CASE WHEN ? IS NULL THEN NULL ELSE ? END, CASE WHEN ? IS NULL THEN ? ELSE (SELECT network FROM spaces WHERE id = ?) END," +
        " CASE WHEN ? IS NULL THEN (CASE WHEN ? IS NULL THEN NULL ELSE ? END) ELSE (SELECT network_at FROM spaces WHERE id = ?) END" +
        " WHERE (? IS NOT NULL AND NOT EXISTS (SELECT 1 FROM spaces WHERE rekey_from = ? AND id NOT IN (SELECT moved_to FROM moves)))" +
        " OR (? IS NULL AND (? OR (SELECT COUNT(*) FROM spaces WHERE id NOT IN (SELECT space FROM moves)) < ?)) ON CONFLICT(id) DO NOTHING",
      [
        space,
        tokenHash,
        stamp,
        stamp,
        rekeyFrom,
        rekeyFrom,
        this.now().getTime(),
        rekeyFrom,
        network,
        rekeyFrom,
        rekeyFrom,
        network,
        this.now().getTime(),
        rekeyFrom,
        rekeyFrom,
        rekeyFrom,
        rekeyFrom,
        maxSpaces === null ? 1 : 0,
        maxSpaces ?? 0,
      ],
    );
    if (result.changes > 0 && rekeyFrom !== null && rekeyBy !== null) await this.driver.run("UPDATE spaces SET rekey_by=? WHERE id=?", [rekeyBy, space]);
    return result.changes > 0;
  }

  /** 換到一半的新空間最後一次有進度的時間（毫秒；沒有記下時是建立的時間） */
  async lastProgress(space: string): Promise<number> {
    const row = (await this.driver.all("SELECT progress_at, created_at FROM spaces WHERE id=?", [space]))[0];
    if (!row) return 0;
    return row.progress_at === null || row.progress_at === undefined ? Date.parse(String(row.created_at)) : Number(row.progress_at);
  }

  /** 換到一半的新空間是哪一台開始的（舊空間裡的裝置 id）；不是換到一半的新空間、或沒有記下時 null */
  async rekeyBy(space: string): Promise<string | null> {
    const row = (
      await this.driver.all("SELECT rekey_by FROM spaces WHERE id=? AND rekey_from IS NOT NULL AND id NOT IN (SELECT moved_to FROM moves)", [space])
    )[0];
    return row?.rekey_by === null || row?.rekey_by === undefined ? null : String(row.rekey_by);
  }

  /** 換到一半的新空間的接手資訊（以新的同步金鑰加密，伺服器看不到）；只有換到一半時能寫 */
  async setHandoff(space: string, handoff: string): Promise<boolean> {
    return (
      (await this.driver.run("UPDATE spaces SET handoff=? WHERE id=? AND rekey_from IS NOT NULL AND id NOT IN (SELECT moved_to FROM moves)", [handoff, space])).changes > 0
    );
  }

  async handoff(space: string): Promise<string | null> {
    const row = (await this.driver.all("SELECT handoff FROM spaces WHERE id=? AND rekey_from IS NOT NULL AND id NOT IN (SELECT moved_to FROM moves)", [space]))[0];
    return row?.handoff === null || row?.handoff === undefined ? null : String(row.handoff);
  }

  /** 這幾筆 id 在這個空間已經有的內容長度（換金鑰的複製算新增的筆數與大小的差） */
  async existingSizes(space: string, ids: string[]): Promise<Map<string, number>> {
    if (!ids.length) return new Map();
    const rows = await this.driver.all("SELECT id, LENGTH(blob) AS size FROM records WHERE space=? AND id IN (SELECT value FROM json_each(?))", [space, JSON.stringify(ids)]);
    return new Map(rows.map((r) => [String(r.id), Number(r.size)]));
  }

  /**
   * 刪掉從 from 換金鑰、還沒搬進去的新空間（except 以外）：使用者明確重新開始時（?replace=1）.
   * 已經搬進去的（換好了）不動. 回傳刪掉幾個
   */
  async abandonPendingRekeys(from: string, except: string): Promise<number> {
    const rows = await this.driver.all(
      "SELECT id FROM spaces WHERE rekey_from = ? AND id <> ? AND id NOT IN (SELECT moved_to FROM moves)",
      [from, except],
    );
    for (const r of rows) await this.deleteOne(String(r.id));
    return rows.length;
  }

  /** 從 from 換金鑰、換到一半（還沒搬進去）的新空間；沒有的話 null */
  async pendingRekey(from: string): Promise<string | null> {
    const row = (await this.driver.all("SELECT id FROM spaces WHERE rekey_from = ? AND id NOT IN (SELECT moved_to FROM moves) LIMIT 1", [from]))[0];
    return row ? String(row.id) : null;
  }

  /** 換到一半的新空間有進度（複製了一批）：記下時間，放棄很久的才清得掉（purgeStaleRekeys） */
  async touchRekeyProgress(space: string): Promise<void> {
    await this.driver.run("UPDATE spaces SET progress_at=? WHERE id=? AND rekey_from IS NOT NULL", [this.now().getTime(), space]);
  }

  /**
   * 清掉換到一半、olderThanMs 沒有進度的新空間（使用者沒有再打開換金鑰的那台）. 舊空間照舊；
   * 已經移除的裝置維持移除. 回傳清掉幾個
   */
  async purgeStaleRekeys(olderThanMs: number): Promise<number> {
    const cutoff = this.now().getTime() - olderThanMs;
    const rows = await this.driver.all(
      "SELECT id FROM spaces WHERE rekey_from IS NOT NULL AND id NOT IN (SELECT moved_to FROM moves)" +
        " AND ((progress_at IS NULL AND created_at < ?) OR progress_at < ?)" +
        // 已經提早移除過裝置、開始的那台還在的不清（只能完成：清掉的話接手資訊沒了，舊空間又不能加入新的裝置）；
        // 開始的那台已經不在了的照常清
        " AND NOT (EXISTS (SELECT 1 FROM devices d WHERE d.space = spaces.rekey_from AND d.removed_at IS NOT NULL)" +
        " AND EXISTS (SELECT 1 FROM devices s WHERE s.space = spaces.rekey_from AND s.id = spaces.rekey_by AND s.removed_at IS NULL))",
      [new Date(cutoff).toISOString(), cutoff],
    );
    for (const r of rows) await this.deleteOne(String(r.id));
    return rows.length;
  }

  /** 這個空間（還沒換金鑰）有沒有先移除、等換金鑰完成的裝置 */
  async hasEarlyRemovals(space: string): Promise<boolean> {
    const row = (
      await this.driver.all(
        "SELECT 1 AS x FROM devices WHERE space=? AND removed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM moves WHERE moves.space=?) LIMIT 1",
        [space, space],
      )
    )[0];
    return row !== undefined;
  }

  /**
   * 換金鑰完成之前先移除裝置（每一台一個敘述，整批一個交易，只動還沒移除的）：之後伺服器拒絕它們的請求，它們下次連線拿到
   * 移除的證明與 signer 簽的聲明. 同一個敘述裡再確認 signer 自己還沒被移除、newSpace 仍是這個舊空間換到一半的新空間
   * （兩台同時互相移除時只有先到的生效）. 回傳這次移除了幾台
   */
  async removeDevices(
    space: string,
    newSpace: string,
    remove: { id: string; proof: string | null }[],
    removal: { signer: string; statement: string; signature: string },
  ): Promise<number> {
    const now = this.now().getTime();
    await this.batch(
      remove.map((r) => ({
        sql:
          "UPDATE devices SET removed_at=?, proof=?, removed_by=?, removal_statement=?, removal_signature=? WHERE space=? AND id=? AND removed_at IS NULL" +
          " AND EXISTS (SELECT 1 FROM devices s WHERE s.space=? AND s.id=? AND s.removed_at IS NULL)" +
          " AND EXISTS (SELECT 1 FROM spaces n WHERE n.id=? AND n.rekey_from=? AND n.id NOT IN (SELECT moved_to FROM moves))" +
          " AND NOT EXISTS (SELECT 1 FROM moves WHERE moves.space=?)",
        params: [now, r.proof, removal.signer, removal.statement, removal.signature, space, r.id, space, removal.signer, newSpace, space, space] as SqlValue[],
      })),
    );
    let changed = 0;
    for (const r of remove) {
      const d = await this.device(space, r.id);
      if (d?.removedAt === now && d.removal?.signer === removal.signer && d.removal.statement === removal.statement) changed++;
    }
    return changed;
  }

  /** 這個空間目前最大的序號（換金鑰時確認新空間已經有到這裡的資料） */
  async maxSeq(space: string): Promise<number> {
    return Number((await this.driver.all("SELECT COALESCE(MAX(seq), 0) AS s FROM records WHERE space=?", [space]))[0]?.s ?? 0);
  }

  /** 換金鑰建立的新空間從哪個空間換來；不是的話 null */
  async rekeyFrom(space: string): Promise<string | null> {
    const row = (await this.driver.all("SELECT rekey_from FROM spaces WHERE id=?", [space]))[0];
    return row?.rekey_from === null || row?.rekey_from === undefined ? null : String(row.rekey_from);
  }

  /** 只刪這一個空間（放棄換到一半的新空間），不沿著換金鑰往回刪 */
  async deleteSingleSpace(space: string): Promise<void> {
    await this.deleteOne(space);
  }

  /**
   * 送出之前先保留這次最多會用到的位元組：這個空間、整個服務、同一個網段建立的空間（maxNetworkBytes；null 不限，
   * 沒有記下網段的舊空間也不限）都還放得下時才保留（一個敘述，並行的送出不會一起超過）.
   * 換到一半的新空間也算進網段的總量（換金鑰的複製本身不受網段的上限，量不超過舊空間）.
   * 寫完之後用 releaseBytes 還回去（每筆寫入時已經加上實際的大小）
   */
  async reserveBytes(space: string, bytes: number, maxSpaceBytes: number, maxTotalBytes: number, maxNetworkBytes: number | null = null): Promise<boolean> {
    const result = await this.driver.run(
      "UPDATE spaces SET bytes = bytes + ? WHERE id = ? AND bytes + ? <= ? AND (SELECT COALESCE(SUM(bytes), 0) FROM spaces) + ? <= ?" +
        " AND (? IS NULL OR network IS NULL OR (SELECT COALESCE(SUM(s.bytes), 0) FROM spaces s WHERE s.network = spaces.network) + ? <= ?)",
      [bytes, space, bytes, maxSpaceBytes, bytes, maxTotalBytes, maxNetworkBytes, bytes, maxNetworkBytes],
    );
    return result.changes > 0;
  }

  /** 記下超過 olderThanMs 的網段代碼清成 NULL（那個空間不再算進網段的總容量）；回傳清了幾個 */
  async expireNetworks(olderThanMs: number): Promise<number> {
    const cutoff = this.now().getTime() - olderThanMs;
    return (await this.driver.run("UPDATE spaces SET network = NULL, network_at = NULL WHERE network IS NOT NULL AND (network_at IS NULL OR network_at < ?)", [cutoff])).changes;
  }

  /** 同一個網段建立的空間現在的總大小；這個空間沒有記下網段時 null */
  async networkUsage(space: string): Promise<number | null> {
    const row = (
      await this.driver.all(
        "SELECT s.network AS network, (SELECT COALESCE(SUM(t.bytes), 0) FROM spaces t WHERE t.network = s.network" +
          ") AS bytes FROM spaces s WHERE s.id = ?",
        [space],
      )
    )[0];
    return row?.network === null || row?.network === undefined ? null : Number(row.bytes);
  }

  async releaseBytes(space: string, bytes: number): Promise<void> {
    await this.driver.run("UPDATE spaces SET bytes = MAX(0, bytes - ?) WHERE id = ?", [bytes, space]);
  }

  /**
   * 清掉建立超過 olderThanMs、從來沒有紀錄也沒有登記裝置的空間（開始同步之後就沒再用的）；換金鑰的前後兩個空間與換到一半的新空間不動.
   * 回傳清掉幾個
   */
  async purgeEmptySpaces(olderThanMs: number): Promise<number> {
    const cutoff = new Date(this.now().getTime() - olderThanMs).toISOString();
    const removed = (
      await this.driver.run(
        "DELETE FROM spaces WHERE created_at < ? AND bytes = 0" +
          " AND NOT EXISTS (SELECT 1 FROM records WHERE records.space = spaces.id)" +
          " AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.space = spaces.id)" +
          " AND NOT EXISTS (SELECT 1 FROM moves WHERE moves.space = spaces.id OR moves.moved_to = spaces.id)" +
          // 換到一半的新空間（可能好幾天都還沒複製到東西）由 purgeStaleRekeys 依進度清
          " AND rekey_from IS NULL",
        [cutoff],
      )
    ).changes;
    if (removed > 0) await this.driver.run("DELETE FROM space_modes WHERE space NOT IN (SELECT id FROM spaces)");
    return removed;
  }

  /** 過期的配對碼與簽章的亂數 */
  async purgeExpired(): Promise<{ slots: number; nonces: number }> {
    const now = this.now().getTime();
    const slots = (await this.driver.run("DELETE FROM pair_slots WHERE expires_at<?", [now])).changes;
    const nonces = (await this.driver.run("DELETE FROM sig_nonces WHERE expires_at<?", [now])).changes;
    return { slots, nonces };
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
      removal:
        r.removed_by === null || r.removed_by === undefined
          ? null
          : { signer: String(r.removed_by), statement: String(r.removal_statement), signature: String(r.removal_signature) },
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
  /**
   * 回傳是否新增（同一個 id 已經存在時不動）. 檢查與寫入在同一個敘述：這個空間有換到一半的換金鑰、或有先移除還沒換金鑰的裝置時不新增.
   * 換到一半的新空間可以登記（登記要用新空間的憑證，也就是持有新的同步金鑰：開始的那台，或用新的復原碼接手的）
   */
  async addDevice(space: string, d: { id: string; signPub: string; boxPub: string; label: string; legacy: boolean }): Promise<boolean> {
    const now = this.now().getTime();
    const result = await this.driver.run(
      "INSERT INTO devices (space, id, sign_pub, box_pub, label, joined_at, last_seen_at, legacy) SELECT ?, ?, ?, ?, ?, ?, ?, ?" +
        " WHERE NOT EXISTS (SELECT 1 FROM spaces p WHERE p.rekey_from = ? AND p.id NOT IN (SELECT moved_to FROM moves))" +
        " AND NOT EXISTS (SELECT 1 FROM devices r WHERE r.space = ? AND r.removed_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM moves m WHERE m.space = ?))" +
        " ON CONFLICT(space, id) DO NOTHING",
      [space, d.id, d.signPub, d.boxPub, d.label, now, now, d.legacy ? 1 : 0, space, space, space],
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
      // 新的空間不在了（例如同一個舊空間又開了新的換金鑰）時 moved_to 是 NULL，整個交易失敗、舊空間不動
      // 舊空間在複製之後又有新的寫入（copiedSeq 之後）時也是 NULL：和寫入在同一個交易，不會漏掉
      {
        sql:
          "INSERT INTO moves (space, moved_to, moved_at, signer, statement, signature) VALUES (?, (SELECT id FROM spaces WHERE id=?" +
          " AND (? IS NULL OR (SELECT COALESCE(MAX(seq), 0) FROM records WHERE space=?) <= ?)), ?, ?, ?, ?)",
        params: [space, plan.newSpace, plan.copiedSeq ?? null, space, plan.copiedSeq ?? null, now, plan.caller, plan.statement, plan.signature],
      },
      // 新空間裡已經登記的：留下的那幾台換成舊空間的那一列（加入時間不變）；用新的復原碼接手的那台照舊留著
      { sql: "DELETE FROM devices WHERE space=? AND id IN (SELECT value FROM json_each(?))", params: [plan.newSpace, JSON.stringify(plan.keep.map((k) => k.id))] },
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
      { sql: "UPDATE spaces SET progress_at=NULL, handoff=NULL WHERE id=?", params: [plan.newSpace] },
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
   * 寫入一批（一次送出的全部）：查詢的次數固定（讀現在的版本 1 次、寫入每約 1 MB 1 次、更新大小 1 次），和筆數無關.
   * 每筆只有伺服器上的版本還是 base 時才寫入，否則是衝突；同一批裡重複的 id 只算第一筆.
   * 序號是這個空間目前最大的加上在這批裡的位置（同一個敘述裡算），會跳號但只會變大，取回時不會跳過還沒寫入的.
   * reserved：送出前 reserveBytes 保留的位元組，這裡換成實際的大小（新的一筆另外加上 RECORD_OVERHEAD）
   */
  async putMany(space: string, items: { id: string; base: number; blob: string }[], reserved = 0): Promise<{ applied: { id: string; seq: number }[]; conflicts: string[] }> {
    const conflicts: string[] = [];
    const seen = new Set<string>();
    const unique = items.filter((item) => {
      if (seen.has(item.id)) {
        conflicts.push(item.id);
        return false;
      }
      seen.add(item.id);
      return true;
    });
    const before = new Map<string, number>();
    if (unique.length) {
      const rows = await this.driver.all("SELECT id, LENGTH(blob) AS size FROM records WHERE space=? AND id IN (SELECT value FROM json_each(?))", [
        space,
        JSON.stringify(unique.map((i) => i.id)),
      ]);
      for (const r of rows) before.set(String(r.id), Number(r.size));
    }
    // 每個敘述帶的內容不超過約 1 MB（D1 單一個值的上限是 2 MB；單筆最大約 1.4 MB 自己一組）
    const chunks: (typeof unique)[] = [];
    let current: typeof unique = [];
    let size = 0;
    for (const item of unique) {
      if (current.length && size + item.blob.length > 1_000_000) {
        chunks.push(current);
        current = [];
        size = 0;
      }
      current.push(item);
      size += item.blob.length;
    }
    if (current.length) chunks.push(current);
    const applied: { id: string; seq: number }[] = [];
    for (const chunk of chunks) {
      // 版本的檢查與寫入在同一個敘述：同時有兩台寫同一筆時，後到的是衝突
      const rows = await this.driver.all(
        "INSERT INTO records (space, id, seq, blob)" +
          " SELECT ?, json_extract(j.value, '$.id'), (SELECT COALESCE(MAX(seq), 0) FROM records WHERE space=?) + j.key + 1, json_extract(j.value, '$.blob')" +
          " FROM json_each(?) AS j" +
          " WHERE COALESCE((SELECT r.seq FROM records r WHERE r.space=? AND r.id=json_extract(j.value, '$.id')), 0) = json_extract(j.value, '$.base')" +
          // 換金鑰完成的那一刻還在途中的送出：不寫進已經搬走的舊空間（當成衝突，下次同步時跟著搬過去）
          " AND NOT EXISTS (SELECT 1 FROM moves WHERE moves.space=?)" +
          " ON CONFLICT(space, id) DO UPDATE SET seq=excluded.seq, blob=excluded.blob RETURNING id, seq",
        [space, space, JSON.stringify(chunk), space, space],
      );
      const done = new Map(rows.map((r) => [String(r.id), Number(r.seq)]));
      for (const item of chunk) {
        const seq = done.get(item.id);
        if (seq === undefined) conflicts.push(item.id);
        else applied.push({ id: item.id, seq });
      }
    }
    const blobs = new Map(unique.map((i) => [i.id, i.blob.length]));
    // 新的一筆另外加上固定額外；更新已經有的只算內容的差
    const delta = applied.reduce((sum, a) => {
      const old = before.get(a.id);
      return sum + (blobs.get(a.id) ?? 0) - (old ?? -RECORD_OVERHEAD);
    }, 0);
    await this.driver.run("UPDATE spaces SET bytes=MAX(0, bytes - ? + ?), updated_at=? WHERE id=?", [reserved, delta, this.now().toISOString(), space]);
    applied.sort((a, b) => a.seq - b.seq);
    return { applied, conflicts };
  }

  // -------------------------------------------------------------------------
  // 配對：依序是新裝置的臨時公開金鑰與承諾、舊裝置的臨時公開金鑰、新裝置公開的亂數、
  // 加密後的同步金鑰；每一項只能寫一次，十分鐘後失效
  // -------------------------------------------------------------------------

  /** maxSlots：整個服務同時最多幾個有效的配對碼（查數量與寫入在同一個敘述裡）. 碼重複或已滿時回傳 false */
  async createSlot(slot: string, newPub: string, commitment: string, ttlMs: number, maxSlots: number = Number.MAX_SAFE_INTEGER): Promise<boolean> {
    const now = this.now().getTime();
    await this.driver.run("DELETE FROM pair_slots WHERE expires_at<?", [now]);
    const result = await this.driver.run(
      "INSERT INTO pair_slots (slot, new_pub, commitment, expires_at) SELECT ?, ?, ?, ?" +
        " WHERE (SELECT COUNT(*) FROM pair_slots WHERE expires_at>=?) < ? ON CONFLICT(slot) DO NOTHING",
      [slot, newPub, commitment, now + ttlMs, now, maxSlots],
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
