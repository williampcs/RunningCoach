/**
 * 這台在多裝置同步裡的身分（規格 12.27）：裝置 id 與兩把私鑰（簽章、收件）. 私鑰產生時就設成不可匯出，
 * 存在 IndexedDB（localStorage 只能存文字，存不了 CryptoKey）；程式拿得到私鑰來用，但讀不出私鑰本身.
 * 同一個瀏覽器（同一個網址）只有一個身分；停止同步、全部重置、被移除時刪掉，下次加入時產生新的.
 */
import { newDeviceIdentity, type DeviceIdentity, type DeviceLabel } from "@running-coach/core";

const DB_NAME = "zone2mate-device";
const STORE = "identity";
const KEY = "self";

function openStore(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("無法開啟 IndexedDB"));
  });
}

function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openStore().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = fn(tx.objectStore(STORE));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error("IndexedDB 發生錯誤"));
        };
      }),
  );
}

let loading: Promise<DeviceIdentity> | null = null;

/** 這台的身分；還沒有就產生一個 */
export function loadDeviceIdentity(): Promise<DeviceIdentity> {
  loading ??= (async () => {
    const stored = (await run("readonly", (s) => s.get(KEY))) as DeviceIdentity | undefined;
    if (stored?.id && stored.signKey && stored.boxKey) return stored;
    const created = await newDeviceIdentity();
    await run("readwrite", (s) => s.put(created, KEY));
    return created;
  })().catch((e) => {
    loading = null;
    throw e;
  });
  return loading;
}

/** 刪掉這台的身分（下次加入時是新的裝置） */
export async function deleteDeviceIdentity(): Promise<void> {
  loading = null;
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    // 打不開 IndexedDB 時本來就沒有身分
  }
}

/** 預設的名稱：依瀏覽器與系統，例如「Mac · Edge」「iPhone · Safari」 */
export function defaultDeviceLabel(ua = navigator.userAgent): DeviceLabel {
  const platform = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua) || (/Macintosh/.test(ua) && typeof navigator !== "undefined" && navigator.maxTouchPoints > 1)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /Macintosh|Mac OS X/.test(ua)
          ? "Mac"
          : /Windows/.test(ua)
            ? "Windows"
            : /CrOS/.test(ua)
              ? "Chromebook"
              : /Linux/.test(ua)
                ? "Linux"
                : "裝置";
  const browser = /Edg(e|A|iOS)?\//.test(ua)
    ? "Edge"
    : /SamsungBrowser\//.test(ua)
      ? "Samsung Internet"
      : /Firefox\/|FxiOS\//.test(ua)
        ? "Firefox"
        : /OPR\//.test(ua)
          ? "Opera"
          : /Chrome\/|CriOS\//.test(ua)
            ? "Chrome"
            : /Safari\//.test(ua)
              ? "Safari"
              : "瀏覽器";
  return { name: `${platform} · ${browser}`, platform };
}
