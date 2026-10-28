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

const HEADING = /^ {0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/;
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
      const heading = HEADING.exec(line);
      if (heading) {
        sections.push({ title: heading[1]!.trim(), lines: [] });
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
