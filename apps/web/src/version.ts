import { IS_STAGING } from "./environment";

/** 對外的版本號（規格 12.19）。正式版之前標示 Beta，讓使用者知道還在測試中 */
export const BUILD = __APP_BUILD__;
/** 標題列只顯示階段；完整的版號在設定頁最下面。staging 標示 Staging，和正式版分得出來 */
export const STAGE_LABEL = IS_STAGING ? "Staging" : "Beta";
export const VERSION_LABEL = `v${BUILD.version} ${STAGE_LABEL}`;
export const BUILD_DETAIL = `${VERSION_LABEL}（${BUILD.commit}，${BUILD.date} 建置）`;
