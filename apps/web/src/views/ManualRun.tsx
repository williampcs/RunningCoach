import { useState } from "react";

import type { ManualWorkoutInput, Workout } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { checkRedFlags } from "../red-flag-alert";
import { Disclosure, EffortPicker } from "../ui";

/** 表單裡的值（都是字串，送出時才換成數字） */
interface Draft {
  date: string;
  km: string;
  minutes: string;
  seconds: string;
  effort: number | null;
  hr: string;
  notes: string;
}

function draftOf(w: Workout | null, today: string): Draft {
  if (!w) return { date: today, km: "", minutes: "", seconds: "", effort: null, hr: "", notes: "" };
  const total = Math.round((w.duration_min ?? 0) * 60);
  return {
    date: w.date,
    km: w.distance_km == null ? "" : String(w.distance_km),
    minutes: String(Math.floor(total / 60)),
    seconds: total % 60 ? String(total % 60) : "",
    effort: w.perceived_effort,
    hr: w.avg_hr == null ? "" : String(w.avg_hr),
    notes: w.subjective_notes ?? "",
  };
}

/** 數字欄位：空白是 null，打錯的是 NaN（送出時由核心的檢查說哪裡錯） */
const numberOf = (text: string) => (text.trim() === "" ? null : Number(text.trim().replace(",", ".")));

/**
 * 手動記一趟跑步（規格 12.36「沒有手錶也能用」）：日期、距離、時間、體感必填，平均心率與感受選填.
 * 存了就產生分析（和跑後回報一樣）；editing 是要改的那一筆（手動新增的），可以刪除
 */
export function ManualRunForm({
  editing = null,
  onSaved,
  onCancel,
}: {
  editing?: Workout | null;
  onSaved: (result: { workout: Workout; summary: string | null }) => void;
  onCancel?: () => void;
}) {
  const { coach, touch, toast } = useApp();
  const today = coach.today();
  const [draft, setDraft] = useState<Draft>(() => draftOf(editing, today));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));

  async function save() {
    if (draft.effort === null) {
      setError("點一下體感（1–10）");
      return;
    }
    const km = numberOf(draft.km);
    const minutes = numberOf(draft.minutes) ?? 0;
    const seconds = numberOf(draft.seconds) ?? 0;
    const hr = numberOf(draft.hr);
    const input: ManualWorkoutInput = {
      date: draft.date,
      distance_km: km ?? 0,
      duration_min: minutes + seconds / 60,
      perceived_effort: draft.effort,
      avg_hr: hr,
      subjective_notes: draft.notes,
    };
    setBusy(true);
    setError(null);
    try {
      const result = editing ? await coach.updateManualWorkout(editing.id, input) : await coach.addManualWorkout(input);
      // 感受裡有紅旗的字詞時出現就醫提示（規格 12.33）
      checkRedFlags(draft.notes);
      toast(result.summary === null ? "已存檔；這次沒有產生分析。" : "已存檔。");
      if (!editing) setDraft(draftOf(null, today));
      touch();
      onSaved(result);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!editing) return;
    setBusy(true);
    try {
      await coach.deleteManualWorkout(editing.id);
      toast("已刪除這一筆。");
      touch();
      onCancel?.();
    } catch (e) {
      setError(errorText(e));
      setBusy(false);
    }
  }

  return (
    <form
      className="manual-run"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <div className="grid">
        <label>
          日期
          <input type="date" value={draft.date} max={today} required onChange={(e) => set({ date: e.target.value })} />
        </label>
        <label>
          距離（km）
          <input inputMode="decimal" placeholder="5" value={draft.km} required onChange={(e) => set({ km: e.target.value })} />
        </label>
      </div>
      <fieldset className="manual-time">
        <legend>時間</legend>
        <label>
          <input inputMode="numeric" placeholder="35" aria-label="分鐘" value={draft.minutes} required onChange={(e) => set({ minutes: e.target.value })} />
          分
        </label>
        <label>
          <input inputMode="numeric" placeholder="0" aria-label="秒" value={draft.seconds} onChange={(e) => set({ seconds: e.target.value })} />
          秒
        </label>
      </fieldset>
      <div className="section">
        <h3>體感</h3>
        <EffortPicker value={draft.effort} onChange={(effort) => set({ effort })} />
        <p className="small muted">輕鬆＝能說完整的句子（2–4）</p>
      </div>
      <label>
        一句話的感受
        <AutoGrowTextarea value={draft.notes} placeholder="例如：最後一公里有點喘，腿還好" onChange={(e) => set({ notes: e.target.value })} />
      </label>
      <Disclosure summary="平均心率（選填）" className="manual-more">
        <label>
          平均心率
          <input inputMode="numeric" placeholder="有量才填" value={draft.hr} onChange={(e) => set({ hr: e.target.value })} />
        </label>
      </Disclosure>
      {error && <div className="notice error">{error}</div>}
      <div className={editing ? "actions" : "actions full"}>
        <button type="submit" className="primary" disabled={busy}>
          {busy ? "存檔並分析中…" : editing ? "儲存並重新分析" : "存起來"}
        </button>
        {onCancel && (
          <button type="button" className="text" disabled={busy} onClick={onCancel}>
            取消
          </button>
        )}
        {editing &&
          (confirmDelete ? (
            <button type="button" className="text danger" disabled={busy} onClick={() => void remove()}>
              確定刪除
            </button>
          ) : (
            <button type="button" className="text danger" disabled={busy} onClick={() => setConfirmDelete(true)}>
              刪除這一筆
            </button>
          ))}
      </div>
    </form>
  );
}
