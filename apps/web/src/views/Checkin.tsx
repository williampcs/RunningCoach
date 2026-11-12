import { useEffect, useRef, useState } from "react";

import { injuryName, type DailyCheckin, type Injury } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { checkRedFlags } from "../red-flag-alert";
import { PainPicker } from "../ui";

const SCALES = [
  { key: "energy", label: "精神", low: "很差", high: "很好" },
  { key: "soreness", label: "痠痛", low: "沒有", high: "很痠" },
  { key: "sleep", label: "睡眠", low: "很差", high: "很好" },
] as const;

/** 今天已經回報過的分數（自評時記的） */
function todayPain(list: Injury[], today: string): Record<number, number> {
  return Object.fromEntries(list.flatMap((i) => i.scores.filter((x) => x.date === today && x.when === "checkin").map((x) => [i.id, x.score])));
}

/**
 * 今天的身體狀況：三個 1–5 分加上備註. 有還沒好的傷時，每個傷多問一題「左膝今天幾分？」（0–10，規格 12.33；
 * 不回答就不記）. 備註有紅旗的字詞時出現就醫提示
 */
function CheckinForm({ initial, injuries, onDone, onCancel }: { initial: DailyCheckin | null; injuries: Injury[]; onDone: () => void; onCancel?: () => void }) {
  const { coach, touch } = useApp();
  const today = coach.today();
  const [values, setValues] = useState(() =>
    initial ? { energy: initial.energy, soreness: initial.soreness, sleep: initial.sleep, notes: initial.notes ?? "" } : { energy: 3, soreness: 2, sleep: 3, notes: "" },
  );
  const [pain, setPain] = useState<Record<number, number>>(() => todayPain(injuries, today));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      await coach.saveCheckin(values);
      for (const [id, score] of Object.entries(pain)) await coach.db.addInjuryScore(Number(id), { date: today, score, when: "checkin" });
      checkRedFlags(values.notes);
      touch();
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="checkin">
      {SCALES.map((s) => (
        <label key={s.key}>
          <span>
            {s.label} <strong>{values[s.key]}</strong>/5 · 1 {s.low}、5 {s.high}
          </span>
          <input
            type="range"
            min={1}
            max={5}
            value={values[s.key]}
            aria-label={s.label}
            onChange={(e) => setValues({ ...values, [s.key]: Number(e.target.value) })}
          />
        </label>
      ))}
      {injuries.map((i) => (
        <div key={i.id} className="pain-question">
          <span>
            {injuryName(i)}今天幾分？{pain[i.id] !== undefined && <strong> {pain[i.id]}/10</strong>}
          </span>
          <PainPicker value={pain[i.id] ?? null} label={`${injuryName(i)}的疼痛`} onChange={(n) => setPain({ ...pain, [i.id]: n })} />
        </div>
      ))}
      <label>
        備註
        <AutoGrowTextarea value={values.notes} placeholder="例如：右小腿有點緊" onChange={(e) => setValues({ ...values, notes: e.target.value })} />
      </label>
      {error && <div className="notice error">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={busy} onClick={() => void save()}>
          {busy ? "儲存中…" : "儲存"}
        </button>
        {onCancel && (
          <button className="text" onClick={onCancel}>
            取消
          </button>
        )}
      </div>
    </div>
  );
}

/** 自評過了、但還沒好的傷今天還沒有分數時：只問分數（規格 12.33） */
function PainForm({ injuries, onDone }: { injuries: Injury[]; onDone: () => void }) {
  const { coach, touch } = useApp();
  const today = coach.today();
  const [pain, setPain] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const answered = Object.keys(pain).length > 0;

  async function save() {
    try {
      for (const [id, score] of Object.entries(pain)) await coach.db.addInjuryScore(Number(id), { date: today, score, when: "checkin" });
      touch();
      onDone();
    } catch (e) {
      setError(errorText(e));
    }
  }

  return (
    <div className="checkin pain-scores" id="pain-scores">
      {injuries.map((i) => (
        <div key={i.id} className="pain-question">
          <span>
            {injuryName(i)}今天幾分？{pain[i.id] !== undefined && <strong> {pain[i.id]}/10</strong>}
          </span>
          <PainPicker value={pain[i.id] ?? null} label={`${injuryName(i)}的疼痛`} onChange={(n) => setPain({ ...pain, [i.id]: n })} />
        </div>
      ))}
      {error && <div className="notice error">{error}</div>}
      <div className="actions">
        <button className="primary" disabled={!answered} onClick={() => void save()}>
          儲存分數
        </button>
      </div>
    </div>
  );
}

/**
 * 「回報」分頁最上面的今天的身體狀況（2026-11-12 從教練動態搬來）：
 * 還沒回報時是表單；回報過了收成一行（今天的結果）與「修改」；有還沒好的傷今天還沒分數時，下面問分數.
 * focus：從看板的「去回報」進來時捲到這裡（讀完才捲，表單讀完才顯示，KI-047）
 */
export function CheckinSection({ focus, onFocusUsed }: { focus: boolean; onFocusUsed: () => void }) {
  const { coach, revision } = useApp();
  const today = coach.today();
  // 讀完今天的自評才顯示欄位：不然讀到的值會蓋掉讀完之前已經打的字（KI-047）
  const [data, setData] = useState<{ checkin: DailyCheckin | null; injuries: Injury[]; date: string } | null>(null);
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([coach.db.getCheckin(today), coach.db.getInjuries()]).then(([checkin, injuries]) => {
      if (!cancelled) setData({ checkin, injuries, date: today });
    });
    return () => {
      cancelled = true;
    };
  }, [coach, today, revision]);

  useEffect(() => {
    if (!focus || !data) return;
    onFocusUsed();
    ref.current?.scrollIntoView({ block: "start" });
  }, [focus, data, onFocusUsed]);

  if (!data || data.date !== today) return null;
  const { checkin, injuries } = data;
  const unscored = injuries.filter((i) => i.scores.at(-1)?.date !== today);

  return (
    <section className="card checkin-card" id="checkin" ref={ref} aria-label="今天的身體狀況">
      {!checkin || editing ? (
        <>
          <h2 className="title">今天身體如何？</h2>
          {!checkin && <p className="muted small">花 10 秒回報精神、痠痛與睡眠，沒跑步的日子也可以填。</p>}
          <CheckinForm
            // 換日或讀到新的自評時重新帶入
            key={`${today}-${checkin ? "edit" : "new"}`}
            initial={checkin}
            injuries={injuries}
            onDone={() => setEditing(false)}
            onCancel={checkin ? () => setEditing(false) : undefined}
          />
        </>
      ) : (
        <>
          <div className="card-head">
            <h2 className="title">今天的身體狀況</h2>
            <button className="text" onClick={() => setEditing(true)}>
              修改
            </button>
          </div>
          <p className="checkin-summary">
            精神 {checkin.energy}/5 · 痠痛 {checkin.soreness}/5 · 睡眠 {checkin.sleep}/5
          </p>
          {checkin.notes && <p className="muted small">{checkin.notes}</p>}
          {unscored.length > 0 && <PainForm key={unscored.map((i) => i.id).join("-")} injuries={unscored} onDone={() => undefined} />}
        </>
      )}
    </section>
  );
}
