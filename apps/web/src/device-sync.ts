/**
 * 多裝置同步（規格 12.10）：這台的同步引擎與狀態. 打開 App、回到前景、資料有變動後幾秒各同步一次.
 * 測試模式不同步（用的是另一個資料庫）.
 *
 * 功能開關 devices（規格 12.27）開著時是裝置模式：這台用自己的金鑰簽章、登記在裝置清單裡；
 * 別台換了金鑰時引擎自動換過去並存下新的同步金鑰；這台被移除時清掉這台的全部資料.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  fromBase64url,
  lastSyncAt,
  SyncApi,
  SyncApiError,
  SyncEngine,
  SyncRemovedError,
  toBase64url,
  type Coach,
  type DeviceIdentity,
  type SyncDevice,
  type SyncDevices,
  type SyncResult,
} from "@running-coach/core";

import { defaultDeviceLabel, loadDeviceIdentity } from "./device-identity";
import { featureEnabled } from "./environment";
import type { AppSettings } from "./settings";

/** 資料變動後等多久才同步：連續操作時合併成一次 */
const DEBOUNCE_MS = 4_000;
/** 這台看過哪些裝置（提醒新裝置加入用）；只存裝置 id */
export const SEEN_KEY = "zone2mate.sync.seen-devices";

export interface DeviceSyncState {
  /** 有同步服務、而且不在測試模式 */
  available: boolean;
  /** 這台已經開啟同步 */
  enabled: boolean;
  /** 裝置模式（功能開關 devices） */
  devicesMode: boolean;
  /** 裝置模式時這台的身分；還在讀取或讀不到時是 null */
  identity: DeviceIdentity | null;
  api: SyncApi | null;
  engine: SyncEngine | null;
  busy: boolean;
  /** 上次同步完成的時間（ISO） */
  lastAt: string | null;
  last: SyncResult | null;
  error: string | null;
  /** 雲端的同步空間已經刪除（在另一台按了刪除）：這台不再連線，等使用者停止或重新開始 */
  gone: boolean;
  /** 裝置清單（裝置模式、同步過之後） */
  devices: SyncDevices | null;
  /** 這台上次看過之後才加入的裝置（升級時才登記的也算：拿到復原碼的人也可能在那時登記） */
  newDevices: SyncDevice[];
  /** 「是我的」：不再提醒 */
  acknowledge(ids: string[]): void;
  /** 改名、換金鑰之後更新清單 */
  setDevices(devices: SyncDevices): void;
  /** 立即同步；沒有開啟時不做事 */
  run(): Promise<void>;
}

function loadSeen(): string[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "null") as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : null;
  } catch {
    return null;
  }
}

function saveSeen(ids: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(ids));
  } catch {
    // 記不住就下次再提醒
  }
}

export function useDeviceSync(
  coach: Coach | null,
  settings: AppSettings,
  testMode: boolean,
  revision: number,
  touch: () => void,
  /** 同步金鑰換了（別台換金鑰後自動取得）：存進設定 */
  saveSyncKey: (key: string) => Promise<void>,
  /** 這台已從同步移除：清掉全部資料 */
  onRemoved: () => void,
): DeviceSyncState {
  const url = settings.sync.url.trim();
  const key = settings.sync.key.trim();
  const devicesMode = featureEnabled("devices");
  const available = Boolean(coach && url && !testMode);
  const api = useMemo(() => (url ? new SyncApi(url) : null), [url]);

  const [identity, setIdentity] = useState<DeviceIdentity | null>(null);
  const [identityError, setIdentityError] = useState<string | null>(null);
  useEffect(() => {
    if (!devicesMode || !key) return;
    let alive = true;
    loadDeviceIdentity()
      .then((loaded) => alive && setIdentity(loaded))
      .catch((e) => alive && setIdentityError(`無法建立這台的裝置金鑰（${e instanceof Error ? e.message : String(e)}）。私密瀏覽模式可能不支援。`));
    return () => {
      alive = false;
    };
  }, [devicesMode, key]);

  const saveKeyRef = useRef(saveSyncKey);
  saveKeyRef.current = saveSyncKey;
  // 引擎自己換到的同步金鑰：設定跟著改時不用重新建立引擎（同一個引擎已經在用新的金鑰）
  const followed = useRef<{ engine: SyncEngine; key: string } | null>(null);
  const engine = useMemo(() => {
    if (!coach || !api || !key || testMode) return null;
    if (devicesMode && !identity) return null;
    const previous = followed.current;
    if (previous && previous.key === key) return previous.engine;
    try {
      const created: SyncEngine = new SyncEngine(
        coach.db,
        api,
        fromBase64url(key),
        undefined,
        devicesMode && identity
          ? {
              identity,
              label: () => defaultDeviceLabel(),
              onRootChanged: async (root) => {
                const next = toBase64url(root);
                followed.current = { engine: created, key: next };
                await saveKeyRef.current(next);
              },
            }
          : null,
      );
      followed.current = null;
      return created;
    } catch {
      return null;
    }
  }, [coach, api, key, testMode, devicesMode, identity]);

  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<SyncResult | null>(null);
  const [lastAt, setLastAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [devices, setDevices] = useState<SyncDevices | null>(null);
  const [seen, setSeen] = useState<string[] | null>(loadSeen);

  useEffect(() => {
    if (!coach) return;
    void lastSyncAt(coach.db).then(setLastAt);
  }, [coach, engine]);

  const removedRef = useRef(onRemoved);
  removedRef.current = onRemoved;
  const run = useCallback(async () => {
    if (!engine) return;
    setBusy(true);
    try {
      const result = await engine.sync();
      setLast(result);
      setLastAt(result.at);
      if (result.devices) setDevices(result.devices);
      setError(null);
      setGone(false);
      // 收到別台的資料：各頁重新讀取（不會再觸發送出，因為內容和剛同步的一樣）
      if (result.received > 0) touch();
    } catch (e) {
      if (e instanceof SyncRemovedError) {
        // 這台對舊空間的同步狀態也清掉（之後重新開始同步時從頭來）
        await engine.forget().catch(() => undefined);
        removedRef.current();
        return;
      }
      const deleted = e instanceof SyncApiError && e.status === 404;
      setGone(deleted);
      setError(deleted ? null : e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [engine, touch]);

  // 換了金鑰（停止、重新開始）：前一組的狀態不適用
  useEffect(() => {
    setGone(false);
    setError(null);
    setLast(null);
    setDevices(null);
  }, [engine]);

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

  // 第一次拿到清單時，當時已經在的都算看過（這台剛加入時，別台不是「新裝置」）
  useEffect(() => {
    if (!devices || seen !== null) return;
    const ids = devices.devices.map((d) => d.id);
    saveSeen(ids);
    setSeen(ids);
  }, [devices, seen]);

  const newDevices = useMemo(
    () => (devices && seen ? devices.devices.filter((d) => !d.self && !seen.includes(d.id)) : []),
    [devices, seen],
  );

  const acknowledge = useCallback((ids: string[]) => {
    setSeen((current) => {
      const next = [...new Set([...(current ?? []), ...ids])];
      saveSeen(next);
      return next;
    });
  }, []);

  return useMemo(
    () => ({
      available,
      // 裝置模式時引擎要等這台的金鑰讀出來；這段時間也算開啟（不閃過「開始同步」的畫面）
      enabled: engine !== null || (devicesMode && Boolean(key) && available),
      devicesMode,
      identity,
      api,
      engine,
      busy,
      lastAt,
      last,
      error: error ?? (devicesMode && key && !identity ? identityError : null),
      gone,
      devices,
      newDevices,
      acknowledge,
      setDevices,
      run,
    }),
    [available, engine, devicesMode, identity, api, busy, lastAt, last, error, identityError, key, gone, devices, newDevices, acknowledge, run],
  );
}
