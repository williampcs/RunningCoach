/**
 * 多裝置同步的提醒（規格 12.27）：新裝置加入、這台已從同步移除.
 * 顯示在頁面上方的提醒區，不用打開設定也看得到.
 */
import { useState } from "react";

import type { SyncDevice } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { deleteDeviceIdentity } from "../device-identity";
import { SEEN_KEY } from "../device-sync";
import { clearSettings } from "../settings";

/**
 * 這台已從同步移除（規格 12.27）：同步金鑰、API key 與裝置金鑰清掉了，訓練資料留著.
 * 記在 localStorage，直到使用者按「知道了」、清除這台的資料，或重新開始同步
 */
export const REMOVED_KEY = "zone2mate.sync.removed";

export function removedHere(): boolean {
  try {
    return localStorage.getItem(REMOVED_KEY) === "1";
  } catch {
    return false;
  }
}

export function markRemoved(): void {
  try {
    localStorage.setItem(REMOVED_KEY, "1");
    localStorage.removeItem(SEEN_KEY);
  } catch {
    // 記不住就不顯示說明
  }
}

export function clearRemoved(): void {
  try {
    localStorage.removeItem(REMOVED_KEY);
  } catch {
    // 記不住也沒關係
  }
}

/** 例：10/27 14:03 */
export function deviceTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

export const deviceName = (d: SyncDevice) => d.label?.name || "無法驗證的裝置";

/** 這台已從同步移除：說明，加上匯出、清除這台的資料、用這台的資料重新開始同步 */
export function RemovedBanner({ onDismiss }: { onDismiss: () => void }) {
  const { db, coach, showDevices } = useApp();
  const [error, setError] = useState<string | null>(null);

  async function exportHere() {
    setError(null);
    try {
      const bytes = await db.exportFile();
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/vnd.sqlite3" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `running-coach-${coach.today()}.db`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(`匯出失敗：${errorText(e)}`);
    }
  }

  async function clearHere() {
    if (!confirm("清除這台的所有資料與設定（對話、訓練紀錄、賽事、課表、選手資料）？無法復原；要留一份請先按「匯出」。")) return;
    setError(null);
    try {
      await db.reset();
      clearSettings();
      try {
        localStorage.clear();
      } catch {
        // 讀不到 localStorage 時沒有東西要清
      }
      await deleteDeviceIdentity();
      location.reload();
    } catch (e) {
      setError(`清除失敗：${errorText(e)}`);
    }
  }

  return (
    <div className="notice warn removed-banner" role="status">
      <span>
        <strong>這台已從多裝置同步移除。</strong>這台的同步金鑰與 API key 已經清掉，訓練資料、選手資料與對話還留在這台。
        要保留就「匯出」；不要了就「清除這台的資料」。
      </span>
      <span className="small">
        如果不是你自己移除的，你的復原碼可能已經外流：可以「用這台的資料重新開始同步」，產生新的同步空間與新的復原碼，你的其他裝置再重新加入。
      </span>
      <span className="actions">
        <button className="text" onClick={() => void exportHere()}>
          匯出
        </button>
        <button className="text danger" onClick={() => void clearHere()}>
          清除這台的資料
        </button>
        <button className="text" onClick={showDevices}>
          用這台的資料重新開始同步
        </button>
        <button
          className="text"
          onClick={() => {
            clearRemoved();
            onDismiss();
          }}
        >
          知道了
        </button>
      </span>
      {error && <span className="small">{error}</span>}
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
      <span className="actions">
        <button className="text" onClick={showDevices}>
          查看與移除
        </button>
        <button className="text" onClick={() => deviceSync.acknowledge(fresh.map((d) => d.id))}>
          是我的
        </button>
      </span>
    </div>
  );
}
