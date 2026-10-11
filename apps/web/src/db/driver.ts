/** 瀏覽器的 SQLite 儲存驅動 — 透過 worker 存取 OPFS 上的資料庫. */
import type { Row, SqlDriver, SqlValue } from "@running-coach/core";

import type { DbRequest } from "./worker";

type Payload = DbRequest extends infer R ? (R extends { id: number } ? Omit<R, "id"> : never) : never;

export interface BrowserDb extends SqlDriver {
  /** false 表示資料只在記憶體中，關閉分頁就會消失 */
  persistent: boolean;
  /** 無法持久化的原因 */
  reason?: string;
  exportFile(): Promise<Uint8Array>;
  importFile(bytes: Uint8Array): Promise<void>;
}

export async function openBrowserDb(): Promise<BrowserDb> {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  let nextId = 1;

  worker.onmessage = (event: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const { id, result, error } = event.data;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    if (error !== undefined) waiter.reject(new Error(error));
    else waiter.resolve(result);
  };

  const call = <T>(payload: Payload): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, ...payload });
    });

  const state = await call<{ persistent: boolean; reason?: string }>({ method: "open" });

  return {
    ...state,
    exec: (sql) => call<void>({ method: "exec", sql }),
    run: (sql, params: SqlValue[] = []) =>
      call<{ lastInsertRowid: number; changes: number }>({ method: "run", sql, params }),
    all: (sql, params: SqlValue[] = []) => call<Row[]>({ method: "all", sql, params }),
    exportFile: () => call<Uint8Array>({ method: "export" }),
    importFile: (bytes) => call<void>({ method: "import", bytes }),
  };
}
