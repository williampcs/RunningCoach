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
