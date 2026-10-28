/**
 * 使用須知（規格 12.32）：建置時把 page.html 填入精簡版、版本與這次建置的環境，輸出成 terms.html
 * （Cloudflare Pages 把 terms.html 提供在 /terms）. 和隱私說明頁一樣不用 JavaScript，樣式共用 privacy.css.
 *
 * 內容是使用者同意過的版本（原本的草稿 doc/disclaimer-draft.md）. 有重大修改時，改 page.html、在異動紀錄加一行，
 * 並把 packages/core/src/terms.ts 的 TERMS_VERSION 加一、TERMS_UPDATED 改成那天（App 會請每個人再確認一次）.
 */
import { readFileSync } from "node:fs";

import { TERMS_SHORT, TERMS_UPDATED, TERMS_VERSION } from "../../../packages/core/src/terms";

export const TERMS_HTML_FILE = "terms.html";

const STAGING_BANNER = '<div class="staging-banner"><strong>Staging</strong>：還沒上線的測試版，資料與同步都和正式版分開。</div>';

export function renderTermsPage({ staging }: { staging: boolean }): string {
  const replacements: Record<string, string> = {
    "<!--HEAD-->": staging ? '<meta name="robots" content="noindex" />' : "",
    "<!--STAGING-->": staging ? STAGING_BANNER : "",
    "<!--SHORT-->": TERMS_SHORT,
    "<!--UPDATED-->": TERMS_UPDATED,
    "<!--VERSION-->": String(TERMS_VERSION),
  };
  let html = readFileSync(new URL("./page.html", import.meta.url), "utf8");
  for (const [mark, value] of Object.entries(replacements)) {
    if (!html.includes(mark)) throw new Error(`使用須知的範本少了 ${mark}`);
    html = html.replace(mark, value);
  }
  return html;
}
