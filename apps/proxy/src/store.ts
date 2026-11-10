/**
 * 帳號與用量的儲存 — 代理唯一會落地的資料：邀請碼（只存雜湊）、帳號與它的裝置憑證（只存雜湊）、登入方式、
 * 每天的次數、每月的 token 與金額.
 * 不儲存請求或回應內容，也不儲存憑證、邀請碼或連結碼的原文（只存雜湊）。不存 email、名字或 IP（規格 12.39、12.36 的資料原則）.
 *
 * 以「帳號」為中心（2026-11-10 使用者的方向）：邀請碼只是建立帳號的一種方式（identities 的 type invite）；之後的
 * Google／Apple 登入加在同一個帳號上（訪客帳號升級），不用換帳號. 一個帳號可以有多台裝置，每台一個憑證（account_tokens），
 * 可以單獨撤銷；另一台裝置用已登入那台給的短效連結碼（link_codes）拿到自己的憑證.
 */
import type { SqlDriver } from "@running-coach/core";

import type { TokenUsage } from "./policy";

export interface Account {
  id: string;
  status: "active" | "suspended";
  /** null 表示使用政策的預設預算 */
  monthlyBudgetMicroUsd: number | null;
  /** 從哪一張邀請碼兌換來的；管理端點直接建立的是 null */
  inviteId: string | null;
  createdAt: string;
}

/** 一台裝置的憑證（撤銷了的不列） */
export interface DeviceToken {
  id: string;
  accountId: string;
  /** 網頁版給的粗略名稱（例「iPhone · Safari」），讓選手分得出是哪一台；沒有時是 null */
  deviceName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
}

export type IdentityType = "invite" | "google" | "apple";

export interface PeriodUsage extends TokenUsage {
  requests: number;
  costMicroUsd: number;
}

/** 每天的次數：chat 是選手送出的則數，auto 是自動的分析，compress 是對話壓縮 */
export type DailyKind = "chat" | "auto" | "compress";
export type DailyUsage = Record<DailyKind, number>;

export interface Invite {
  id: string;
  /** 管理用的批次名稱（選填）；不要寫真名 */
  label: string | null;
  monthlyBudgetMicroUsd: number | null;
  /** ISO 時間；null 表示不會過期 */
  expiresAt: string | null;
  createdAt: string;
  redeemedAt: string | null;
  accountId: string | null;
  revoked: boolean;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id                       TEXT PRIMARY KEY,
    status                   TEXT NOT NULL DEFAULT 'active',
    monthly_budget_microusd  INTEGER,
    invite_id                TEXT,
    created_at               TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS account_tokens (
    id            TEXT PRIMARY KEY,
    account_id    TEXT NOT NULL,
    token_hash    TEXT NOT NULL UNIQUE,
    device_name   TEXT,
    created_at    TEXT NOT NULL,
    last_used_at  TEXT,
    revoked_at    TEXT
  );

  CREATE INDEX IF NOT EXISTS account_tokens_account ON account_tokens (account_id);

  CREATE TABLE IF NOT EXISTS identities (
    type          TEXT NOT NULL,
    subject_hash  TEXT NOT NULL,
    account_id    TEXT NOT NULL,
    created_at    TEXT NOT NULL,
    PRIMARY KEY (type, subject_hash)
  );

  CREATE TABLE IF NOT EXISTS link_codes (
    code_hash   TEXT PRIMARY KEY,
    account_id  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used_at     TEXT
  );

  CREATE TABLE IF NOT EXISTS usage (
    account_id          TEXT NOT NULL,
    period              TEXT NOT NULL,
    requests            INTEGER NOT NULL DEFAULT 0,
    input_tokens        INTEGER NOT NULL DEFAULT 0,
    output_tokens       INTEGER NOT NULL DEFAULT 0,
    cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
    cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
    cost_microusd       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, period)
  );

  CREATE TABLE IF NOT EXISTS invites (
    id                       TEXT PRIMARY KEY,
    code_hash                TEXT NOT NULL UNIQUE,
    label                    TEXT,
    monthly_budget_microusd  INTEGER,
    expires_at               TEXT,
    created_at               TEXT NOT NULL,
    redeemed_at              TEXT,
    account_id               TEXT,
    revoked                  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS daily_usage (
    account_id  TEXT NOT NULL,
    day         TEXT NOT NULL,
    chat        INTEGER NOT NULL DEFAULT 0,
    auto        INTEGER NOT NULL DEFAULT 0,
    compress    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, day)
  );

  CREATE TABLE IF NOT EXISTS totals (
    period         TEXT PRIMARY KEY,
    requests       INTEGER NOT NULL DEFAULT 0,
    cost_microusd  INTEGER NOT NULL DEFAULT 0
  )
`;

// 欄位名稱不能用參數帶，只接受這三個
const DAILY_COLUMN: Record<DailyKind, string> = { chat: "chat", auto: "auto", compress: "compress" };

const num = (value: unknown) => Number(value ?? 0);
const textOrNull = (value: unknown) => (value === null || value === undefined ? null : String(value));

function toAccount(row: Record<string, unknown> | undefined): Account | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status === "active" ? "active" : "suspended",
    monthlyBudgetMicroUsd: row.monthly_budget_microusd === null ? null : Number(row.monthly_budget_microusd),
    inviteId: textOrNull(row.invite_id),
    createdAt: String(row.created_at),
  };
}

function toToken(row: Record<string, unknown>): DeviceToken {
  return {
    id: String(row.id),
    accountId: String(row.account_id),
    deviceName: textOrNull(row.device_name),
    createdAt: String(row.created_at),
    lastUsedAt: textOrNull(row.last_used_at),
  };
}

function toInvite(row: Record<string, unknown>): Invite {
  return {
    id: String(row.id),
    label: textOrNull(row.label),
    monthlyBudgetMicroUsd: row.monthly_budget_microusd === null ? null : Number(row.monthly_budget_microusd),
    expiresAt: textOrNull(row.expires_at),
    createdAt: String(row.created_at),
    redeemedAt: textOrNull(row.redeemed_at),
    accountId: textOrNull(row.account_id),
    revoked: num(row.revoked) !== 0,
  };
}

function toPeriodUsage(row: Record<string, unknown> | undefined): PeriodUsage {
  return {
    requests: num(row?.requests),
    input: num(row?.input_tokens),
    output: num(row?.output_tokens),
    cacheRead: num(row?.cache_read_tokens),
    cacheWrite: num(row?.cache_write_tokens),
    costMicroUsd: num(row?.cost_microusd),
  };
}

export class AccountStore {
  constructor(private readonly driver: SqlDriver) {}

  async init(): Promise<void> {
    await this.driver.exec(SCHEMA);
    // 內測之前建的資料表（只有本機開發用過，代理沒有上線過）：憑證在 accounts 裡、沒有 invite_id → 搬到 account_tokens
    const columns = (await this.driver.all("PRAGMA table_info(accounts)")).map((c) => String(c.name));
    if (columns.includes("token_hash")) {
      await this.driver.run(
        "INSERT OR IGNORE INTO account_tokens (id, account_id, token_hash, created_at) SELECT 'tok_' || id, id, token_hash, created_at FROM accounts",
      );
      await this.driver.exec(`
        CREATE TABLE accounts_new (id TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'active', monthly_budget_microusd INTEGER, invite_id TEXT, created_at TEXT NOT NULL);
        INSERT INTO accounts_new (id, status, monthly_budget_microusd, invite_id, created_at)
          SELECT id, status, monthly_budget_microusd, ${columns.includes("invite_id") ? "invite_id" : "NULL"}, created_at FROM accounts;
        DROP TABLE accounts;
        ALTER TABLE accounts_new RENAME TO accounts
      `);
    }
  }

  // --- 帳號 ---------------------------------------------------------------

  async createAccount(id: string, monthlyBudgetMicroUsd: number | null, inviteId: string | null = null, now = new Date()): Promise<void> {
    await this.driver.run("INSERT INTO accounts (id, monthly_budget_microusd, invite_id, created_at) VALUES (?, ?, ?, ?)", [
      id,
      monthlyBudgetMicroUsd,
      inviteId,
      now.toISOString(),
    ]);
  }

  /** 憑證（沒撤銷的）→ 帳號與這台的憑證 */
  async findByTokenHash(tokenHash: string): Promise<{ account: Account; token: DeviceToken } | null> {
    const row = (await this.driver.all("SELECT * FROM account_tokens WHERE token_hash=? AND revoked_at IS NULL", [tokenHash]))[0];
    if (!row) return null;
    const account = await this.getAccount(String(row.account_id));
    return account ? { account, token: toToken(row) } : null;
  }

  // --- 裝置的憑證 ---------------------------------------------------------

  async addToken(accountId: string, tokenId: string, tokenHash: string, deviceName: string | null, now = new Date()): Promise<void> {
    await this.driver.run("INSERT INTO account_tokens (id, account_id, token_hash, device_name, created_at) VALUES (?, ?, ?, ?, ?)", [
      tokenId,
      accountId,
      tokenHash,
      deviceName,
      now.toISOString(),
    ]);
  }

  async touchToken(tokenId: string, now = new Date()): Promise<void> {
    await this.driver.run("UPDATE account_tokens SET last_used_at=? WHERE id=?", [now.toISOString(), tokenId]);
  }

  async listTokens(accountId: string): Promise<DeviceToken[]> {
    return (await this.driver.all("SELECT * FROM account_tokens WHERE account_id=? AND revoked_at IS NULL ORDER BY created_at, rowid", [accountId])).map(toToken);
  }

  /** 撤銷這個帳號的一台；回傳有沒有撤銷到 */
  async revokeToken(accountId: string, tokenId: string, now = new Date()): Promise<boolean> {
    const result = await this.driver.run("UPDATE account_tokens SET revoked_at=? WHERE id=? AND account_id=? AND revoked_at IS NULL", [
      now.toISOString(),
      tokenId,
      accountId,
    ]);
    return result.changes > 0;
  }

  async revokeAllTokens(accountId: string, now = new Date()): Promise<void> {
    await this.driver.run("UPDATE account_tokens SET revoked_at=? WHERE account_id=? AND revoked_at IS NULL", [now.toISOString(), accountId]);
  }

  // --- 登入方式（這次只有邀請碼；Google／Apple 之後加在同一個帳號上） ---------

  async addIdentity(accountId: string, type: IdentityType, subjectHash: string, now = new Date()): Promise<void> {
    await this.driver.run("INSERT INTO identities (type, subject_hash, account_id, created_at) VALUES (?, ?, ?, ?)", [type, subjectHash, accountId, now.toISOString()]);
  }

  async listIdentities(accountId: string): Promise<{ type: IdentityType; createdAt: string }[]> {
    return (await this.driver.all("SELECT type, created_at FROM identities WHERE account_id=? ORDER BY created_at", [accountId])).map((r) => ({
      type: String(r.type) as IdentityType,
      createdAt: String(r.created_at),
    }));
  }

  // --- 連結碼（在另一台裝置使用） -----------------------------------------

  async createLinkCode(codeHash: string, accountId: string, now: Date, expiresAt: Date): Promise<void> {
    // 同一個帳號只留最新的一個連結碼
    await this.driver.run("DELETE FROM link_codes WHERE account_id=? OR expires_at < ?", [accountId, now.toISOString()]);
    await this.driver.run("INSERT INTO link_codes (code_hash, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)", [
      codeHash,
      accountId,
      now.toISOString(),
      expiresAt.toISOString(),
    ]);
  }

  /** 用掉一個連結碼（沒用過、沒過期才成功，同時用兩次只有一次成功）；回傳帳號或不能用的原因 */
  async claimLinkCode(codeHash: string, now: Date): Promise<string | "unknown" | "used" | "expired"> {
    const nowIso = now.toISOString();
    const result = await this.driver.run("UPDATE link_codes SET used_at=? WHERE code_hash=? AND used_at IS NULL AND expires_at > ?", [nowIso, codeHash, nowIso]);
    const row = (await this.driver.all("SELECT * FROM link_codes WHERE code_hash=?", [codeHash]))[0];
    if (!row) return "unknown";
    if (result.changes > 0) return String(row.account_id);
    return row.used_at ? "used" : "expired";
  }

  async getAccount(id: string): Promise<Account | null> {
    return toAccount((await this.driver.all("SELECT * FROM accounts WHERE id=?", [id]))[0]);
  }

  async listAccounts(): Promise<Account[]> {
    return (await this.driver.all("SELECT * FROM accounts ORDER BY created_at")).map((row) => toAccount(row)!);
  }

  /** 回傳帳號是否存在 */
  async updateAccount(
    id: string,
    changes: { status?: Account["status"]; monthlyBudgetMicroUsd?: number | null },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (changes.status !== undefined) (sets.push("status=?"), params.push(changes.status));
    if (changes.monthlyBudgetMicroUsd !== undefined) {
      sets.push("monthly_budget_microusd=?");
      params.push(changes.monthlyBudgetMicroUsd);
    }
    if (!sets.length) return (await this.getAccount(id)) !== null;
    const result = await this.driver.run(`UPDATE accounts SET ${sets.join(", ")} WHERE id=?`, [...params, id]);
    return result.changes > 0;
  }

  /**
   * 刪除帳號與它所有的憑證、登入方式、連結碼、每天與每月的用量（選手在設定按「刪除試用帳號」，或作者刪除）.
   * 邀請碼維持「已用過」、不能再兌換；這個月的總花費（totals，不分是誰的）不跟著減少，總預算照樣算得準。回傳帳號是否存在
   */
  async deleteAccount(id: string): Promise<boolean> {
    const result = await this.driver.run("DELETE FROM accounts WHERE id=?", [id]);
    await this.driver.run("DELETE FROM account_tokens WHERE account_id=?", [id]);
    await this.driver.run("DELETE FROM identities WHERE account_id=?", [id]);
    await this.driver.run("DELETE FROM link_codes WHERE account_id=?", [id]);
    await this.driver.run("DELETE FROM daily_usage WHERE account_id=?", [id]);
    await this.driver.run("DELETE FROM usage WHERE account_id=?", [id]);
    await this.driver.run("UPDATE invites SET account_id=NULL WHERE account_id=?", [id]);
    return result.changes > 0;
  }

  // --- 邀請碼 -------------------------------------------------------------

  async createInvite(invite: Omit<Invite, "redeemedAt" | "accountId" | "revoked">, codeHash: string): Promise<void> {
    await this.driver.run(
      "INSERT INTO invites (id, code_hash, label, monthly_budget_microusd, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [invite.id, codeHash, invite.label, invite.monthlyBudgetMicroUsd, invite.expiresAt, invite.createdAt],
    );
  }

  async listInvites(): Promise<Invite[]> {
    return (await this.driver.all("SELECT * FROM invites ORDER BY created_at, rowid")).map(toInvite);
  }

  /** 回傳邀請碼是否存在 */
  async revokeInvite(id: string): Promise<boolean> {
    return (await this.driver.run("UPDATE invites SET revoked=1 WHERE id=?", [id])).changes > 0;
  }

  /**
   * 兌換：以單一敘述把邀請碼標成已用（沒用過、沒停用、沒過期才會成功），同一張碼同時兌換兩次只有一次成功.
   * 成功時回傳那張邀請碼；不能用時回傳不能用的原因
   */
  async claimInvite(codeHash: string, accountId: string, now: Date): Promise<Invite | "unknown" | "used" | "revoked" | "expired"> {
    const nowIso = now.toISOString();
    const result = await this.driver.run(
      `UPDATE invites SET redeemed_at=?, account_id=?
       WHERE code_hash=? AND redeemed_at IS NULL AND revoked=0 AND (expires_at IS NULL OR expires_at > ?)`,
      [nowIso, accountId, codeHash, nowIso],
    );
    const row = (await this.driver.all("SELECT * FROM invites WHERE code_hash=?", [codeHash]))[0];
    if (!row) return "unknown";
    const invite = toInvite(row);
    if (result.changes > 0) return invite;
    if (invite.revoked) return "revoked";
    if (invite.redeemedAt) return "used";
    return "expired";
  }

  /** 建帳號失敗時把邀請碼還原成沒用過 */
  async unclaimInvite(id: string): Promise<void> {
    await this.driver.run("UPDATE invites SET redeemed_at=NULL, account_id=NULL WHERE id=?", [id]);
  }

  // --- 每天的次數 ---------------------------------------------------------

  async getDaily(accountId: string, day: string): Promise<DailyUsage> {
    const row = (await this.driver.all("SELECT * FROM daily_usage WHERE account_id=? AND day=?", [accountId, day]))[0];
    return { chat: num(row?.chat), auto: num(row?.auto), compress: num(row?.compress) };
  }

  /** 還沒到上限時加一並回傳 true；到了上限回傳 false. 加一與比較在同一個敘述裡，並行的請求不會一起超過 */
  async reserveDaily(accountId: string, day: string, kind: DailyKind, limit: number): Promise<boolean> {
    const column = DAILY_COLUMN[kind];
    await this.driver.run("INSERT INTO daily_usage (account_id, day) VALUES (?, ?) ON CONFLICT(account_id, day) DO NOTHING", [accountId, day]);
    const result = await this.driver.run(`UPDATE daily_usage SET ${column} = ${column} + 1 WHERE account_id=? AND day=? AND ${column} < ?`, [
      accountId,
      day,
      limit,
    ]);
    return result.changes > 0;
  }

  /** 上游回錯誤、沒有產生回覆時退回那一次 */
  async releaseDaily(accountId: string, day: string, kind: DailyKind): Promise<void> {
    const column = DAILY_COLUMN[kind];
    await this.driver.run(`UPDATE daily_usage SET ${column} = ${column} - 1 WHERE account_id=? AND day=? AND ${column} > 0`, [accountId, day]);
  }

  // --- 每月的用量 ---------------------------------------------------------

  async getUsage(accountId: string, period: string): Promise<PeriodUsage> {
    return toPeriodUsage((await this.driver.all("SELECT * FROM usage WHERE account_id=? AND period=?", [accountId, period]))[0]);
  }

  /** 所有帳號這個月合計的花費（百萬分之一美元）；刪掉的帳號也算在內 */
  async getTotal(period: string): Promise<{ requests: number; costMicroUsd: number }> {
    const row = (await this.driver.all("SELECT * FROM totals WHERE period=?", [period]))[0];
    return { requests: num(row?.requests), costMicroUsd: num(row?.cost_microusd) };
  }

  /** 以單一敘述累加，並行請求不會互相覆蓋 */
  async addUsage(accountId: string, period: string, usage: TokenUsage, cost: number): Promise<void> {
    await this.driver.run(
      `INSERT INTO usage (account_id, period, requests, input_tokens, output_tokens,
                          cache_read_tokens, cache_write_tokens, cost_microusd)
       VALUES (?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, period) DO UPDATE SET
         requests           = requests + 1,
         input_tokens       = input_tokens + excluded.input_tokens,
         output_tokens      = output_tokens + excluded.output_tokens,
         cache_read_tokens  = cache_read_tokens + excluded.cache_read_tokens,
         cache_write_tokens = cache_write_tokens + excluded.cache_write_tokens,
         cost_microusd      = cost_microusd + excluded.cost_microusd`,
      [accountId, period, usage.input, usage.output, usage.cacheRead, usage.cacheWrite, cost],
    );
    await this.driver.run(
      `INSERT INTO totals (period, requests, cost_microusd) VALUES (?, 1, ?)
       ON CONFLICT(period) DO UPDATE SET requests = requests + 1, cost_microusd = cost_microusd + excluded.cost_microusd`,
      [period, cost],
    );
  }

  /** 刪掉過期的紀錄：day 早於 oldestDay 的每天次數、period 早於 oldestPeriod 的每月用量與合計 */
  async purge(oldestDay: string, oldestPeriod: string, now = new Date()): Promise<{ daily: number; monthly: number }> {
    const daily = (await this.driver.run("DELETE FROM daily_usage WHERE day < ?", [oldestDay])).changes;
    const monthly = (await this.driver.run("DELETE FROM usage WHERE period < ?", [oldestPeriod])).changes;
    await this.driver.run("DELETE FROM totals WHERE period < ?", [oldestPeriod]);
    // 過期或用過的連結碼不用留
    await this.driver.run("DELETE FROM link_codes WHERE expires_at < ? OR used_at IS NOT NULL", [now.toISOString()]);
    return { daily, monthly };
  }
}
