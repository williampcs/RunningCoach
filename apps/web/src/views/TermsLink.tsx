import { TERMS_SHORT } from "@running-coach/core";

/** 使用須知（規格 12.32）：建置時另外輸出的靜態頁，在新分頁打開，App 裡打到一半的東西不受影響 */
export const TERMS_URL = `${import.meta.env.BASE_URL}terms`;

export function TermsLink({ children = "使用須知" }: { children?: string }) {
  return (
    <a href={TERMS_URL} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}

/** 精簡版一句＋「使用須知」的連結：對話輸入框下方一直顯示，新手引導與確認的畫面也用 */
export function TermsShort({ className = "terms-short" }: { className?: string }) {
  return (
    <p className={`terms-line ${className}`}>
      {TERMS_SHORT}
      <TermsLink />
    </p>
  );
}
