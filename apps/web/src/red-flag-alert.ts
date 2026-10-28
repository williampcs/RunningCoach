/**
 * 就醫提示（規格 12.33 第 4 點）：選手的訊息、自評的備註、運動回報的感受裡有紅旗的字詞（核心的 detectRedFlags）時，
 * 畫面上方與看板各出現一則，按「我知道了」才收起. 存在 localStorage：重新整理後還在，收起之前不會消失.
 * 只在這台裝置，不同步、不給模型（教練的回覆照教練方法的規則）.
 */
import { useEffect, useState } from "react";

import { detectRedFlags } from "@running-coach/core";

const KEY = "running-coach.red-flag-alert";
const EVENT = "running-coach:red-flag";

export interface RedFlagAlert {
  /** 提到的字詞（畫面上的說法） */
  labels: string[];
  /** 第一次出現的時間（ISO）；看板的項目用它當 id */
  at: string;
}

function read(): RedFlagAlert | null {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "null") as RedFlagAlert | null;
    return value && Array.isArray(value.labels) && value.labels.length ? value : null;
  } catch {
    return null;
  }
}

function write(alert: RedFlagAlert | null): void {
  try {
    if (alert) localStorage.setItem(KEY, JSON.stringify(alert));
    else localStorage.removeItem(KEY);
  } catch {
    // 無法存取時只在這次顯示
  }
  window.dispatchEvent(new CustomEvent(EVENT, { detail: alert }));
}

/** 檢查使用者寫的文字；有紅旗的字詞時顯示（或加進還沒收起的）就醫提示. 回傳找到的字詞 */
export function checkRedFlags(text: string | null | undefined): string[] {
  const labels = detectRedFlags(text);
  if (!labels.length) return labels;
  const current = read();
  write({ labels: [...new Set([...(current?.labels ?? []), ...labels])], at: current?.at ?? new Date().toISOString() });
  return labels;
}

export function dismissRedFlags(): void {
  write(null);
}

/** 目前的就醫提示；其他地方新增或收起時跟著更新 */
export function useRedFlagAlert(): RedFlagAlert | null {
  const [alert, setAlert] = useState(read);
  useEffect(() => {
    const onChange = (e: Event) => setAlert((e as CustomEvent<RedFlagAlert | null>).detail);
    const onStorage = (e: StorageEvent) => e.key === KEY && setAlert(read());
    window.addEventListener(EVENT, onChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EVENT, onChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);
  return alert;
}
