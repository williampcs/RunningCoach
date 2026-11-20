import { useEffect, useState } from "react";

import { COMPLETION_LABELS, COMPLETIONS, type Completion, type ManualActivity, type Sport } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { checkRedFlags } from "../red-flag-alert";
import { EffortPicker } from "../ui";

/** 回報的是哪一堂課（課表頁的課卡與「回報」分頁共用） */
export interface ReportedSession {
  id: number;
  title: string;
  sport: Sport;
  /** 課表預估的時間與距離，表單的預設；沒有時是 null */
  minutes: number | null;
  km: number | null;
}

/** 數字欄位：空白是 null，打錯的是 NaN（送出時由核心的檢查說哪裡錯） */
const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(",", ".")));

/** 備註的例子：依運動 */
const NOTE_EXAMPLES: Partial<Record<Sport, string>> = {
  strength: "例如：棒式撐不到 30 秒、深蹲改成徒手",
  run: "例如：忘了戴錶，跑得很順",
  ride: "例如：室內騎，腿有點重",
};

/**
 * 回報一堂沒有紀錄的課（規格 12.48）：做到多少、花了多久（預設課表的時間）、體感 1–10、備註. 不逐項勾動作.
 * 存起來是一筆手動記的活動，連到這堂課；已經回報過的可以改或取消
 */
export function SessionReportForm({ session, onDone, onCancel }: { session: ReportedSession; onDone?: () => void; onCancel?: () => void }) {
  const { coach, touch, toast } = useApp();
  const [existing, setExisting] = useState<ManualActivity | null | undefined>(undefined);
  const [completion, setCompletion] = useState<Completion>("done");
  const [minutes, setMinutes] = useState(session.minutes ? String(session.minutes) : "");
  const [km, setKm] = useState("");
  const [effort, setEffort] = useState<number | null>(null);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const hasDistance = session.sport === "run" || session.sport === "ride" || session.sport === "swim";

  // 回報過的：帶入原本的內容
  useEffect(() => {
    let alive = true;
    void coach.sessionReport(session.id).then((found) => {
      if (!alive) return;
      setExisting(found);
      if (!found) return;
      setCompletion(found.completion);
      setMinutes(String(found.duration_min));
      setKm(found.distance_km == null ? "" : String(found.distance_km));
      setEffort(found.perceived_effort);
      setNotes(found.subjective_notes ?? "");
    });
    return () => {
      alive = false;
    };
  }, [coach, session.id]);

  async function save() {
    if (effort === null) {
      setError("點一下體感（1–10）");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await coach.reportSession(session.id, {
        completion,
        duration_min: numberOf(minutes) ?? 0,
        distance_km: hasDistance ? numberOf(km) : null,
        perceived_effort: effort,
        subjective_notes: notes.trim() || null,
      });
      // 備註裡有紅旗的字詞時出現就醫提示（規格 12.33）
      checkRedFlags(notes);
      toast(existing ? "已更新回報。" : "已記下。");
      touch();
      onDone?.();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setBusy(true);
    try {
      await coach.unreportSession(session.id);
      toast("已取消回報。");
      touch();
      onDone?.();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  if (existing === undefined) return <p className="muted small">讀取中…</p>;

  return (
    <form
      className="session-report"
      aria-label={`回報「${session.title}」`}
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="section">
        <h3>做到多少</h3>
        <div className="segmented" role="group" aria-label="做到多少">
          {COMPLETIONS.map((c) => (
            <button key={c} type="button" aria-pressed={completion === c} onClick={() => setCompletion(c)}>
              {COMPLETION_LABELS[c]}
            </button>
          ))}
        </div>
      </div>
      <div className="grid">
        <label>
          花了多久（分）
          <input inputMode="numeric" placeholder="30" value={minutes} required onChange={(e) => setMinutes(e.target.value)} />
        </label>
        {hasDistance && (
          <label>
            距離（km，選填）
            <input inputMode="decimal" placeholder={session.km ? String(session.km) : "有量才填"} value={km} onChange={(e) => setKm(e.target.value)} />
          </label>
        )}
      </div>
      <div className="section">
        <h3>體感</h3>
        <EffortPicker value={effort} onChange={setEffort} />
      </div>
      <label>
        備註
        <AutoGrowTextarea value={notes} placeholder={NOTE_EXAMPLES[session.sport] ?? "例如：時間不夠，少做一組"} onChange={(e) => setNotes(e.target.value)} />
      </label>
      {error && <p className="field-error">{error}</p>}
      <div className="actions">
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "存檔中…" : existing ? "更新回報" : "存起來"}
        </button>
        {onCancel && (
          <button type="button" className="text" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        {existing &&
          (confirmRemove ? (
            <button type="button" className="text danger" disabled={busy} onClick={() => void remove()}>
              確定取消回報
            </button>
          ) : (
            <button type="button" className="text danger" disabled={busy} onClick={() => setConfirmRemove(true)}>
              取消回報
            </button>
          ))}
      </div>
    </form>
  );
}
