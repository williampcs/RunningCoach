/**
 * 隱私說明頁（規格 12.20）：建置時把 page.html 填入這次建置的環境，輸出成 privacy.html 與 privacy.css
 * （Cloudflare Pages 把 privacy.html 提供在 /privacy）. 頁面不用 JavaScript，套用和 App 一樣的安全標頭與 CSP.
 *
 * 頁面的每一句都對照程式寫：改了資料存在哪裡、送到哪裡、送了什麼時，page.html 要跟著改，並在最下面的異動紀錄加一行.
 * 網頁版預設會連的外部網址都要寫在頁面上（apps/web/test/privacy-page.test.ts 會檢查）.
 */
import { readFileSync } from "node:fs";

export const PRIVACY_HTML_FILE = "privacy.html";
export const PRIVACY_CSS_FILE = "privacy.css";

export interface PrivacyBuild {
  /** staging 的建置（VITE_STAGING=1）：頁面上方標示 Staging，不讓搜尋引擎收錄 */
  staging: boolean;
  /** 這次建置的同步服務網址（VITE_SYNC_URL）；沒有設定時為空 */
  syncUrl: string;
  /** 功能開關 devices（裝置清單與移除，規格 12.27）開著：多寫伺服器多知道的事 */
  devices?: boolean;
}

const read = (name: string) => readFileSync(new URL(`./${name}`, import.meta.url), "utf8");

const escapeHtml = (text: string) => text.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

/** 同步服務的主機名稱：網址不正確時為 null */
function hostOf(url: string): string | null {
  try {
    return url.trim() ? new URL(url.trim()).host : null;
  } catch {
    return null;
  }
}

export function renderPrivacyPage(build: PrivacyBuild): string {
  const host = hostOf(build.syncUrl);
  const replacements: Record<string, string> = {
    "<!--HEAD-->": build.staging ? '<meta name="robots" content="noindex" />' : "",
    "<!--STAGING-->": build.staging
      ? '<div class="staging-banner"><strong>Staging</strong>：還沒上線的測試版，資料與同步都和正式版分開。</div>'
      : "",
    "<!--SYNC_HOST-->": host ? `<code>${escapeHtml(host)}</code>` : "這個版本沒有設定同步服務",
    "<!--DEVICES-->": build.devices
      ? "<li>每台裝置：隨機的裝置代號、這台的兩把公開金鑰（驗證這台的請求、換金鑰時把新的金鑰加密給它）、加入與最後同步的時間、是否已被移除；裝置的名稱與平台以同步金鑰加密，我們看不到。所以同步服務知道一個同步空間有幾台、各自什麼時候加入與最後同步，但不知道是哪些裝置、是誰的；</li>" +
        "<li>換過金鑰（移除某台）的同步空間：要搬到哪個新的空間、給留下的每台加密後的新同步金鑰、被移除的裝置的證明（都是加密或雜湊過的，我們解不開）；舊空間的資料在換金鑰時刪掉；</li>" +
        "<li>每個請求的一次性亂數，用來擋下重送的請求，十分鐘後刪除。</li>"
      : "",
    "<!--DEVICES_NOTE-->": build.devices
      ? "<li>移除某台裝置時，被移除的那台之後連不上同步，下次打開時會清掉它自己的資料；但它在移除前已經下載的資料我們收不回來。</li>"
      : "",
    "<!--DEVICES_CHANGE-->": build.devices ? "<li>2026-10-27：多裝置同步可以看到有哪些裝置、移除某台（同步服務多記每台的公開金鑰與時間）。</li>" : "",
  };
  let html = read("page.html");
  for (const [mark, value] of Object.entries(replacements)) {
    if (!html.includes(mark)) throw new Error(`隱私說明頁的範本少了 ${mark}`);
    html = html.replace(mark, value);
  }
  return html;
}

export function privacyCss(): string {
  return read("page.css");
}
