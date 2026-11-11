/**
 * 輸入法選字時按的 Enter 不算送出.
 *
 * 一般的瀏覽器在選字時 keydown 的 isComposing 是 true；Safari 不是：按 Enter 確定選字時，
 * 它先發 compositionend、再發 isComposing 為 false 的 keydown（keyCode 229），照一般的判斷就會把字送出。
 * 所以另外看 keyCode 229，以及「選字剛結束」的那一下（compositionend 之後很短的時間內的 Enter）。
 */

/** 選字結束後多久內的 Enter 當成確定選字（毫秒）：Safari 的 keydown 緊接在 compositionend 後面 */
export const COMPOSITION_END_GRACE_MS = 100;

let lastCompositionEnd = -Infinity;

if (typeof document !== "undefined") {
  document.addEventListener("compositionend", (e) => (lastCompositionEnd = e.timeStamp), true);
}

interface KeyLike {
  isComposing?: boolean;
  keyCode?: number;
  timeStamp: number;
}

/** 這次按鍵是不是輸入法的選字（含 Safari 確定選字的 Enter）；React 的事件傳 nativeEvent */
export function isImeKey(e: KeyLike, compositionEndAt: number = lastCompositionEnd): boolean {
  if (e.isComposing || e.keyCode === 229) return true;
  const since = e.timeStamp - compositionEndAt;
  return since >= 0 && since < COMPOSITION_END_GRACE_MS;
}
