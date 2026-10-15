import { useCallback, useState } from "react";

import { errorText, useApp } from "./app-context";

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

/** 從 Intervals.icu 同步最近 14 天的訓練（新手引導、設定頁、跑後回報共用） */
export function useSync() {
  const { coach, touch } = useApp();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await coach.sync();
      setMessage({ kind: text.startsWith("❌") ? "error" : "ok", text });
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }, [coach, touch]);

  return { busy, message, run };
}
