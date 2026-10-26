import { useApp } from "../app-context";
import { featureEnabled } from "../environment";
import type { useSync } from "../use-sync";
import { SyncNotice } from "./PhoneGuide";

/**
 * 第一次抓跑步紀錄（規格 11 #24）：新手引導、設定頁的下一步、紀錄頁還沒有跑步時共用.
 * 選最近 14 天（每一趟都有分析），或全部（先同步最近 14 天，再匯入更早的、不產生分析）.
 * sync 由外層持有：抓完之後這裡會消失，結果要留在外層顯示
 */
export function FirstSync({ sync, disabled = false }: { sync: ReturnType<typeof useSync>; disabled?: boolean }) {
  const { coach } = useApp();
  const canAll = coach.canImportHistory;
  return (
    <>
      <ul className="small muted first-sync">
        <li>
          {featureEnabled("multisport")
            ? "「同步最近 14 天」：最近兩週的跑步、騎車等運動與恢復資料，每一趟跑步都產生一段教練的分析（花一點模型的費用）。"
            : "「同步最近 14 天」：最近兩週的跑步與恢復資料，每一趟都產生一段教練的分析（花一點模型的費用）。"}
        </li>
        {canAll && <li>「匯入全部的紀錄」：先同步最近 14 天，再把更早的跑步全部存進來；更早的不產生分析、不花模型的費用，可能要一兩分鐘。</li>}
      </ul>
      <div className="row wrap">
        <button className="primary" disabled={disabled || sync.busy} onClick={() => void sync.run()}>
          {sync.busy && !sync.progress ? "同步中…" : "同步最近 14 天"}
        </button>
        {canAll && (
          <button disabled={disabled || sync.busy} onClick={() => void sync.runAll()}>
            {sync.busy ? "處理中…" : "匯入全部的紀錄"}
          </button>
        )}
      </div>
      {sync.progress && (
        <div className="import-progress" role="status">
          <div className="indeterminate" />
          <span className="small">
            正在讀 {sync.progress.oldest} – {sync.progress.newest} 的跑步…已找到 {sync.progress.found} 趟
          </span>
        </div>
      )}
      <SyncNotice message={sync.message} />
    </>
  );
}
