import { TERMS_SHORT } from "@running-coach/core";

/**
 * 使用須知（規格 12.32）：建置時另外輸出的靜態頁. App 裡點這個連結時，App.tsx 攔下來在面板打開（KI-046），
 * 不開新分頁；同一份內容，從外面直接打開的人看靜態頁
 */
export const TERMS_URL = `${import.meta.env.BASE_URL}terms`;

export function TermsLink({ children = "使用須知" }: { children?: string }) {
  return (
    <a href={TERMS_URL}>
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
