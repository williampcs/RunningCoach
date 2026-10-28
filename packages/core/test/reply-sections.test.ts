import { describe, expect, it } from "vitest";

import { splitReplySections } from "../src/reply-sections";

describe("教練的長回覆依小標切段", () => {
  it("第一個小標之前是結論，之後每個小標一段", () => {
    const reply = "週四的閾值課縮短成 3 × 1.5 km，週末長跑照排。\n\n## 這週的狀況\n跑了 32 km。\n\n- 心率漂移有點大\n\n## 週四的閾值課 ##\n改成 3 × 1.5 km。\n";
    expect(splitReplySections(reply)).toEqual({
      lead: "週四的閾值課縮短成 3 × 1.5 km，週末長跑照排。",
      sections: [
        { title: "這週的狀況", body: "跑了 32 km。\n\n- 心率漂移有點大" },
        { title: "週四的閾值課", body: "改成 3 × 1.5 km。" },
      ],
    });
  });

  it("沒有小標時不切；其他層級的標題不切", () => {
    expect(splitReplySections("今天休息就好。\n\n- 睡飽一點")).toEqual({ lead: "今天休息就好。\n\n- 睡飽一點", sections: [] });
    expect(splitReplySections("# 大標\n### 小小標\n內容").sections).toEqual([]);
    expect(splitReplySections("##沒有空格不是小標").sections).toEqual([]);
  });

  it("程式碼區塊裡的 ## 不算", () => {
    const reply = "結論。\n\n```\n## 不是小標\n```\n\n~~~md\n## 也不是\n```\n~~~\n## 真的小標\n內容";
    const { lead, sections } = splitReplySections(reply);
    expect(lead).toBe("結論。\n\n```\n## 不是小標\n```\n\n~~~md\n## 也不是\n```\n~~~");
    expect(sections).toEqual([{ title: "真的小標", body: "內容" }]);
  });

  it("一開始就是小標時沒有結論", () => {
    expect(splitReplySections("## 第一段\n內容")).toEqual({ lead: "", sections: [{ title: "第一段", body: "內容" }] });
  });
});
