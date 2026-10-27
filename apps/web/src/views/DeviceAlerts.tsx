/**
 * 多裝置同步的提醒（規格 12.27）：新裝置加入、這台已從同步移除.
 * 顯示在頁面上方的提醒區，不用打開設定也看得到.
 */
import type { SyncDevice } from "@running-coach/core";

import { useApp } from "../app-context";

/** 這台被移除、資料清掉後重新載入：記在 sessionStorage，重新載入後顯示說明 */
export const REMOVED_KEY = "zone2mate.sync.removed";

export function removedHere(): boolean {
  try {
    return sessionStorage.getItem(REMOVED_KEY) === "1";
  } catch {
    return false;
  }
}

/** 例：10/27 14:03 */
export function deviceTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const deviceName = (d: SyncDevice) => d.label?.name || "無法驗證的裝置";

export function RemovedBanner({ onDismiss }: { onDismiss: () => void }) {
  return (
    <div className="notice warn removed-banner" role="status">
      <span>
        <strong>這台已從多裝置同步移除。</strong>是你的另一台裝置把它移除的；這台的資料（對話、紀錄、設定與 API key）已經清除。
        如果這台是你的、要繼續用，重新設定後再用配對或新的復原碼加入同步。
      </span>
      <button
        className="update-dismiss"
        aria-label="知道了"
        title="知道了"
        onClick={() => {
          try {
            sessionStorage.removeItem(REMOVED_KEY);
          } catch {
            // 記不住也沒關係
          }
          onDismiss();
        }}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );
}

/** 「新裝置加入：iPhone · Safari（10/27 14:03）。不是你的？」 */
export function NewDevicesBanner() {
  const { deviceSync, showDevices } = useApp();
  const fresh = deviceSync.newDevices;
  if (!fresh.length) return null;
  return (
    <div className="notice warn new-device-banner" role="status">
      <span>
        新裝置加入同步：
        {fresh.map((d, i) => (
          <span key={d.id}>
            {i > 0 && "、"}
            <strong>{deviceName(d)}</strong>（{deviceTime(d.joinedAt)}）
          </span>
        ))}
        。不是你的？
      </span>
      <span className="row">
        <button className="link" onClick={showDevices}>
          查看與移除
        </button>
        <button className="link" onClick={() => deviceSync.acknowledge(fresh.map((d) => d.id))}>
          是我的
        </button>
      </span>
    </div>
  );
}
