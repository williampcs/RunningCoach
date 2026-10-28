import { describe, expect, it } from "vitest";

import { detectRedFlags, RED_FLAG_TERMS, redFlagAdvice } from "../src/red-flags";

describe("紅旗字詞的偵測（規格 12.33 第 4 點）", () => {
  it("工作單列的字詞都偵測得到", () => {
    for (const word of ["胸痛", "胸悶", "昏倒", "暈倒", "心悸", "喘不過氣", "呼吸困難", "意識不清", "中暑"]) {
      expect(detectRedFlags(`今天跑步的時候${word}`), word).not.toEqual([]);
    }
  });

  it("每個寫法都會被偵測到（清單裡沒有寫錯或被別的寫法擋掉）", () => {
    for (const term of RED_FLAG_TERMS) for (const p of term.patterns) expect(detectRedFlags(`跑到一半${p}，停下來了`), p).toEqual([term.label]);
  });

  it("口語的說法", () => {
    expect(detectRedFlags("間歇跑到第三趟胸口好悶")).toEqual(["胸悶"]);
    expect(detectRedFlags("昨天長跑最後差點暈倒")).toEqual(["昏倒"]);
    expect(detectRedFlags("跑完心跳很亂，一直停不下來")).toEqual(["心悸"]);
    expect(detectRedFlags("中午跑完頭暈想吐，好像熱衰竭")).toEqual(["中暑"]);
    expect(detectRedFlags("爬坡的時候吸不到氣")).toEqual(["喘不過氣"]);
  });

  it("一則訊息有好幾個時都列出來，依出現的順序、不重複", () => {
    expect(detectRedFlags("跑完胸悶又心悸，休息後還是胸悶")).toEqual(["胸悶", "心悸"]);
    expect(detectRedFlags("胸口痛，然後暈倒了")).toEqual(["胸痛", "昏倒"]);
  });

  it("問句照樣提示（寧可多提示）", () => {
    expect(detectRedFlags("跑步時胸痛該怎麼辦？")).toEqual(["胸痛"]);
  });

  it("否定與預防的說法不提示（不誤判）", () => {
    expect(detectRedFlags("今天跑得很順，沒有胸痛也沒有頭暈")).toEqual([]);
    expect(detectRedFlags("不會胸悶，只是腿很痠")).toEqual([]);
    expect(detectRedFlags("沒有胸悶或心悸")).toEqual([]);
    expect(detectRedFlags("沒有胸悶、心悸、喘不過氣")).toEqual([]);
    expect(detectRedFlags("並無任何心悸")).toEqual([]);
    expect(detectRedFlags("天氣很熱，要怎麼預防中暑？")).toEqual([]);
    expect(detectRedFlags("多喝水以免中暑")).toEqual([]);
    expect(detectRedFlags("無明顯胸痛")).toEqual([]);
  });

  it("否定只管緊接在後面的那幾個，後面另外說的照樣提示", () => {
    expect(detectRedFlags("沒有胸痛，但是跑完一直心悸")).toEqual(["心悸"]);
    expect(detectRedFlags("我沒事，可是剛剛胸悶")).toEqual(["胸悶"]);
  });

  it("和紅旗無關、只是字面相近的不提示（不誤判）", () => {
    for (const text of [
      "今天練了胸肌和背",
      "心跳 165，配速 5:10",
      "跑完很喘，但休息一下就好",
      "上氣不接下氣",
      "膝蓋外側有點痛，大概 3 分",
      "睡不好，有點頭暈",
      "暑假要去比賽",
      "痛快地跑了 10 公里",
      "",
    ]) {
      expect(detectRedFlags(text), text).toEqual([]);
    }
    expect(detectRedFlags(null)).toEqual([]);
  });

  it("提示的內容：停止運動、就醫、119，列出提到的字詞", () => {
    const advice = redFlagAdvice(["胸痛", "心悸"]);
    expect(advice.title).toContain("停止運動");
    expect(advice.detail).toContain("「胸痛、心悸」");
    expect(advice.detail).toContain("119");
  });
});
