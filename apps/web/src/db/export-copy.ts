/**
 * 設定頁的「匯出資料庫」（規格 12.10）：匯出的檔案不含同步的金鑰. 先把使用中的資料庫複製一份到記憶體、
 * 在複製的那份刪掉、整理掉刪除的殘頁（VACUUM），再匯出；使用中的資料庫不動.
 *
 * 同步的狀態（sync_meta）只留不含金鑰的鍵：同步空間的 id、上次同步的序號與時間、雲端已刪除的記號、
 * 記得的裝置（只有公開金鑰）. 換金鑰的進度與接手的進度不帶出去. 從匯出的檔案匯入回來時同步照常.
 */
import type { Database, Sqlite3Static } from "@sqlite.org/sqlite-wasm";

/** 匯出時 sync_meta 留下的鍵（同步引擎 packages/core/src/device-sync/engine.ts 用到的、不含金鑰的） */
export const EXPORTED_SYNC_META = ["space", "last_seq", "last_sync", "gone", "known_devices"] as const;

/** 在複製的那份執行 */
export const EXPORT_CLEANUP_SQL = `DELETE FROM sync_meta WHERE k NOT IN (${EXPORTED_SYNC_META.map((k) => `'${k}'`).join(", ")});`;

/** 回傳匯出的檔案內容 */
export function exportCopy(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  const bytes = sqlite3.capi.sqlite3_js_db_export(db);
  const copy = new sqlite3.oo1.DB(":memory:");
  try {
    // 交給 SQLite 管的記憶體（關掉時釋放）
    const data = sqlite3.wasm.allocFromTypedArray(bytes);
    const { capi } = sqlite3;
    const rc = capi.sqlite3_deserialize(copy.pointer!, "main", data, bytes.byteLength, bytes.byteLength, capi.SQLITE_DESERIALIZE_FREEONCLOSE | capi.SQLITE_DESERIALIZE_RESIZEABLE);
    copy.checkRc(rc);
    const hasMeta = copy.selectValue("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sync_meta'") !== undefined;
    if (hasMeta) copy.exec(EXPORT_CLEANUP_SQL);
    // 刪掉的內容不留在檔案的空頁裡
    copy.exec("VACUUM");
    return capi.sqlite3_js_db_export(copy);
  } finally {
    copy.close();
  }
}
