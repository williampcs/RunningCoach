/**
 * 換金鑰進行中的新同步金鑰（規格 12.10）：和同步金鑰存在同一個地方——沒有密碼鎖時在設定裡，密碼鎖開著時一起加密；
 * 存設定（畫面的草稿）時不會蓋掉；鎖著時讀不到，解鎖後讀得到.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

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
  get length() {
    return this.items.size;
  }
  key(i: number) {
    return [...this.items.keys()][i] ?? null;
  }
  dump() {
    return [...this.items.values()].join("\n");
  }
}

let storage: MemoryStorage;
/** 重新載入頁面：模組裡解鎖的狀態清掉，localStorage 留著 */
const reload = async () => {
  vi.resetModules();
  return import("../src/settings");
};

const KEY = "rekey-key-value-for-test-0123456789abcdefghij";
const SYNC = "sync-key-value-for-test-0123456789abcdefghijk";

beforeEach(() => {
  storage = new MemoryStorage();
  (globalThis as { localStorage?: unknown }).localStorage = storage;
});

describe("換金鑰進行中的新金鑰", () => {
  it("沒有密碼鎖：和同步金鑰存在一起；存設定（舊的草稿）時保留；不出現在設定的物件裡", async () => {
    const s = await reload();
    const settings = { ...s.defaultSettings(), sync: { url: "http://sync.test", key: SYNC } };
    await s.saveSettings(settings);
    await s.saveRekeyKey(KEY);
    expect(s.loadRekeyKey()).toBe(KEY);
    await s.saveSettings({ ...settings, timeZone: "Asia/Tokyo" });
    expect(s.loadRekeyKey()).toBe(KEY);
    expect(s.loadSettings()).not.toHaveProperty("rekeyKey");
    const again = await reload();
    expect(again.loadRekeyKey()).toBe(KEY);
    await again.saveRekeyKey("");
    expect(again.loadRekeyKey()).toBe("");
    expect(storage.dump()).not.toContain(KEY);
  });

  it("密碼鎖開著：加密，明文的設定裡沒有；鎖著時讀不到、存不了；解鎖後讀得到；關掉密碼鎖時搬回設定", async () => {
    const s = await reload();
    const settings = { ...s.defaultSettings(), sync: { url: "http://sync.test", key: SYNC } };
    await s.saveSettings(settings);
    await s.saveRekeyKey(KEY);
    await s.enableLock("pw-for-test", settings);
    expect(storage.dump()).not.toContain(KEY);
    expect(storage.dump()).not.toContain(SYNC);
    expect(s.loadRekeyKey()).toBe(KEY);

    const locked = await reload();
    expect(locked.needsUnlock()).toBe(true);
    expect(locked.loadRekeyKey()).toBe("");
    await expect(locked.saveRekeyKey("other")).rejects.toThrow();
    await locked.unlock("pw-for-test");
    expect(locked.loadRekeyKey()).toBe(KEY);
    // 存設定（草稿）不蓋掉
    await locked.saveSettings({ ...locked.loadSettings(), timeZone: "Asia/Tokyo" });
    expect(locked.loadRekeyKey()).toBe(KEY);
    expect(storage.dump()).not.toContain(KEY);

    locked.disableLock(locked.loadSettings());
    expect(locked.loadRekeyKey()).toBe(KEY);
    expect((await reload()).loadRekeyKey()).toBe(KEY);
  });

  it("密碼鎖開著時刪掉", async () => {
    const s = await reload();
    const settings = s.defaultSettings();
    await s.saveSettings(settings);
    await s.enableLock("pw-for-test", settings);
    await s.saveRekeyKey(KEY);
    const again = await reload();
    await again.unlock("pw-for-test");
    expect(again.loadRekeyKey()).toBe(KEY);
    await again.saveRekeyKey("");
    const third = await reload();
    await third.unlock("pw-for-test");
    expect(third.loadRekeyKey()).toBe("");
  });

  it("同步引擎用的存放介面（device-sync.ts）", async () => {
    await reload();
    const { rekeyKeyStore } = await import("../src/device-sync");
    const settings = await import("../src/settings");
    await settings.saveSettings(settings.defaultSettings());
    expect(await rekeyKeyStore.load()).toBeNull();
    const root = new Uint8Array(32).fill(7);
    await rekeyKeyStore.save(root);
    expect(await rekeyKeyStore.load()).toEqual(root);
    await rekeyKeyStore.clear();
    expect(await rekeyKeyStore.load()).toBeNull();
  });
});
