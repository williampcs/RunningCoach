import { useEffect, useState } from "react";

import {
  addDays,
  daysBetween,
  DIFFICULTY_LABELS,
  OUTCOME_LABELS,
  QUALITY_KINDS,
  STATUS_LABELS,
  weekdayName,
  type ActivePlan,
  type Race,
} from "@running-coach/core";

type SessionRow = ActivePlan["sessions"][number];

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

/** 一堂課：換算後的目標、目的、完成的標準與替代；可以跳過、改用替代、移到這週的別天 */
function SessionCard({ s, weekStart, fixed, onChange }: { s: SessionRow; weekStart: string; fixed: boolean; onChange: (action: "move" | "skip" | "fallback" | "restore", date?: string) => void }) {
  const [moving, setMoving] = useState(false);
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const r = s.result && s.result.outcome !== "pending" ? s.result : null;
  // 跳過與改用替代以外，顯示程式依實際紀錄的判斷
  const status = r && !["skipped", "fallback"].includes(r.outcome) ? OUTCOME_LABELS[r.outcome] : STATUS_LABELS[s.status];
  const done = r !== null && r.workoutId !== null;
  return (
    <li className={`session ${s.kind} ${s.status}`}>
      <div className="session-head">
        <span className="session-when">{s.when}</span>
        <strong>
          {s.kindLabel}：{s.title}
        </strong>
        {status && <span className={`badge ${r?.outcome ?? s.status}`}>{status}</span>}
      </div>
      {s.steps && (
        <p className="small">
          {s.steps}
          <span className="muted">（約 {s.km} km、{s.minutes} 分鐘）</span>
        </p>
      )}
      {(s.purpose || s.success) && (
        <p className="small muted">
          {s.purpose && `目的：${s.purpose}`}
          {s.purpose && s.success ? "；" : ""}
          {s.success && `完成的標準：${s.success}`}
        </p>
      )}
      {s.fallback && <p className="small muted">狀況不好時：{s.fallback}</p>}
      {s.note && <p className="small muted">調整的原因：{s.note}</p>}
      {r && (r.actual || r.reasons.length > 0) && (
        <p className="small session-result">
          {r.actual && `實際：${r.actual}`}
          {r.reasons.length > 0 && `${r.actual ? "。" : ""}${r.reasons.join("、")}`}
          {r.difficulty && `。${DIFFICULTY_LABELS[r.difficulty]}`}
        </p>
      )}
      {s.id !== null && !done && (
        <div className="row session-actions">
          {s.status === "planned" ? (
            <>
              {s.fallback && QUALITY_KINDS.has(s.kind) && <button onClick={() => onChange("fallback")}>改用替代</button>}
              {fixed && <button onClick={() => setMoving(!moving)}>移到別天</button>}
              <button onClick={() => onChange("skip")}>跳過</button>
            </>
          ) : (
            <button onClick={() => onChange("restore")}>恢復原本的課</button>
          )}
        </div>
      )}
      {moving && (
        <div className="row session-actions">
          {days
            .filter((d) => d !== s.date)
            .map((d) => (
              <button
                key={d}
                className="small"
                onClick={() => {
                  setMoving(false);
                  onChange("move", d);
                }}
              >
                {d.slice(5)}（{weekdayName(d).replace("星期", "")}）
              </button>
            ))}
        </div>
      )}
    </li>
  );
}

export function PlanView() {
  const { coach, revision, touch } = useApp();
  const [current, setCurrent] = useState<ActivePlan | null>(null);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [races, setRaces] = useState<Race[]>([]);
  const [form, setForm] = useState<RaceForm | null>(null);
  const [resultFor, setResultFor] = useState<{ id: number; time: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = coach.today();

  const plan = current?.plan ?? null;
  const structured = current !== null && current.plan.week_start != null;

  useEffect(() => {
    void coach.activePlan().then(setCurrent);
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
          <h2>訓練計畫{plan ? `（${plan.week_label}${structured ? `，${plan.week_start!.slice(5)} 起` : ""}）` : ""}</h2>
          {planDraft === null && !structured && <button onClick={() => setPlanDraft(plan?.content ?? "")}>{plan ? "編輯" : "手動填寫"}</button>}
        </div>
        {planDraft === null ? (
          structured ? (
            <>
              <p className="small muted">
                {current.styleLabel}｜約 {current.totalKm} km。配速與心率由程式依你的訓練數值換算；想改課表可以直接跟教練說，或在下面調整單堂課。
              </p>
              {plan!.reason && <p className="small">排課的原因：{plan!.reason}</p>}
              {plan!.notes && <div className="notice warn small">檢查器的提醒與教練的理由：{plan!.notes}</div>}
              {changeNote && <div className="notice ok small">{changeNote}</div>}
              <ul className="sessions">
                {current.sessions.map((s) => (
                  <SessionCard
                    key={s.id ?? s.title}
                    s={s}
                    weekStart={plan!.week_start!}
                    fixed={plan!.style !== "flexible"}
                    onChange={(action, date) =>
                      void run(async () => {
                        setChangeNote(await coach.changeSession(s.id!, action, { date, reason: "選手在計畫頁調整" }));
                      })
                    }
                  />
                ))}
              </ul>
              {current.extras.length > 0 && (
                <p className="small muted">課表外的跑步（排課前已跑或額外多跑的，算進這週的跑量）：{current.extras.join("；")}</p>
              )}
              <p className="small muted">實際的紀錄同步後自動對照課表。跑了不一樣的課、沒跑的課都不是失敗；沒跑的跳過即可，不要補。</p>
              {plan!.outline && (
                <>
                  <h3>之後幾週</h3>
                  <Markdown>{plan!.outline}</Markdown>
                </>
              )}
            </>
          ) : plan ? (
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
              備註
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
                    取消這場
                  </button>
                </div>
              )}
              {Boolean(race.cancelled) && (
                <div className="row">
                  <button
                    onClick={() => {
                      if (confirm(`確定要刪除「${race.name}」的紀錄嗎？刪除後無法復原。`)) void run(() => coach.db.deleteCancelledRace(race.id));
                    }}
                  >
                    刪除紀錄
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
