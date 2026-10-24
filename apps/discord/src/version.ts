/** 版號（規格 12.19）：和網頁版同一個來源，repo 根目錄的 package.json；建置時 esbuild 會把它打包進去 */
import rootPackage from "../../../package.json" with { type: "json" };

export const VERSION = rootPackage.version;
/** 正式版之前標示 Beta，和網頁版一樣 */
export const VERSION_LABEL = `v${VERSION} Beta`;
