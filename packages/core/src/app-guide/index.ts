/**
 * App 的功能說明（規格 12.12）：教練用 get_app_help 查，網頁版的「使用說明」頁也顯示同一份.
 * 網頁版與 Discord bot 的操作不同，各一份. 說明裡用「」括起來的是畫面上的名稱，
 * 測試會確認網頁版的程式裡真的有（改了按鈕名稱卻忘了改說明時測試失敗）；舉例的說法用“”.
 */
import { DISCORD_GUIDE } from "./discord";
import { WEB_GUIDE } from "./web";

export type Shell = "web" | "discord";

export interface GuideSection {
  /** 網址與工具用的代號，例：device-sync */
  id: string;
  title: string;
  /** 搜尋用的其他說法 */
  keywords: string[];
  /** Markdown */
  body: string;
}

export function appGuide(shell: Shell): GuideSection[] {
  return shell === "web" ? WEB_GUIDE : DISCORD_GUIDE;
}

/** 依代號、標題、其他說法或內容找；代號完全相同的優先 */
export function findGuide(shell: Shell, query: string): GuideSection[] {
  const sections = appGuide(shell);
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact = sections.filter((s) => s.id === q);
  if (exact.length) return exact;
  const words = q.split(/[\s,，、]+/).filter(Boolean);
  const score = (s: GuideSection) => {
    const head = [s.id, s.title, ...s.keywords].join(" ").toLowerCase();
    return words.reduce((n, w) => n + (head.includes(w) ? 3 : 0) + (s.body.toLowerCase().includes(w) ? 1 : 0), 0);
  };
  const ranked = sections
    .map((s) => ({ s, n: score(s) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n);
  // 有標題或其他說法對上的，只回那些；都只是內容提到時，才回內容最相關的
  const floor = (ranked[0]?.n ?? 0) >= 3 ? 3 : 1;
  return ranked
    .filter((x) => x.n >= floor)
    .slice(0, 2)
    .map((x) => x.s);
}

/** 系統提示裡列的主題：只有代號與標題，內容要用的時候才查 */
export function guideTopics(shell: Shell): string {
  return appGuide(shell)
    .map((s) => `${s.id}（${s.title}）`)
    .join("、");
}
