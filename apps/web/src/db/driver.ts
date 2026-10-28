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
  /** 刪除所有資料，保留資料表結構 */
  reset(): Promise<void>;
}

/** 這個分頁開著的資料庫：交給另一個分頁時（KI-046）由 closeBrowserDb 關掉 */
let current: Promise<{ close(): Promise<void> }> | null = null;

/** 關掉這個分頁的資料庫並結束 worker；之後的查詢不會再有回應. 沒有開著時不做事 */
export async function closeBrowserDb(): Promise<void> {
  const opened = current;
  current = null;
  if (!opened) return;
  try {
    await (await opened).close();
  } catch {
    // 開啟失敗或已經關掉：沒有要放開的東西
  }
}

/** file：OPFS 中的資料庫檔名，預設為正式資料的 /coach.db */
export function openBrowserDb(file?: string): Promise<BrowserDb> {
  const opening = openWorker(file);
  current = opening.then((db) => db);
  return opening.then((db) => db.api);
}

async function openWorker(file?: string): Promise<{ api: BrowserDb; close(): Promise<void> }> {
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

  // 交給另一個分頁之後（close）不再送出查詢，也不回應：這個分頁的畫面已經收起，還沒做完的動作就停在那裡，
  // 不會寫進資料庫，也不會冒出錯誤
  let closed = false;
  const call = <T>(payload: Payload): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (closed && payload.method !== "close") return;
      const id = nextId++;
      pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      worker.postMessage({ id, ...payload });
    });

  const state = await call<{ persistent: boolean; reason?: string }>({ method: "open", file });

  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await call<void>({ method: "close" });
    } finally {
      worker.terminate();
      pending.clear();
    }
  };

  const api: BrowserDb = {
    ...state,
    exec: (sql) => call<void>({ method: "exec", sql }),
    run: (sql, params: SqlValue[] = []) =>
      call<{ lastInsertRowid: number; changes: number }>({ method: "run", sql, params }),
    all: (sql, params: SqlValue[] = []) => call<Row[]>({ method: "all", sql, params }),
    exportFile: () => call<Uint8Array>({ method: "export" }),
    importFile: (bytes) => call<void>({ method: "import", bytes }),
    reset: () => call<void>({ method: "reset" }),
  };
  return { api, close };
}
