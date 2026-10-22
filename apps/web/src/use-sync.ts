import { useCallback, useState } from "react";

import { errorText, useApp } from "./app-context";

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

/** 從 Intervals.icu 同步最近 14 天的訓練（新手引導、設定頁、跑後回報共用） */
export function useSync() {
  const { coach, touch, deviceSync } = useApp();
  const syncDevices = deviceSync.run;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Notice | null>(null);

  const run = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      // 先取回別台的資料：別台分析過的跑步就不必再花費用分析一次
      await syncDevices();
      const text = await coach.sync();
      // 剛同步進來的跑步若有別台寫的體感，這時才對得上
      await syncDevices();
      setMessage({ kind: text.startsWith("❌") ? "error" : "ok", text });
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }, [coach, touch, syncDevices]);

  return { busy, message, run };
}
