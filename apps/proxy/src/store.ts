/**
 * 帳號與用量的儲存 — 代理唯一會落地的資料：帳號識別、訂閱狀態、token 用量計數.
 * 不儲存請求或回應內容，也不儲存憑證原文（只存雜湊）。
 */
import type { SqlDriver } from "@running-coach/core";

import type { TokenUsage } from "./policy";

export interface Account {
  id: string;
  status: "active" | "suspended";
  /** null 表示使用政策的預設預算 */
  monthlyBudgetMicroUsd: number | null;
}

export interface PeriodUsage extends TokenUsage {
  requests: number;
  costMicroUsd: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS accounts (
    id                       TEXT PRIMARY KEY,
    token_hash               TEXT NOT NULL UNIQUE,
    status                   TEXT NOT NULL DEFAULT 'active',
    monthly_budget_microusd  INTEGER,
    created_at               TEXT NOT NULL
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
`;

function toAccount(row: Record<string, unknown> | undefined): Account | null {
  if (!row) return null;
  return {
    id: String(row.id),
    status: row.status === "active" ? "active" : "suspended",
    monthlyBudgetMicroUsd: row.monthly_budget_microusd === null ? null : Number(row.monthly_budget_microusd),
  };
}

export class AccountStore {
  constructor(private readonly driver: SqlDriver) {}

  init(): Promise<void> {
    return this.driver.exec(SCHEMA);
  }

  async createAccount(id: string, tokenHash: string, monthlyBudgetMicroUsd: number | null): Promise<void> {
    await this.driver.run(
      "INSERT INTO accounts (id, token_hash, monthly_budget_microusd, created_at) VALUES (?, ?, ?, ?)",
      [id, tokenHash, monthlyBudgetMicroUsd, new Date().toISOString()],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<Account | null> {
    return toAccount((await this.driver.all("SELECT * FROM accounts WHERE token_hash=?", [tokenHash]))[0]);
  }

  async getAccount(id: string): Promise<Account | null> {
    return toAccount((await this.driver.all("SELECT * FROM accounts WHERE id=?", [id]))[0]);
  }

  /** 回傳帳號是否存在 */
  async updateAccount(
    id: string,
    changes: { status?: Account["status"]; monthlyBudgetMicroUsd?: number | null; tokenHash?: string },
  ): Promise<boolean> {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    if (changes.status !== undefined) (sets.push("status=?"), params.push(changes.status));
    if (changes.monthlyBudgetMicroUsd !== undefined) {
      sets.push("monthly_budget_microusd=?");
      params.push(changes.monthlyBudgetMicroUsd);
    }
    if (changes.tokenHash !== undefined) (sets.push("token_hash=?"), params.push(changes.tokenHash));
    if (!sets.length) return (await this.getAccount(id)) !== null;
    const result = await this.driver.run(`UPDATE accounts SET ${sets.join(", ")} WHERE id=?`, [...params, id]);
    return result.changes > 0;
  }

  async getUsage(accountId: string, period: string): Promise<PeriodUsage> {
    const row = (await this.driver.all("SELECT * FROM usage WHERE account_id=? AND period=?", [accountId, period]))[0];
    return {
      requests: Number(row?.requests ?? 0),
      input: Number(row?.input_tokens ?? 0),
      output: Number(row?.output_tokens ?? 0),
      cacheRead: Number(row?.cache_read_tokens ?? 0),
      cacheWrite: Number(row?.cache_write_tokens ?? 0),
      costMicroUsd: Number(row?.cost_microusd ?? 0),
    };
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
  }
}
