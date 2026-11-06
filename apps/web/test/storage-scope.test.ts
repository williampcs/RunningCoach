import { describe, expect, it } from "vitest";

import { createLock, openLock } from "../src/key-lock";
import { clearTestScope, forgetTestScope, importNormalSettings, prepareTestScope, SCOPED_KEYS, testKey, TEST_COPIED_KEY, type Store } from "../src/storage-scope";

function store(initial: Record<string, string> = {}): Store & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

const NORMAL = {
  [SCOPED_KEYS.settings]: JSON.stringify({ provider: "anthropic", apiKey: "sk-normal" }),
  [SCOPED_KEYS.wizard]: JSON.stringify({ done: true }),
  [SCOPED_KEYS.gettingStarted]: "1",
  [SCOPED_KEYS.regionHint]: "1",
  [SCOPED_KEYS.feed]: JSON.stringify({ day: "2026-11-05" }),
  [SCOPED_KEYS.redFlag]: JSON.stringify({ words: ["胸痛"] }),
};

describe("測試模式自己一份設定與標記（9.4 的工作單）", () => {
  it("測試模式的 key 和正常模式的不同", () => {
    for (const key of Object.values(SCOPED_KEYS)) {
      expect(testKey(key)).not.toBe(key);
      expect(testKey(key).startsWith("running-coach.test.")).toBe(true);
    }
    expect(testKey(SCOPED_KEYS.settings)).toBe("running-coach.test.settings.v1");
  });

  it("第一次進測試模式：複製設定與做過了的標記，看板與就醫提示不複製；之後不再複製", () => {
    const s = store(NORMAL);
    expect(prepareTestScope(s)).toBe(true);
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).toBe(NORMAL[SCOPED_KEYS.settings]);
    expect(s.getItem(testKey(SCOPED_KEYS.wizard))).toBe(NORMAL[SCOPED_KEYS.wizard]);
    expect(s.getItem(testKey(SCOPED_KEYS.gettingStarted))).toBe("1");
    expect(s.getItem(testKey(SCOPED_KEYS.regionHint))).toBe("1");
    expect(s.getItem(testKey(SCOPED_KEYS.feed))).toBeNull();
    expect(s.getItem(testKey(SCOPED_KEYS.redFlag))).toBeNull();

    // 測試模式改了設定：正常模式不受影響；再進一次也不會被正常模式蓋回去
    s.setItem(testKey(SCOPED_KEYS.settings), JSON.stringify({ provider: "openai", apiKey: "sk-test" }));
    expect(prepareTestScope(s)).toBe(false);
    expect(s.getItem(SCOPED_KEYS.settings)).toBe(NORMAL[SCOPED_KEYS.settings]);
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).toContain("sk-test");
  });

  it("整個重置只清測試模式那一份；正常模式的設定與標記都在，重置後也不會又複製回來", () => {
    const s = store(NORMAL);
    prepareTestScope(s);
    s.setItem(testKey(SCOPED_KEYS.feed), "x");
    s.setItem(testKey(SCOPED_KEYS.redFlag), "x");
    clearTestScope(s);
    for (const key of Object.values(SCOPED_KEYS)) expect(s.getItem(testKey(key))).toBeNull();
    for (const [key, value] of Object.entries(NORMAL)) expect(s.getItem(key)).toBe(value);
    expect(prepareTestScope(s)).toBe(false);
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).toBeNull();
  });

  it("帶入正常設定：只換設定（含密碼鎖），標記不動", () => {
    const s = store(NORMAL);
    prepareTestScope(s);
    clearTestScope(s);
    s.setItem(SCOPED_KEYS.settings, JSON.stringify({ provider: "gemini", apiKey: "sk-new" }));
    importNormalSettings(s);
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).toContain("sk-new");
    expect(s.getItem(testKey(SCOPED_KEYS.wizard))).toBeNull();
    expect(s.getItem(testKey(SCOPED_KEYS.gettingStarted))).toBeNull();
    expect(s.getItem(TEST_COPIED_KEY)).toBe("1");
  });

  it("密碼鎖開著：複製的是密文，測試模式那一份用同一個密碼才解得開；正常模式沒有鎖時測試的鎖也拿掉", async () => {
    const { sealed } = await createLock("pw-1234", { apiKey: "sk-locked", proxyToken: "", intervalsApiKey: "iv-key" }, 1000);
    const s = store({ [SCOPED_KEYS.settings]: JSON.stringify({ apiKey: "" }), [SCOPED_KEYS.lock]: JSON.stringify(sealed) });
    prepareTestScope(s);
    const copied = s.getItem(testKey(SCOPED_KEYS.lock))!;
    expect(copied).not.toContain("sk-locked");
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).not.toContain("sk-locked");
    const { secrets } = await openLock(JSON.parse(copied), "pw-1234");
    expect(secrets.apiKey).toBe("sk-locked");

    s.removeItem(SCOPED_KEYS.lock);
    importNormalSettings(s);
    expect(s.getItem(testKey(SCOPED_KEYS.lock))).toBeNull();
  });

  it("正常模式的全部重置：測試模式那一份（有複製過去的 key）也刪掉，下次進測試模式再複製", () => {
    const s = store(NORMAL);
    prepareTestScope(s);
    forgetTestScope(s);
    expect(s.getItem(testKey(SCOPED_KEYS.settings))).toBeNull();
    expect(s.getItem(TEST_COPIED_KEY)).toBeNull();
    expect(prepareTestScope(s)).toBe(true);
  });
});
