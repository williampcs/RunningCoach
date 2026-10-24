import { IS_STAGING } from "../environment";

/** staging：每一頁上方提醒這不是正式版（規格 12.19） */
export function StagingBanner() {
  if (!IS_STAGING) return null;
  return (
    <div className="notice info staging-banner">
      <span>
        <strong>Staging</strong>：還沒上線的測試版，資料與同步都和正式版分開。
      </span>
    </div>
  );
}
