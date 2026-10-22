/**
 * 多裝置同步（規格 12.10）：這台的同步引擎與狀態. 打開 App、回到前景、資料有變動後幾秒各同步一次.
 * 測試模式不同步（用的是另一個資料庫）.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { fromBase64url, lastSyncAt, SyncApi, SyncApiError, SyncEngine, type Coach, type SyncResult } from "@running-coach/core";

import type { AppSettings } from "./settings";

/** 資料變動後等多久才同步：連續操作時合併成一次 */
const DEBOUNCE_MS = 4_000;

export interface DeviceSyncState {
  /** 有同步服務、而且不在測試模式 */
  available: boolean;
  /** 這台已經開啟同步 */
  enabled: boolean;
  api: SyncApi | null;
  engine: SyncEngine | null;
  busy: boolean;
  /** 上次同步完成的時間（ISO） */
  lastAt: string | null;
  last: SyncResult | null;
  error: string | null;
  /** 立即同步；沒有開啟時不做事 */
  run(): Promise<void>;
}

export function useDeviceSync(coach: Coach | null, settings: AppSettings, testMode: boolean, revision: number, touch: () => void): DeviceSyncState {
  const url = settings.sync.url.trim();
  const key = settings.sync.key.trim();
  const available = Boolean(coach && url && !testMode);
  const api = useMemo(() => (url ? new SyncApi(url) : null), [url]);
  const engine = useMemo(() => {
    if (!coach || !api || !key || testMode) return null;
    try {
      return new SyncEngine(coach.db, api, fromBase64url(key));
    } catch {
      return null;
    }
  }, [coach, api, key, testMode]);

  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!coach) return;
    void lastSyncAt(coach.db).then(setLastAt);
  }, [coach, engine]);

  const run = useCallback(async () => {
    if (!engine) return;
    setBusy(true);
    try {
      const result = await engine.sync();
      setLast(result);
      setLastAt(result.at);
      setError(null);
      // 收到別台的資料：各頁重新讀取（不會再觸發送出，因為內容和剛同步的一樣）
      if (result.received > 0) touch();
    } catch (e) {
      setError(
        e instanceof SyncApiError && e.status === 404
          ? "雲端的同步資料已經刪除（可能是在另一台按了刪除）。請停止這台的同步，或重新開始同步。"
          : e instanceof Error
            ? e.message
            : String(e),
      );
    } finally {
      setBusy(false);
    }
  }, [engine, touch]);

  // 打開 App、回到前景時同步
  useEffect(() => {
    if (!engine) return;
    void run();
    const onVisible = () => document.visibilityState === "visible" && void run();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [engine, run]);

  // 資料有變動後幾秒同步一次
  const firstRevision = useRef(true);
  useEffect(() => {
    if (!engine) return;
    if (firstRevision.current) {
      firstRevision.current = false;
      return;
    }
    const timer = setTimeout(() => void run(), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [engine, revision, run]);

  return useMemo(
    () => ({ available, enabled: engine !== null, api, engine, busy, lastAt, last, error, run }),
    [available, engine, api, busy, lastAt, last, error, run],
  );
}
