import { useEffect, useState } from "react";

import { daysBetween, type Race, type TrainingPlan } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";

interface RaceForm {
  id: number | null;
  name: string;
  date: string;
  distance: string;
  target: string;
  confirmed: boolean;
  notes: string;
}

const EMPTY_RACE: RaceForm = { id: null, name: "", date: "", distance: "", target: "", confirmed: true, notes: "" };

function raceStatus(race: Race, today: string): string {
  if (race.cancelled) return "已取消";
  if (race.result_time) return `成績 ${race.result_time}`;
  const days = daysBetween(today, race.date);
  if (days < 0) return `${-days} 天前，尚未記錄成績`;
  return (days === 0 ? "今天" : `還有 ${days} 天`) + (race.confirmed ? "" : "（考慮中）");
}

export function PlanView() {
  const { coach, revision, touch } = useApp();
  const [plan, setPlan] = useState<TrainingPlan | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [races, setRaces] = useState<Race[]>([]);
  const [form, setForm] = useState<RaceForm | null>(null);
  const [resultFor, setResultFor] = useState<{ id: number; time: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = coach.today();

  useEffect(() => {
    void coach.db.getActiveTrainingPlan().then(setPlan);
    void coach.db.getAllRaces().then(setRaces);
  }, [coach, revision]);

  async function run(action: () => Promise<unknown>) {
    setError(null);
    try {
      await action();
      touch();
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function saveRace(f: RaceForm) {
    const distance = Number(f.distance);
    if (!f.name.trim() || !f.date || !Number.isFinite(distance) || distance <= 0) {
      setError("請填寫賽事名稱、日期與距離（公里）。");
      return;
    }
    await run(async () => {
      const fields = {
        name: f.name.trim(),
        date: f.date,
        distance_km: distance,
        target_time: f.target.trim(),
        confirmed: f.confirmed ? 1 : 0,
        notes: f.notes.trim(),
      };
      if (f.id === null) await coach.db.addRace(fields);
      else await coach.db.updateRace(f.id, fields);
      setForm(null);
    });
  }

  // 未來與待補登成績的在前（由近到遠），其餘歷史紀錄在後
  const active = races.filter((r) => !r.cancelled && !r.result_time).sort((a, b) => a.date.localeCompare(b.date));
  const history = races.filter((r) => r.cancelled || r.result_time);

  return (
    <>
      <section className="card">
        <div className="row between">
          <h2>訓練計畫{plan ? `（${plan.week_label}）` : ""}</h2>
          {planDraft === null && <button onClick={() => setPlanDraft(plan?.content ?? "")}>{plan ? "編輯" : "手動填寫"}</button>}
        </div>
        {planDraft === null ? (
          plan ? (
            <Markdown>{plan.content}</Markdown>
          ) : (
            <p className="muted">還沒有訓練計畫。可以在對話中請教練排，或自己填寫。</p>
          )
        ) : (
          <>
            <textarea rows={10} value={planDraft} aria-label="訓練計畫內容" onChange={(e) => setPlanDraft(e.target.value)} />
            <div className="row">
              <button
                className="primary"
                disabled={!planDraft.trim()}
                onClick={() =>
                  void run(async () => {
                    await coach.savePlanForThisWeek(planDraft.trim());
                    setPlanDraft(null);
                  })
                }
              >
                儲存為本週計畫
              </button>
              <button onClick={() => setPlanDraft(null)}>取消</button>
            </div>
          </>
        )}
      </section>

      <section className="card">
        <div className="row between">
          <h2>賽事</h2>
          {form === null && <button onClick={() => setForm(EMPTY_RACE)}>新增賽事</button>}
        </div>
        {error && <div className="notice error">{error}</div>}
        {form && (
          <form
            className="grid"
            onSubmit={(e) => {
              e.preventDefault();
              void saveRace(form);
            }}
          >
            <label className="wide">
              賽事名稱
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </label>
            <label>
              日期
              <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} />
            </label>
            <label>
              距離（km）
              <input inputMode="decimal" value={form.distance} placeholder="21.1" onChange={(e) => setForm({ ...form, distance: e.target.value })} />
            </label>
            <label>
              目標時間
              <input value={form.target} placeholder="留空表示完賽即可" onChange={(e) => setForm({ ...form, target: e.target.value })} />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.confirmed} onChange={(e) => setForm({ ...form, confirmed: e.target.checked })} />
              已確認報名
            </label>
            <label className="wide">
              備注
              <input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
            </label>
            <div className="row wide">
              <button type="submit" className="primary">
                {form.id === null ? "新增" : "儲存變更"}
              </button>
              <button type="button" onClick={() => setForm(null)}>
                取消
              </button>
            </div>
          </form>
        )}
        {races.length === 0 && !form && <p className="muted">還沒有賽事。</p>}
        <ul className="list">
          {[...active, ...history].map((race) => (
            <li key={race.id} className={race.cancelled ? "dim" : ""}>
              <div className="row between">
                <strong>{race.name}</strong>
                <span className="small">{raceStatus(race, today)}</span>
              </div>
              <div className="muted small">
                {race.date}｜{race.distance_km}km｜目標 {race.target_time || "完賽"}
                {race.notes && `｜${race.notes}`}
              </div>
              {!race.cancelled && !race.result_time && (
                <div className="row">
                  <button
                    onClick={() =>
                      setForm({
                        id: race.id,
                        name: race.name,
                        date: race.date,
                        distance: String(race.distance_km),
                        target: race.target_time ?? "",
                        confirmed: Boolean(race.confirmed),
                        notes: race.notes ?? "",
                      })
                    }
                  >
                    編輯
                  </button>
                  {race.date <= today && resultFor?.id !== race.id && (
                    <button onClick={() => setResultFor({ id: race.id, time: "" })}>記錄成績</button>
                  )}
                  <button
                    onClick={() => {
                      if (confirm(`確定要把「${race.name}」標記為取消嗎？紀錄會保留。`)) void run(() => coach.db.cancelRace(race.id));
                    }}
                  >
                    取消報名
                  </button>
                </div>
              )}
              {resultFor?.id === race.id && (
                <form
                  className="row"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!resultFor.time.trim()) return;
                    void run(async () => {
                      await coach.db.updateRaceResult(race.id, resultFor.time.trim());
                      setResultFor(null);
                    });
                  }}
                >
                  <input
                    autoFocus
                    value={resultFor.time}
                    placeholder="完賽時間，例：1:55:30"
                    aria-label="完賽時間"
                    onChange={(e) => setResultFor({ id: race.id, time: e.target.value })}
                  />
                  <button type="submit" className="primary">
                    儲存
                  </button>
                  <button type="button" onClick={() => setResultFor(null)}>
                    取消
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
