import { useEffect, useState } from "react";

import type { FetchStatus } from "@running-coach/core";

import { useApp } from "../app-context";

/** 11/24 14:05 */
function clockText(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-TW", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 剛剛、5 分鐘前、3 小時前、2 天前 */
function agoText(iso: string, now: number): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
  if (!(minutes >= 1)) return "剛剛";
  if (minutes < 60) return `${minutes} 分鐘前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 設定的訓練紀錄（規格 12.34 的 A1）：這台上次從 Intervals.icu 抓紀錄的時間，與比那之後還晚的錯誤.
 * 紀錄每台自己抓：很久沒抓的那台會少紀錄（打開 App 時超過 1 小時沒抓會自動抓）
 */
export function FetchStatusLine() {
  const { coach, revision } = useApp();
  const [status, setStatus] = useState<FetchStatus | null | undefined>(undefined);

  useEffect(() => {
    let alive = true;
    void coach.fetchStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [coach, revision]);

  if (status === undefined) return null;
  const now = Date.now();
  const failed = status?.errorAt && status.error && (!status.at || status.errorAt > status.at);
  return (
    <div className="fetch-status stack small">
      <p className="muted">
        {status?.at ? `這台上次抓紀錄：${clockText(status.at)}（${agoText(status.at, now)}）。` : "這台還沒抓過紀錄。"}
        打開 App 時超過 1 小時沒抓，會自動抓最近 14 天（只存紀錄，分析在跑後回報或按「同步」時）。
      </p>
      {failed && (
        <p className="field-error" role="status">
          最近一次抓紀錄失敗（{clockText(status.errorAt!)}）：{status.error}
        </p>
      )}
    </div>
  );
}
