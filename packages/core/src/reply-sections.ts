/**
 * 教練的長回覆（規格 12.30 第 2 點）：第一個小標（`## `）之前是結論，之後每個小標一段.
 * 網頁版把結論一直顯示、每段收成一列；對話紀錄、搜尋、回覆引用照舊用完整的內容
 */
export interface ReplySection {
  title: string;
  body: string;
}

export interface ReplySections {
  /** 第一個小標之前的內容（結論）；沒有小標時是整則回覆 */
  lead: string;
  sections: ReplySection[];
}

const HEADING_START = /^ {0,3}##(?=[ \t])/;
const LINE_BREAK = /[\n\r\u2028\u2029]/;
const isBlank = (c: string | undefined) => c === " " || c === "\t";

/**
 * `## 標題 ##` 的標題；不是小標時回傳 null。等同 `/^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/` 的第一組再 trim，
 * 但不用重疊的量詞，執行時間和長度成線性（規格 12.45 第 8 點）
 */
export function headingTitle(line: string): string | null {
  const start = HEADING_START.exec(line);
  if (!start) return null;
  const rest = line.slice(start[0].length);
  if (rest.length < 2 || LINE_BREAK.test(rest)) return null;
  // 前面的空白（至少一個，留一個字給標題）
  let from = 0;
  while (from < rest.length - 1 && isBlank(rest[from])) from++;
  // 後面的「空白、#、空白」，標題至少一個字
  let to = rest.length;
  while (to > from + 1 && isBlank(rest[to - 1])) to--;
  while (to > from + 1 && rest[to - 1] === "#") to--;
  while (to > from + 1 && isBlank(rest[to - 1])) to--;
  return rest.slice(from, to).trim();
}
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** 依 `## ` 小標切段；程式碼區塊裡的不算；`#`、`###` 等其他層級不切 */
export function splitReplySections(markdown: string): ReplySections {
  const lead: string[] = [];
  const sections: { title: string; lines: string[] }[] = [];
  let fence: string | null = null;
  for (const line of markdown.split("\n")) {
    const open = FENCE.exec(line)?.[1];
    if (fence) {
      if (open && open[0] === fence[0] && open.length >= fence.length) fence = null;
    } else if (open) {
      fence = open;
    } else {
      const title = headingTitle(line);
      if (title !== null) {
        sections.push({ title, lines: [] });
        continue;
      }
    }
    (sections.at(-1)?.lines ?? lead).push(line);
  }
  return {
    lead: lead.join("\n").trim(),
    sections: sections.map((s) => ({ title: s.title, body: s.lines.join("\n").trim() })),
  };
}
