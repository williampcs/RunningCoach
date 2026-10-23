/** 預覽版的建置（規格 12.13）：資料和正式版分開，不連同步服務 */
export const IS_PREVIEW = import.meta.env.VITE_PREVIEW === "1";

/** 預覽版：每一頁上方提醒資料與正式版分開 */
export function PreviewBanner() {
  if (!IS_PREVIEW) return null;
  return (
    <div className="notice info preview">
      <span>
        <strong>預覽版</strong>：還沒上線的版本，資料和正式版分開存，也不連多裝置同步；測完可以直接關掉。
      </span>
    </div>
  );
}
