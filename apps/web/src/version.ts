/** 對外的版本號。正式版之前標示 Beta，讓使用者知道還在測試中 */
export const BUILD = __APP_BUILD__;
export const VERSION_LABEL = `v${BUILD.version} Beta`;
export const BUILD_DETAIL = `${VERSION_LABEL}（${BUILD.commit}，${BUILD.date} 建置）`;
