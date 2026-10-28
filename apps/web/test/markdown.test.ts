import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Markdown } from "../src/Markdown";

const html = (text: string) => renderToStaticMarkup(createElement(Markdown, { children: text }));

describe("網頁版的 Markdown", () => {
  it("中文標點旁的粗體顯示成粗體、沒有星號（規格 12.30）", () => {
    const out = html("**週末長跑照排。**這週量比平常多一成");
    expect(out).toContain("<strong>週末長跑照排。</strong>這週");
    expect(out).not.toContain("**");
    expect(html("先保留強度（**少一組**）。")).toContain("<strong>少一組</strong>");
  });

  it("表格、刪除線照舊（GFM）；不顯示圖片", () => {
    expect(html("| a | b |\n|---|---|\n| 1 | 2 |")).toContain("<table>");
    expect(html("~~取消~~")).toContain("<del>取消</del>");
    expect(html("![x](https://example.com/x.png)")).not.toContain("<img");
  });
});
