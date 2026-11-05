/**
 * 測試模式自己一份設定與「做過了」的標記（規格 9.4 的工作單「測試模式：清空資料與重置成第一次打開」）.
 *
 * - 正常模式用原本的 key；測試模式用 `running-coach.test.` 開頭的另一份，兩邊互不影響
 * - 第一次進測試模式時，從正常模式複製一份設定與標記（密碼鎖的密文照原樣複製，API key 照樣加密），之後各改各的
 * - 測試模式的「重置成第一次打開」只清測試的那一份；正常模式的資料與設定不受影響
 * - 一個頁面只用一種模式：切換測試模式一定重新載入，所以第一次用到時決定好就不再變
 *
 * 只處理哪些 key 是哪一份；設定的內容在 settings.ts，各個標記在各自的檔案.
 */
import { loadTestMode } from "./test-mode";

const PREFIX = "running-coach.";
const TEST_PREFIX = "running-coach.test.";

/** 正常模式與測試模式各一份的 key（這裡寫的是正常模式的名稱） */
export const SCOPED_KEYS = {
  settings: "running-coach.settings.v1",
  /** 密碼鎖開著時，API key 等憑證的密文 */
  lock: "running-coach.lock.v1",
  wizard: "running-coach.wizard.v1",
  gettingStarted: "running-coach.getting-started.dismissed",
  feed: "running-coach.feed.v1",
  regionHint: "running-coach.region-hint.dismissed",
  redFlag: "running-coach.red-flag-alert",
} as const;

type ScopedKey = (typeof SCOPED_KEYS)[keyof typeof SCOPED_KEYS];

/** 設定（含密碼鎖的密文）：「從正常模式帶入設定」複製這些 */
const SETTINGS_KEYS: ScopedKey[] = [SCOPED_KEYS.settings, SCOPED_KEYS.lock];

/**
 * 第一次進測試模式時複製的：設定與「做過了」的標記（精靈、新手引導、地區的提示），進去之後和平常一樣.
 * 看板的收起與就醫提示跟著資料走，不複製
 */
const FIRST_COPY_KEYS: ScopedKey[] = [...SETTINGS_KEYS, SCOPED_KEYS.wizard, SCOPED_KEYS.gettingStarted, SCOPED_KEYS.regionHint];

/** 測試模式已經有自己一份了（複製過）；「重置成第一次打開」不清這個，重置後不會又從正常模式複製回來 */
export const TEST_COPIED_KEY = "running-coach.test.copied";

export type Store = Pick<Storage, "getItem" | "setItem" | "removeItem">;

/** 測試模式那一份的 key */
export const testKey = (key: ScopedKey): string => TEST_PREFIX + key.slice(PREFIX.length);

function copy(store: Store, keys: ScopedKey[]): void {
  for (const key of keys) {
    const value = store.getItem(key);
    if (value === null) store.removeItem(testKey(key));
    else store.setItem(testKey(key), value);
  }
}

/** 進測試模式時：還沒有自己一份就從正常模式複製（之前就開著測試模式的，更新後第一次打開也是） */
export function prepareTestScope(store: Store): boolean {
  if (store.getItem(TEST_COPIED_KEY) !== null) return false;
  copy(store, FIRST_COPY_KEYS);
  store.setItem(TEST_COPIED_KEY, "1");
  return true;
}

/** 「從正常模式帶入設定」：用正常模式的設定（含密碼鎖）取代測試模式的；標記不動 */
export function importNormalSettings(store: Store): void {
  copy(store, SETTINGS_KEYS);
  store.setItem(TEST_COPIED_KEY, "1");
}

/** 「重置成第一次打開」：清掉測試模式的設定與所有標記；正常模式的不碰 */
export function clearTestScope(store: Store): void {
  for (const key of Object.values(SCOPED_KEYS)) store.removeItem(testKey(key));
}

/** 正常模式的「全部重置」、這台被移出同步：測試模式那一份（裡面有複製過去的 API key）也刪掉，下次進測試模式再複製 */
export function forgetTestScope(store: Store): void {
  clearTestScope(store);
  store.removeItem(TEST_COPIED_KEY);
}

let inTestScope: boolean | null = null;

/** 這個頁面用測試模式的那一份嗎（第一次用到時決定，並在需要時從正常模式複製） */
function testScope(): boolean {
  if (inTestScope === null) {
    inTestScope = false;
    try {
      if (loadTestMode().enabled) {
        prepareTestScope(localStorage);
        inTestScope = true;
      }
    } catch {
      // 讀不到 localStorage：當成正常模式
    }
  }
  return inTestScope;
}

/** 這個頁面要用的 key：測試模式時是測試的那一份 */
export const storageKey = (key: ScopedKey): string => (testScope() ? testKey(key) : key);
