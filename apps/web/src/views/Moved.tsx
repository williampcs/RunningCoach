import { useState } from "react";

import { errorText, useApp } from "../app-context";
import { MOVED_TO } from "../environment";
import { clearSettings } from "../settings";

/*
 * 舊網址的搬家提示（規格 12.19）：舊網址 running-coach-bgb.pages.dev 和新網址是同一份建置，
 * 從不是正式網址（Variables 的 WEB_URL）的地方打開時才顯示。做法沿用搬到 Cloudflare Pages 時的版本（12.13）。
 */

const CLEARED_KEY = "moved-cleared";

/** 這個分頁剛清除過這個網址的資料（清除後會重新載入） */
function clearedHere(): boolean {
  try {
    return sessionStorage.getItem(CLEARED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 每一頁上方：已搬家 */
export function MovedBanner() {
  const { goTo } = useApp();
  if (!MOVED_TO) return null;
  if (clearedHere()) {
    return (
      <div className="notice ok moved">
        <span>
          這個網址的資料已經清除。之後請用新網址：<a href={MOVED_TO}>{MOVED_TO.replace(/^https:\/\//, "")}</a>
        </span>
      </div>
    );
  }
  return (
    <div className="notice warn moved">
      <span>
        <strong>網頁版搬到新網址了：</strong>
        <a href={MOVED_TO}>{MOVED_TO.replace(/^https:\/\//, "")}</a>
      </span>
      <span className="small">
        這裡的資料不會自動搬過去。開了多裝置同步的話，在新網址用配對或復原碼加入；沒開的話，先到設定頁「匯出資料庫」，再到新網址「匯入資料庫」。API key 要在新網址重新填；加到主畫面的，從新網址重新加入主畫面。
      </span>
      <button className="link small" onClick={() => goTo("settings")}>
        搬好了，清除這裡的資料
      </button>
    </div>
  );
}

/** 設定頁最上面：確認新網址已經有資料後，清除這個舊網址留在瀏覽器裡的資料 */
export function MovedCard() {
  const { db, deviceSync } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 清除後重新載入（記憶體裡的設定與同步也一起清掉），重新載入後顯示已清除
  const [done] = useState(clearedHere);
  if (!MOVED_TO) return null;

  async function clearHere() {
    const what = deviceSync.enabled
      ? "清除這個舊網址留在這個瀏覽器的資料（對話、紀錄、設定、API key 與同步金鑰）？雲端的同步資料與其他裝置不受影響。"
      : "清除這個舊網址留在這個瀏覽器的資料（對話、紀錄、設定與 API key）？這台沒有開同步，請確定已經匯出並在新網址匯入。";
    if (!confirm(`${what}\n無法復原，確定要繼續嗎？`)) return;
    setBusy(true);
    setError(null);
    try {
      // 先停掉這台的同步再清，清除的過程中不會再送出或取回
      await deviceSync.engine?.forget();
      await db.reset();
      clearSettings();
      try {
        // 這個網址只有這個 App：設定以外的小東西（教練動態、提示的關閉狀態、測試模式）也一起清掉
        localStorage.clear();
      } catch {
        // 讀不到 localStorage 時沒有東西要清
      }
      try {
        sessionStorage.setItem(CLEARED_KEY, "1");
      } catch {
        // 記不住就不顯示「已清除」，資料一樣清掉了
      }
      location.reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card moved">
      <h2>網頁版搬家了</h2>
      {done ? (
        <div className="notice ok">
          <span>
            這個網址的資料已經清除。之後請用新網址：<a href={MOVED_TO}>{MOVED_TO}</a>
          </span>
        </div>
      ) : (
        <>
          <p className="small">
            新網址：<a href={MOVED_TO}>{MOVED_TO}</a>。新網址和這裡的資料是分開存的：
          </p>
          <ol className="small">
            <li>開了多裝置同步：先在這裡按「立即同步裝置」，再到新網址「用復原碼還原」，或在新網址按「加入已經在同步的裝置」、用這裡配對。</li>
            <li>沒開同步：在這裡「匯出資料庫」，到新網址「匯入資料庫」。</li>
            <li>在新網址重新填 API key，按「同步最近 14 天」。</li>
            <li>加到主畫面的：刪掉舊的圖示，從新網址重新加入主畫面（見使用說明的「加入主畫面」）。</li>
            <li>確認新網址的資料都在之後，回來這裡清除。</li>
          </ol>
          {deviceSync.enabled && (
            <p className="small muted">
              這台的同步：{deviceSync.lastAt ? `上次同步 ${new Date(deviceSync.lastAt).toLocaleString("zh-TW")}` : "還沒同步過"}
              {deviceSync.error ? `（${deviceSync.error}）` : ""}
            </p>
          )}
          <div className="row wrap">
            {deviceSync.enabled && (
              <button disabled={deviceSync.busy || busy} onClick={() => void deviceSync.run()}>
                {deviceSync.busy ? "同步中…" : "立即同步裝置"}
              </button>
            )}
            <button className="danger" disabled={busy} onClick={() => void clearHere()}>
              {busy ? "清除中…" : "清除這個網址的資料"}
            </button>
          </div>
          {error && <div className="notice error">{error}</div>}
        </>
      )}
    </section>
  );
}
