/**
 * 使用須知與隱私說明在 App 的面板裡打開（KI-046）：內容取自同一份靜態頁（renderTermsPage、renderPrivacyPage 的結果），
 * 不另外維護一份. 拿掉「← 回到 Zone2Mate」與大標題（標題在面板的標題列）；id 加上前綴，不和 App 的撞名；
 * 外部的網站在新分頁打開，不離開 App. 頁面之間的連結（/terms、/privacy）由 App 攔下來換面板.
 */
export function pageForApp(html: string, prefix: string): string {
  const main = html.match(/<main>([\s\S]*)<\/main>/)?.[1];
  if (main === undefined) throw new Error("靜態頁找不到 <main>");
  return main
    .replace(/\s*<p class="back">[\s\S]*?<\/p>/, "")
    .replace(/\s*<h1>[\s\S]*?<\/h1>/, "")
    .replace(/ (id|aria-labelledby)="([^"]+)"/g, ` $1="${prefix}-$2"`)
    .replace(/<a href="(https?:|mailto:)/g, '<a target="_blank" rel="noreferrer" href="$1')
    .trim();
}
