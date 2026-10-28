/**
 * 就醫提示（規格 12.33 第 4 點）：選手的訊息、自評的備註、運動回報的感受裡出現紅旗的字詞時，
 * 畫面上直接出現一則就醫提示（停止運動、必要時撥 119）. 由程式比對字詞，不靠模型：模型可能漏掉或說得太輕.
 *
 * 寧可多提示：提示可以按「我知道了」收起，漏掉的代價比較大. 只排除明確的否定（「沒有胸痛」「不會胸悶」）
 * 與預防的說法（「預防中暑」）；問句（「胸痛怎麼辦」）照樣提示.
 * 改清單時一起改 packages/core/test/red-flags.test.ts（包括不誤判的例子）.
 */

export interface RedFlagTerm {
  /** 畫面上的說法 */
  label: string;
  /** 比對的寫法（繁體與常見的簡體、口語的變化） */
  patterns: string[];
}

/** 紅旗的字詞：和使用須知第 3 節「立刻停止並就醫」一致 */
export const RED_FLAG_TERMS: RedFlagTerm[] = [
  { label: "胸痛", patterns: ["胸痛", "胸口痛", "胸口很痛", "胸部疼痛", "胸口疼", "心口痛", "心臟痛", "心絞痛"] },
  { label: "胸悶", patterns: ["胸悶", "胸口悶", "胸口緊", "胸口有壓迫", "胸口壓迫", "胸口好悶", "胸口很悶", "胸口重重的"] },
  { label: "昏倒", patterns: ["昏倒", "暈倒", "昏厥", "暈厥", "昏過去", "暈過去", "失去意識", "快昏倒", "快暈倒", "差點昏倒", "差點暈倒", "眼前發黑", "眼前一黑"] },
  { label: "心悸", patterns: ["心悸", "心跳很亂", "心跳亂", "心跳不規則", "心律不整", "心跳忽快忽慢", "心跳漏拍", "心臟亂跳"] },
  { label: "喘不過氣", patterns: ["喘不過氣", "喘不過來", "吸不到氣", "吸不到空氣"] },
  { label: "呼吸困難", patterns: ["呼吸困難", "不能呼吸", "無法呼吸", "呼吸不過來"] },
  { label: "意識不清", patterns: ["意識不清", "意識模糊", "神智不清", "意識混亂", "不知道自己在哪"] },
  { label: "中暑", patterns: ["中暑", "熱衰竭", "熱射病", "停止流汗", "不再流汗", "流不出汗"] },
];

/** 字詞前面緊接著這些時是否定或預防，不算（中間可以有「什麼」「任何」「明顯的」等） */
const NEGATION = /(沒有|沒|不會|不曾|不再|並無|毫無|無|未|預防|避免|防止|小心|以免|怕)(什麼|任何|明顯的?|再|感到|覺得|出現|發生)?$/;
/** 列舉的連接：「沒有胸痛或胸悶」的胸悶也算否定 */
const JOINER = /^[\s、，,或和跟及與也]*$/;

/** 從文字裡找出紅旗的字詞；沒有時是空陣列. 回傳畫面上的說法，依出現的順序、不重複 */
export function detectRedFlags(text: string | null | undefined): string[] {
  if (!text) return [];
  const hits: { at: number; end: number; label: string; negated: boolean }[] = [];
  for (const term of RED_FLAG_TERMS) {
    for (const pattern of term.patterns) {
      let from = 0;
      for (let at = text.indexOf(pattern, from); at >= 0; at = text.indexOf(pattern, from)) {
        hits.push({ at, end: at + pattern.length, label: term.label, negated: false });
        from = at + pattern.length;
      }
    }
  }
  hits.sort((a, b) => a.at - b.at || b.end - a.end);
  // 重疊的只留最前面、最長的那個寫法（例：「快昏倒」不再另外算「昏倒」）
  const kept: typeof hits = [];
  for (const h of hits) if (!kept.length || h.at >= kept.at(-1)!.end) kept.push(h);
  for (const [i, h] of kept.entries()) {
    const before = text.slice(Math.max(0, h.at - 6), h.at);
    if (NEGATION.test(before)) h.negated = true;
    else if (i > 0 && kept[i - 1]!.negated && JOINER.test(text.slice(kept[i - 1]!.end, h.at))) h.negated = true;
  }
  return [...new Set(kept.filter((h) => !h.negated).map((h) => h.label))];
}

/** 就醫提示的內容（網頁版的提示與看板共用） */
export function redFlagAdvice(labels: string[]): { title: string; detail: string } {
  return {
    title: "請先停止運動，盡快就醫",
    detail:
      `你提到「${labels.join("、")}」。運動中或運動後出現胸痛、胸悶、昏倒、不尋常的心悸或喘不過氣、在高溫下頭暈或意識不清，` +
      "請立刻停止運動並就醫；情況緊急請撥 119。教練不能判斷原因，請以醫師的意見為準。",
  };
}
