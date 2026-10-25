/** 隱私說明頁（規格 12.20）：建置時另外輸出的靜態頁，在新分頁打開，App 裡打到一半的東西不受影響 */
export const PRIVACY_URL = `${import.meta.env.BASE_URL}privacy`;

export function PrivacyLink({ children = "隱私說明" }: { children?: string }) {
  return (
    <a href={PRIVACY_URL} target="_blank" rel="noreferrer">
      {children}
    </a>
  );
}
