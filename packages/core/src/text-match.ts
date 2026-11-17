/**
 * 文字比對的小工具：執行時間和輸入長度成線性（規格 12.45 第 8 點），
 * 取代容易因為重疊的量詞而變慢的正規表示式寫法
 */

/** 去掉結尾所有的 `/`（取代 `.replace(/\/+$/, "")`） */
export function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 47) end--;
  return s.slice(0, end);
}

const LINE_BREAK = /[\n\r\u2028\u2029]/;

/**
 * 同一行裡 `first` 之後還有符合 `later` 的文字（等同 `/first.*(later)/` 的 test）；
 * `later` 不要帶 g 或 y 旗標
 */
export function appearsAfter(text: string, first: string, later: RegExp): boolean {
  for (const line of text.split(LINE_BREAK)) {
    const i = line.indexOf(first);
    if (i >= 0 && later.test(line.slice(i + first.length))) return true;
  }
  return false;
}
