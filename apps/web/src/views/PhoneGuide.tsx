import { NO_RUNS_HINT } from "@running-coach/core";

import type { Notice } from "../use-sync";

/** 沒有 Garmin 等手錶、只用 iPhone 或 Apple Watch 時，把跑步送進 Intervals.icu 的方式 */
export function PhoneGuide() {
  return (
    <details className="phone-guide small">
      <summary>只用 iPhone 或 Apple Watch？</summary>
      <p>瀏覽器讀不到 iPhone「健康」的資料，要先用其他 App 把跑步上傳到 Intervals.icu：</p>
      <ol className="guide">
        <li>
          在 App Store 安裝{" "}
          <a href="https://apps.apple.com/app/id6739638454" target="_blank" rel="noreferrer">
            Intervals.icu Companion
          </a>
          。這是第三方 App，與 Zone2Mate 無關；免費下載，部分功能需要內購。我們還沒有實測過。
        </li>
        <li>
          用 Intervals.icu 帳號登入，開啟運動的同步。有 Apple Watch 的話，也開啟每日健康資料（HRV、睡眠、靜息心率）的同步，教練就能參考恢復狀況。
        </li>
        <li>
          用「健身」App 的體能訓練（選戶外跑步），或其他會把運動寫進「健康」的 App 記錄跑步。在「健康」手動補登的運動不會自動上傳；記成走路的，教練也讀不到。只有 iPhone、沒有手錶時，沒有心率也沒有恢復資料：教練會改看配速和你回報的體感，身體狀況可以每天在教練動態回報。
        </li>
        <li>等 Companion 上傳後，回到這裡同步。過去的紀錄可能無法一次補上傳。</li>
      </ol>
      <p>
        已經用 Garmin 等手錶直接連 Intervals.icu 的話，不要再開 Companion 的運動同步：手錶的紀錄也會寫進「健康」，同一趟會傳兩次。萬一重複了，教練會自動合併，只算一次。
      </p>
    </details>
  );
}

/** 同步結果；同步不到跑步時附上 iPhone 的上傳方式 */
export function SyncNotice({ message }: { message: Notice | null }) {
  if (!message) return null;
  return (
    <div className={`notice ${message.kind}`}>
      {message.text}
      {message.text.includes(NO_RUNS_HINT) && <PhoneGuide />}
    </div>
  );
}
