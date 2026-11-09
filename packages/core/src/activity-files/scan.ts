/**
 * 掃一批檔案（.fit、.gpx、.tcx、.zip），找出裡面的活動（規格 12.40「讀 FIT 檔」）.
 *
 * - zip：Garmin Connect 單趟下載的 zip、帳號資料匯出的大 zip（裡面還有 UploadedFiles_*.zip）、個人 API 下載的 zip.
 *   隨機讀取，一個檔一個檔解開，不把整個大檔讀進記憶體.
 * - 不是活動的 FIT（每日的健康資料等）略過；只留支援的運動（IMPORT_SPORTS）；可以只留某一天以後的.
 * - 壞掉的檔記下原因，不中斷其他的.
 */
import { sportOfType } from "../sports";
import { IMPORT_SPORTS, withHrZones, type HrZoneBasis } from "./convert";
import { FitError, isFit, parseFit, type ParseOptions } from "./fit";
import { parseGpx, parseTcx, XmlActivityError } from "./gpx";
import type { ParsedActivity } from "./types";
import { isZip, zipEntries, ZipError, zipOpenNested, zipRead, type RandomAccess } from "./zip";

export interface ScanInput {
  name: string;
  source: RandomAccess;
}

export interface ScanProgress {
  /** 讀過的檔（zip 裡的也算） */
  files: number;
  /** 找到的活動（篩選之後） */
  found: number;
  /** 正在讀的檔名 */
  current: string;
}

export interface ScanProblem {
  name: string;
  reason: string;
}

export interface ScanResult {
  activities: ParsedActivity[];
  /** 讀過的檔 */
  files: number;
  /** 不是活動的 FIT（每日的健康資料等） */
  notActivity: number;
  /** 不支援的運動（走路、健行…），依類型 */
  unsupported: Map<string, number>;
  /** 比「從哪一天起」舊的 */
  older: number;
  problems: ScanProblem[];
  /** 被取消了（activities 是取消前找到的） */
  cancelled: boolean;
}

export interface ScanOptions extends ParseOptions {
  /** 只留這一天（含）以後的（當地日期，例：2026-05-09）；null 是全部 */
  since?: string | null;
  /** 各運動的心率區間（算區間的時間）；沒有時不算 */
  zonesFor?: (type: string) => HrZoneBasis | null;
  onProgress?: (p: ScanProgress) => void;
  signal?: AbortSignal;
}

/** 活動檔的副檔名 */
const ACTIVITY_EXT = /\.(fit|gpx|tcx)$/i;
/** 太大的單一檔案不讀（一般的活動檔不到 10 MB；避免把怪檔讀進記憶體） */
const MAX_FILE_BYTES = 64 * 1024 * 1024;

/** 看副檔名與內容猜是哪一種 */
function kindOf(name: string, head: Uint8Array): "fit" | "gpx" | "tcx" | "zip" | null {
  if (isZip(head)) return "zip";
  if (isFit(head)) return "fit";
  const ext = /\.(\w+)$/.exec(name)?.[1]?.toLowerCase();
  if (ext === "gpx" || ext === "tcx" || ext === "fit" || ext === "zip") return ext;
  return null;
}

const decoder = new TextDecoder();

class Cancelled extends Error {}

export async function scanFiles(inputs: ScanInput[], options: ScanOptions = {}): Promise<ScanResult> {
  const result: ScanResult = { activities: [], files: 0, notActivity: 0, unsupported: new Map(), older: 0, problems: [], cancelled: false };
  const since = options.since ?? null;
  // 每讀一個檔回報一次（畫面那邊自己決定多久更新一次）
  const report = (current: string) => options.onProgress?.({ files: result.files, found: result.activities.length, current });
  const checkCancel = () => {
    if (options.signal?.aborted) throw new Cancelled();
  };

  const keep = (list: ParsedActivity[]) => {
    for (const a of list) {
      const sport = sportOfType(a.type);
      if (!IMPORT_SPORTS.includes(sport)) {
        result.unsupported.set(a.type, (result.unsupported.get(a.type) ?? 0) + 1);
        continue;
      }
      if (since && a.startLocal.slice(0, 10) < since) {
        result.older++;
        continue;
      }
      result.activities.push(withHrZones(a, options.zonesFor?.(a.type) ?? null));
    }
  };

  const parseBytes = (name: string, bytes: Uint8Array, kind: "fit" | "gpx" | "tcx") => {
    const list =
      kind === "fit" ? parseFit(bytes, options) : kind === "gpx" ? parseGpx(decoder.decode(bytes), options) : parseTcx(decoder.decode(bytes), options);
    if (!list.length) {
      if (kind === "fit") result.notActivity++;
      else result.problems.push({ name, reason: "檔案裡沒有活動（沒有時間的軌跡）" });
      return;
    }
    keep(list);
  };

  const reasonOf = (e: unknown) =>
    e instanceof FitError || e instanceof ZipError || e instanceof XmlActivityError ? e.message : `讀不懂這個檔（${e instanceof Error ? e.message : String(e)}）`;

  const scanZip = async (name: string, src: RandomAccess, depth: number): Promise<void> => {
    const entries = await zipEntries(src);
    for (const entry of entries) {
      checkCancel();
      const inner = `${name}／${entry.name.split("/").pop()}`;
      if (entry.name.endsWith("/")) continue;
      if (/\.zip$/i.test(entry.name)) {
        if (depth >= 2) continue;
        try {
          await scanZip(inner, await zipOpenNested(src, entry), depth + 1);
        } catch (e) {
          if (e instanceof Cancelled) throw e;
          result.problems.push({ name: inner, reason: reasonOf(e) });
        }
        continue;
      }
      if (!ACTIVITY_EXT.test(entry.name)) continue;
      result.files++;
      report(inner);
      if (entry.size > MAX_FILE_BYTES) {
        result.problems.push({ name: inner, reason: "檔案太大，不像活動檔" });
        continue;
      }
      try {
        const bytes = await zipRead(src, entry);
        const kind = kindOf(entry.name, bytes);
        if (kind === "zip" || kind === null) continue;
        parseBytes(inner, bytes, kind);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        result.problems.push({ name: inner, reason: reasonOf(e) });
      }
    }
  };

  try {
    for (const input of inputs) {
      checkCancel();
      report(input.name);
      try {
        const head = await input.source.read(0, Math.min(input.source.size, 16));
        const kind = kindOf(input.name, head);
        if (kind === null) {
          result.problems.push({ name: input.name, reason: "不是 FIT、GPX、TCX 或 zip 檔" });
          continue;
        }
        if (kind === "zip") {
          await scanZip(input.name, input.source, 0);
          continue;
        }
        result.files++;
        if (input.source.size > MAX_FILE_BYTES) {
          result.problems.push({ name: input.name, reason: "檔案太大，不像活動檔" });
          continue;
        }
        parseBytes(input.name, await input.source.read(0, input.source.size), kind);
      } catch (e) {
        if (e instanceof Cancelled) throw e;
        result.problems.push({ name: input.name, reason: reasonOf(e) });
      }
    }
  } catch (e) {
    if (!(e instanceof Cancelled)) throw e;
    result.cancelled = true;
  }
  // 同一趟出現兩次（例如同一個檔選了兩次、或 FIT 與 GPX 都有）：只留第一個
  const seen = new Set<string>();
  result.activities = result.activities.filter((a) => {
    const key = `${sportOfType(a.type)}|${a.startUtc.slice(0, 16)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  result.activities.sort((a, b) => b.startUtc.localeCompare(a.startUtc));
  report("");
  return result;
}
