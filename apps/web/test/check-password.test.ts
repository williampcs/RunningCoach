import { beforeEach, describe, expect, it } from "vitest";

import { checkPassword, defaultSettings, enableLock, needsUnlock } from "../src/settings";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

describe("顯示復原碼、新增裝置前再確認密碼（規格 12.26）", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  it("密碼對才通過，錯的不通過；解鎖的狀態不變", async () => {
    await enableLock("correct horse", defaultSettings());
    expect(await checkPassword("correct horse")).toBe(true);
    expect(await checkPassword("wrong horse")).toBe(false);
    expect(needsUnlock()).toBe(false);
  }, 20_000);

  it("沒有密碼鎖時不能用密碼確認", async () => {
    await expect(checkPassword("anything")).rejects.toThrow("沒有啟用密碼鎖");
  });
});
