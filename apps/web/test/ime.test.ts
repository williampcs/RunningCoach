import { describe, expect, it } from "vitest";

import { COMPOSITION_END_GRACE_MS, isImeKey } from "../src/ime";

describe("isImeKey（輸入法選字的 Enter 不送出）", () => {
  it("選字中（isComposing）", () => {
    expect(isImeKey({ isComposing: true, keyCode: 13, timeStamp: 1000 }, -Infinity)).toBe(true);
  });

  it("Safari 確定選字的 Enter：isComposing 是 false、keyCode 229", () => {
    expect(isImeKey({ isComposing: false, keyCode: 229, timeStamp: 1000 }, -Infinity)).toBe(true);
  });

  it("Safari 確定選字的 Enter：compositionend 剛結束、keyCode 13", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13, timeStamp: 1005 }, 1000)).toBe(true);
  });

  it("選字結束一段時間後再按 Enter 就是送出", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13, timeStamp: 1000 + COMPOSITION_END_GRACE_MS + 1 }, 1000)).toBe(false);
  });

  it("沒有用輸入法", () => {
    expect(isImeKey({ isComposing: false, keyCode: 13, timeStamp: 1000 }, -Infinity)).toBe(false);
  });
});
