/**
 * 同一個網站同時只有一個分頁用資料庫（KI-046）：OPFS 的資料庫同時只能一個分頁打開.
 * 用 Web Locks 記誰在用；另一個分頁要用時以 BroadcastChannel 請它交出來，交出來的分頁關掉資料庫再放開鎖，
 * 所以不會兩邊同時寫. 瀏覽器沒有這兩個 API 時照舊直接打開（打不開就退回記憶體資料庫）.
 */

const LOCK_NAME = "zone2mate-db";
const CHANNEL_NAME = "zone2mate-tabs";
/** 「在這裡繼續」重新載入後直接接手，不再顯示「已經在另一個分頁開著」 */
const TAKEOVER_KEY = "zone2mate-takeover";
/** 重新載入時，上一頁的鎖可能還沒放開：等一下再判斷有沒有別的分頁在用 */
const STARTUP_RETRY_MS = 600;

/** from：送出的分頁，自己送的不理（接手的分頁拿到鎖時，自己送的請求可能還沒送到） */
type Message = { type: "release"; from: string };

const TAB_ID = Math.random().toString(36).slice(2);

export function tabLockSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.locks && typeof BroadcastChannel !== "undefined";
}

/** 這個分頁拿著鎖：release() 放開（先關好資料庫再呼叫） */
export interface HeldLock {
  release(): void;
}

/** 鎖的 callback：回傳的 Promise 結束前一直拿著鎖；別的分頁請這裡交出來時呼叫 onRequested */
function hold(onRequested: () => void, granted: (held: HeldLock) => void): Promise<void> {
  return new Promise<void>((done) => {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = (event: MessageEvent<Message>) => {
      if (event.data?.type === "release" && event.data.from !== TAB_ID) onRequested();
    };
    granted({
      release() {
        channel.close();
        done();
      },
    });
  });
}

/**
 * 打開時：沒有別的分頁在用就拿到鎖；有的話回 null（顯示「已經在另一個分頁開著」）.
 * 上一次按了「在這裡繼續」時直接接手.
 */
export async function acquireAtStart(onRequested: () => void): Promise<HeldLock | null> {
  let takeover = false;
  try {
    takeover = sessionStorage.getItem(TAKEOVER_KEY) === "1";
    sessionStorage.removeItem(TAKEOVER_KEY);
  } catch {
    // 讀不到 sessionStorage：當成一般的打開
  }
  if (takeover) return takeOver(onRequested);
  const deadline = Date.now() + STARTUP_RETRY_MS;
  for (;;) {
    const held = await new Promise<HeldLock | null>((resolve) => {
      void navigator.locks.request(LOCK_NAME, { ifAvailable: true }, (lock) => (lock ? hold(onRequested, resolve) : resolve(null)));
    });
    if (held || Date.now() >= deadline) return held;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** 「在這裡使用」：請正在用的分頁交出來，等它關好資料庫、放開鎖後拿到 */
export function takeOver(onRequested: () => void): Promise<HeldLock> {
  return new Promise((resolve) => {
    // 先排進鎖的佇列再請對方交出來：對方一放開就輪到這裡
    void navigator.locks.request(LOCK_NAME, () => hold(onRequested, resolve));
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage({ type: "release", from: TAB_ID } satisfies Message);
    channel.close();
  });
}

/** 被別的分頁接手後，按「在這裡繼續」：重新載入，載入後直接接手（重新載入才不會留著舊的狀態） */
export function continueHere(): void {
  try {
    sessionStorage.setItem(TAKEOVER_KEY, "1");
  } catch {
    // 存不了時重新載入後會先看到「已經在另一個分頁開著」，再按一次「在這裡使用」
  }
  location.reload();
}
