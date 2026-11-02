/**
 * 「先看看」（規格 12.35 的 B）：新的使用者還沒設定前，用範例的資料逛課表、紀錄、看板與選手頁.
 *
 * - 資料庫只在記憶體裡（db/worker.ts 的 `:memory:`），不碰 OPFS 上真的資料庫；離開（開始設定、關掉分頁）就清掉.
 * - 不讀這個瀏覽器存的設定與 key、不同步、不匯出、不連任何外部服務（活動來源是假的、沒有天氣、AI 不打）.
 * - 狀態記在 sessionStorage：重新整理還在範例裡，關掉分頁就結束.
 */
import { featureEnabled } from "./environment";

const KEY = "zone2mate.demo";
/** 範例的資料庫：只在記憶體裡 */
export const DEMO_DB_FILE = ":memory:";

function read(): boolean {
  try {
    return sessionStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

/** 這次打開是範例嗎（功能開關 onboarding 關著時一律不是） */
export const DEMO = featureEnabled("onboarding") && read();

/** 進入範例：重新載入，換成記憶體裡的資料庫 */
export function startDemo(): void {
  try {
    sessionStorage.setItem(KEY, "1");
  } catch {
    // 存不了就只能這次：重新載入後不是範例，照常打開
  }
  location.reload();
}

/** 離開範例（開始設定）：重新載入，回到真的資料庫；範例的資料在記憶體裡，跟著消失 */
export function endDemo(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // 略過
  }
  location.reload();
}
