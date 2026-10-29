/**
 * 隱私說明頁（規格 12.20）：建置時另外輸出的靜態頁. App 裡點這個連結時，App.tsx 攔下來在面板打開（KI-046），
 * 不開新分頁；同一份內容，從外面直接打開的人看靜態頁
 */
export const PRIVACY_URL = `${import.meta.env.BASE_URL}privacy`;

export function PrivacyLink({ children = "隱私說明" }: { children?: string }) {
  return (
    <a href={PRIVACY_URL}>
      {children}
    </a>
  );
}
