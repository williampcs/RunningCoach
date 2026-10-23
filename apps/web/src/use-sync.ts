import { useCallback, useState } from "react";

import type { ImportProgress } from "@running-coach/core";

import { errorText, useApp } from "./app-context";

export interface Notice {
  kind: "ok" | "error";
  text: string;
}

/** 從 Intervals.icu 同步最近 14 天的訓練（新手引導、設定頁、跑後回報共用）；第一次也可以選匯入全部的紀錄 */
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

  /**
   * 第一次抓紀錄時選「全部」：先同步最近 14 天（有分析、有恢復資料），再匯入更早的（不產生分析）.
   * 順序不能反過來：先匯入的話，最近兩週的跑步已經存在，同步時就不會產生分析
   */
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const runAll = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await syncDevices();
      const text = await coach.sync();
      if (text.startsWith("❌")) {
        setMessage({ kind: "error", text });
        return;
      }
      if (coach.canImportHistory) {
        setProgress({ oldest: coach.today(), newest: coach.today(), found: 0 });
        const result = await coach.importHistory(setProgress);
        await syncDevices();
        // 最近 14 天的剛同步過，匯入時算「原本就有」；新增的就是更早的
        const unavailable = result.unavailable > 0 ? `另有 ${result.unavailable} 筆是從 Strava 匯入 Intervals.icu 的，拿不到內容。` : "";
        setMessage({
          kind: "ok",
          text: `${text.replace(/[。.]?\s*$/, "。")}更早的紀錄：匯入 ${result.added} 趟${result.earliest ? `，最早的一趟是 ${result.earliest}` : ""}（不產生分析）。${unavailable}`,
        });
      } else {
        setMessage({ kind: "ok", text });
      }
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }, [coach, touch, syncDevices]);

  return { busy, message, run, runAll, progress };
}
