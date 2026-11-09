import { useEffect, useRef, useState, type DragEvent } from "react";

import {
  addDays,
  blobSource,
  heartRateInfo,
  importActivities,
  importSummaryText,
  scanFiles,
  scanSummaryText,
  shortDateLabel,
  zoneBasisFor,
  type ImportCounts,
  type RunSettings,
  type ScanResult,
  type SportSettings,
} from "@running-coach/core";
import { FileUp } from "lucide-react";

import { errorText, useApp } from "../app-context";
import { Disclosure, Icon, InfoTip } from "../ui";

/** 匯入的期間（月）；0 是全部 */
const PERIODS = [
  { months: 3, label: "最近 3 個月" },
  { months: 6, label: "最近 6 個月" },
  { months: 12, label: "最近 12 個月" },
  { months: 0, label: "全部" },
] as const;

type Step =
  | { kind: "pick" }
  | { kind: "scanning"; files: number; found: number }
  | { kind: "review"; scan: ScanResult }
  | { kind: "saving"; done: number; total: number }
  | { kind: "done"; counts: ImportCounts; scan: ScanResult };

const ACCEPT = ".fit,.zip,.gpx,.tcx,application/zip";
const number = (n: number) => n.toLocaleString("zh-TW");

/**
 * 匯入檔案（規格 12.40「讀 FIT 檔」）：FIT、GPX、TCX、zip（Garmin Connect 單趟下載的、帳號資料匯出的、個人 API 下載的）.
 * 在瀏覽器裡讀，不上傳；先掃一遍列出找到幾趟，再按「匯入」存進紀錄（照原本的規則去重）
 */
export function ImportFiles({ onClose, onDone }: { onClose: () => void; onDone?: () => void }) {
  const { coach, touch } = useApp();
  const [months, setMonths] = useState<number>(12);
  const [step, setStep] = useState<Step>({ kind: "pick" });
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  async function scan(files: File[]) {
    if (!files.length) return;
    setError(null);
    const controller = new AbortController();
    abort.current = controller;
    setStep({ kind: "scanning", files: 0, found: 0 });
    try {
      // 心率區間：Intervals.icu 的運動設定，沒有時用選手資料的實測最大心率換算的（只有跑步）
      const [sportSettings, runSettings, profile] = await Promise.all([
        coach.db.getSnapshot<SportSettings[] | null>("sport_settings"),
        coach.db.getSnapshot<RunSettings | null>("run_settings"),
        coach.db.getProfile(),
      ]);
      const hr = heartRateInfo(profile, null, coach.today());
      const profileZones = hr?.source === "profile" ? { bounds: hr.zones.map((z) => z.max), lthr: hr.lthr } : null;
      let last = 0;
      const result = await scanFiles(
        files.map((f) => ({ name: f.name, source: blobSource(f) })),
        {
          since: months ? addDays(coach.today(), -Math.round(months * 30.4)) : null,
          zonesFor: (type) => zoneBasisFor(type, sportSettings?.value ?? null, runSettings?.value ?? null, profileZones),
          signal: controller.signal,
          onProgress: (p) => {
            const now = Date.now();
            if (now - last < 150) return;
            last = now;
            setStep({ kind: "scanning", files: p.files, found: p.found });
          },
        },
      );
      if (result.cancelled) {
        setStep({ kind: "pick" });
        return;
      }
      setStep({ kind: "review", scan: result });
    } catch (e) {
      setError(errorText(e));
      setStep({ kind: "pick" });
    } finally {
      abort.current = null;
    }
  }

  async function save(result: ScanResult) {
    const controller = new AbortController();
    abort.current = controller;
    const total = result.activities.length;
    setStep({ kind: "saving", done: 0, total });
    try {
      let last = 0;
      const counts = await importActivities(coach.db, result.activities, {
        signal: controller.signal,
        onProgress: (done) => {
          const now = Date.now();
          if (now - last < 150 && done < total) return;
          last = now;
          setStep({ kind: "saving", done, total });
        },
      });
      touch();
      onDone?.();
      setStep({ kind: "done", counts, scan: result });
    } catch (e) {
      setError(errorText(e));
      setStep({ kind: "review", scan: result });
    } finally {
      abort.current = null;
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (step.kind !== "pick") return;
    void scan([...e.dataTransfer.files]);
  }

  return (
    <div className="manual-add import-files">
      <div className="card-head">
        <h3>匯入檔案</h3>
        <InfoTip label="可以匯入哪些檔案">
          手錶的活動檔：FIT、GPX、TCX，或 Garmin Connect 下載的 zip（單趟的「匯出原始檔」，或帳號資料匯出的大 zip）。檔案在這台的瀏覽器裡讀，不會上傳；開了多裝置同步時，每一趟的摘要會加密同步到其他裝置。
        </InfoTip>
      </div>

      {step.kind === "pick" && (
        <>
          <div
            className={`drop-zone${dragging ? " over" : ""}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
          >
            <Icon as={FileUp} size={28} />
            <span className="small muted">FIT、GPX、TCX 或 zip，可以一次選好幾個，或拖進來</span>
            <button className="primary" onClick={() => input.current?.click()}>
              選擇檔案
            </button>
            <input
              ref={input}
              type="file"
              multiple
              accept={ACCEPT}
              hidden
              aria-label="選擇要匯入的檔案"
              onChange={(e) => {
                const files = [...(e.target.files ?? [])];
                e.target.value = "";
                void scan(files);
              }}
            />
          </div>
          <label>
            匯入的期間
            <select value={months} onChange={(e) => setMonths(Number(e.target.value))}>
              {PERIODS.map((p) => (
                <option key={p.months} value={p.months}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          {error && <div className="notice error">讀不了：{error}</div>}
          <div className="actions">
            <button className="text" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}

      {step.kind === "scanning" && (
        <div className="import-progress" role="status">
          <div className="indeterminate" />
          <span className="small">
            讀了 {number(step.files)} 個檔，找到 {number(step.found)} 趟
          </span>
          <div className="actions">
            <button className="text" onClick={() => abort.current?.abort()}>
              停止
            </button>
          </div>
        </div>
      )}

      {step.kind === "review" && <Review scan={step.scan} error={error} onImport={() => void save(step.scan)} onBack={() => setStep({ kind: "pick" })} />}

      {step.kind === "saving" && (
        <div className="import-progress" role="status">
          <progress max={step.total} value={step.done} aria-label="匯入的進度" />
          <span className="small">
            存了 {number(step.done)}／{number(step.total)} 趟
          </span>
        </div>
      )}

      {step.kind === "done" && (
        <>
          <div className="notice ok" role="status">
            <strong>匯入完成</strong>：{importSummaryText(step.counts)}
          </div>
          <div className="actions">
            <button className="primary" onClick={onClose}>
              看紀錄
            </button>
            <button className="text" onClick={() => setStep({ kind: "pick" })}>
              再匯入
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function Review({ scan, error, onImport, onBack }: { scan: ScanResult; error: string | null; onImport: () => void; onBack: () => void }) {
  const list = scan.activities;
  const newest = list[0]?.startLocal.slice(0, 10);
  const oldest = list[list.length - 1]?.startLocal.slice(0, 10);
  const skipped = scanSummaryText(scan);
  return (
    <>
      {list.length ? (
        <p>
          找到 <strong>{number(list.length)}</strong> 趟
          {oldest && newest && <span className="muted"> · {oldest === newest ? shortDateLabel(newest) : `${shortDateLabel(oldest)} – ${shortDateLabel(newest)}`}</span>}
        </p>
      ) : (
        <p>沒有找到可以匯入的活動。</p>
      )}
      {skipped.map((line) => (
        <p key={line} className="small muted">
          {line}
        </p>
      ))}
      {scan.problems.length > 0 && (
        <Disclosure summary="讀不了的檔">
          <ul className="small">
            {scan.problems.slice(0, 20).map((p) => (
              <li key={p.name}>
                {p.name}：{p.reason}
              </li>
            ))}
            {scan.problems.length > 20 && <li>還有 {scan.problems.length - 20} 個</li>}
          </ul>
        </Disclosure>
      )}
      {error && <div className="notice error">匯入失敗：{error}（再按一次，已存的不會重複）</div>}
      <div className="actions">
        {list.length > 0 && (
          <button className="primary" onClick={onImport}>
            匯入 {number(list.length)} 趟
          </button>
        )}
        <button className="text" onClick={onBack}>
          {list.length ? "取消" : "換別的檔"}
        </button>
      </div>
    </>
  );
}
