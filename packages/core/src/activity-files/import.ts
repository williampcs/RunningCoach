/**
 * 把掃到的活動存進資料庫，並寫出結果的說明（規格 12.40「讀 FIT 檔」）.
 */
import type { Db } from "../db";
import { importRecordOf } from "./convert";
import type { ScanResult } from "./scan";
import type { ParsedActivity } from "./types";

export interface ImportCounts {
  /** 新增的 */
  added: number;
  /** 之前匯入過的（同一個檔） */
  existing: number;
  /** 和已經有的同一趟（例如 Intervals.icu 的）合併了 */
  merged: number;
  /** 新增了，但同一天有一筆很像的手動紀錄，看板會問是不是同一趟 */
  maybe: number;
  /** 存的時候出錯的 */
  failed: number;
}

/** 一筆一筆存（每筆一個交易，大量匯入時中途出錯也不會整批白做）；onProgress 回報存了幾筆 */
export async function importActivities(
  db: Db,
  activities: ParsedActivity[],
  options: { onProgress?: (done: number) => void; signal?: AbortSignal } = {},
): Promise<ImportCounts> {
  const counts: ImportCounts = { added: 0, existing: 0, merged: 0, maybe: 0, failed: 0 };
  // 舊的先存：同一趟的判斷與「保留先進來的」和平常同步的順序一致
  const ordered = [...activities].sort((a, b) => a.startUtc.localeCompare(b.startUtc));
  for (let i = 0; i < ordered.length; i++) {
    if (options.signal?.aborted) break;
    try {
      const { status } = await db.importFileActivity(await importRecordOf(ordered[i]!));
      if (status === "new") counts.added++;
      else if (status === "existing") counts.existing++;
      else if (status === "merged") counts.merged++;
      else {
        counts.added++;
        counts.maybe++;
      }
    } catch {
      counts.failed++;
    }
    options.onProgress?.(i + 1);
  }
  return counts;
}

/** 掃描的說明：找到幾趟、略過了什麼 */
export function scanSummaryText(scan: Pick<ScanResult, "activities" | "files" | "notActivity" | "unsupported" | "older" | "problems">): string[] {
  const lines: string[] = [];
  const unsupported = [...scan.unsupported.values()].reduce((s, n) => s + n, 0);
  const skipped = [
    scan.older ? `${scan.older} 趟比選的期間舊` : null,
    unsupported ? `${unsupported} 趟不支援的運動（例如走路、健行）` : null,
    scan.notActivity ? `${scan.notActivity} 個不是活動的檔（例如每日的健康資料）` : null,
    scan.problems.length ? `${scan.problems.length} 個讀不了的檔` : null,
  ].filter(Boolean);
  if (skipped.length) lines.push(`略過：${skipped.join("、")}。`);
  return lines;
}

/** 匯入完成的說明 */
export function importSummaryText(counts: ImportCounts): string {
  const parts = [
    `新增 ${counts.added} 趟`,
    counts.existing || counts.merged
      ? `已經有了 ${counts.existing + counts.merged} 趟${counts.merged ? `（其中 ${counts.merged} 趟和 Intervals.icu 或之前的紀錄是同一趟，已合併）` : ""}`
      : null,
    counts.failed ? `${counts.failed} 趟存不進去` : null,
  ].filter(Boolean);
  const maybe = counts.maybe ? `有 ${counts.maybe} 趟和同一天手動記的很像，最近 7 天內的會在看板上問你是不是同一趟。` : "";
  return `${parts.join("，")}。${maybe}`;
}
