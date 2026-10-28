/**
 * 使用須知（規格 12.32）：完整版是網頁版的靜態頁（apps/web/terms/page.html，提供在 /terms），
 * 這裡是 App 與 Discord 共用的精簡版與版本號.
 *
 * 使用須知有重大修改時把 TERMS_VERSION 加一、TERMS_UPDATED 改成那天：網頁版會請每個人再確認一次.
 * 文字或排版的小修改不用改版本號，只改頁面上的「最後更新」.
 */

/** 使用須知的版本：使用者確認過的版本比這個舊時，再請他確認一次 */
export const TERMS_VERSION = 1;

/** 這一版使用須知的日期（頁面上的「最後更新」） */
export const TERMS_UPDATED = "2026-10-28";

/** 精簡版：對話輸入框下方、新手引導、Discord 的說明都用這一句，後面接「使用須知」的連結 */
export const TERMS_SHORT = "教練是 AI，建議僅供參考，不能取代醫師或專業教練；身體不適請停止訓練並就醫。";
