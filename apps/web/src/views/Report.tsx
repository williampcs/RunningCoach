import { useEffect, useState } from "react";

import { addDays, type Activity, type ReportCandidate, type ReportTarget, type RunReport, type Workout } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { Markdown } from "../Markdown";
import { useSync } from "../use-sync";

/** 顯示與交給教練用到的欄位；剛拉取的活動與已存檔的訓練都適用 */
type RunData = Pick<
  Activity,
  "date" | "distance_km" | "duration_min" | "avg_pace" | "avg_hr" | "max_hr" | "elevation_m" | "training_load"
>;

function activityLines(a: RunData): string {
  return [
    `日期：${a.date}`,
    `距離：${a.distance_km ?? "?"}km｜時長：${a.duration_min ?? "?"}分鐘`,
    `配速：${a.avg_pace ?? "未知"}｜心率：${a.avg_hr ?? "未記錄"}/${a.max_hr ?? "未記錄"}bpm`,
    `爬升：${a.elevation_m ?? 0}m` + (a.training_load != null ? `｜負荷：${a.training_load}` : ""),
  ].join("\n");
}

/** 交給教練分析的訊息：資料已由表單存檔，一次呼叫就能完成，不必再走工具迴圈 */
function analysisRequest(a: RunData, effort: number, notes: string, backfilled = false): string {
  return [
    backfilled ? `我補記了 ${a.date} 那次跑步的感受，請以教練角度給我回饋。` : "我剛完成今天的跑步，請以教練角度給我回饋。",
    "",
    activityLines(a),
    `體感強度：${effort}/10`,
    `主觀感受：${notes || "未記錄"}`,
    "",
    "（這筆紀錄已經存檔，不需要再呼叫 fetch_latest_activity 或 save_workout。）",
  ].join("\n");
}

/** 今天、昨天、前天；更早的顯示日期 */
function dayLabel(date: string, today: string): string {
  if (date === today) return "今天";
  if (date === addDays(today, -1)) return "昨天";
  if (date === addDays(today, -2)) return "前天";
  return date;
}

const PENDING = "pending";
const targetKey = (t: ReportTarget) =>
  t.kind === "saved" ? `saved:${t.workoutId}` : t.kind === "new" ? `new:${t.intervalsId}` : PENDING;

/** preselect：從教練動態進來時要預先選好的紀錄 */
export function ReportView({ preselect, onPreselectUsed }: { preselect: number | null; onPreselectUsed: () => void }) {
  const { coach, settings, revision, touch, goTo, activitiesReady } = useApp();
  const today = coach.today();
  const [effort, setEffort] = useState(5);
  const [notes, setNotes] = useState("");
  // 可以回報的跑步；null 表示讀取中
  const [choices, setChoices] = useState<{ candidates: ReportCandidate[]; fetchError: string | null } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // 送出時的體感，給「請教練分析」用；表單送出後清空，方便接著回報下一筆
  const [submitted, setSubmitted] = useState<{ effort: number; notes: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const sync = useSync();
  const [report, setReport] = useState<RunReport | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);
  // 補填已存檔紀錄的體感：一次只開一筆的表單
  const [editing, setEditing] = useState<{ id: number; effort: number; notes: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [backfilled, setBackfilled] = useState<{ workout: Workout; summary: string | null } | null>(null);

  useEffect(() => {
    void coach.db.getRecentWorkouts(30).then(setWorkouts);
  }, [coach, revision]);

  const hasIntervals = activitiesReady;

  useEffect(() => {
    if (!activitiesReady) return;
    let alive = true;
    void coach.reportCandidates().then((result) => {
      if (alive) setChoices(result);
    });
    return () => {
      alive = false;
    };
  }, [coach, revision, activitiesReady]);

  // 預設選最新的一筆；從教練動態進來時選那一筆；原本選的還在就保留
  useEffect(() => {
    if (!choices) return;
    const keys = choices.candidates.map((c) => targetKey(c.target));
    if (preselect !== null) {
      onPreselectUsed();
      if (keys.includes(`saved:${preselect}`)) {
        setSelected(`saved:${preselect}`);
        return;
      }
    }
    setSelected((current) => (current && (current === PENDING || keys.includes(current)) ? current : (keys[0] ?? PENDING)));
  }, [choices, preselect, onPreselectUsed]);

  const chosen = choices?.candidates.find((c) => targetKey(c.target) === selected) ?? null;
  const when = (c: ReportCandidate) => `${dayLabel(c.activity.date, today)}${c.startTime ? ` ${c.startTime}` : ""}`;
  const submitLabel = chosen
    ? `存到${dayLabel(chosen.activity.date, today)}${chosen.startTime ? ` ${chosen.startTime} ` : ""}的 ${chosen.activity.distance_km ?? "?"} km`
    : "先存起來，等同步";

  async function submit() {
    setBusy(true);
    setMessage(null);
    setReport(null);
    try {
      const target: ReportTarget = chosen?.target ?? { kind: "pending" };
      setReport(await coach.reportRun(effort, notes.trim(), target));
      setSubmitted({ effort, notes: notes.trim() });
      setEffort(5);
      setNotes("");
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  function startEdit(w: Workout) {
    setEditing({ id: w.id, effort: w.perceived_effort ?? 5, notes: w.subjective_notes ?? "" });
    setBackfilled(null);
  }

  async function saveBackfill() {
    if (!editing) return;
    setSaving(true);
    setMessage(null);
    try {
      setBackfilled(await coach.addSubjective(editing.id, editing.effort, editing.notes));
      setEditing(null);
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      {!hasIntervals && (
        <div className="notice warn">
          尚未填寫 Intervals.icu 的 API key，無法取得手錶的活動資料。
          <button className="link" onClick={() => goTo("settings")}>
            前往設定
          </button>
        </div>
      )}

      <section className="card">
        <h2>跑後回報</h2>
        <p className="muted small">選一趟跑步，填上體感。更早的跑步可以在下方的訓練紀錄補填。</p>
        {hasIntervals &&
          (choices === null ? (
            <p className="muted small">讀取最近的跑步…</p>
          ) : (
            <fieldset className="choices" aria-label="要回報的跑步">
              {choices.fetchError && (
                <div className="notice warn">無法取得 Intervals.icu 的活動（{choices.fetchError}），只列出已同步的紀錄。</div>
              )}
              {choices.candidates.length === 0 && !choices.fetchError && (
                <p className="muted small">最近 3 天沒有還沒回報的跑步。</p>
              )}
              {choices.candidates.map((c) => {
                const key = targetKey(c.target);
                return (
                  <label key={key} className={`choice${selected === key ? " selected" : ""}`}>
                    <input type="radio" name="report-target" checked={selected === key} onChange={() => setSelected(key)} />
                    <span>
                      <strong>{when(c)}</strong>
                      <span className="muted small">
                        {c.activity.distance_km ?? "?"} km・{c.activity.duration_min ?? "?"} 分
                        {c.activity.avg_pace ? `・${c.activity.avg_pace}` : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
              <label className={`choice${selected === PENDING ? " selected" : ""}`}>
                <input type="radio" name="report-target" checked={selected === PENDING} onChange={() => setSelected(PENDING)} />
                <span>
                  <strong>這一趟還沒同步</strong>
                  <span className="muted small">手錶還沒上傳的話，先存起來，之後同步時配對到今天的跑步。</span>
                </span>
              </label>
            </fieldset>
          ))}
        <label>
          <span>
            體感強度：<strong>{effort}</strong> / 10
          </span>
          <input type="range" min={1} max={10} value={effort} onChange={(e) => setEffort(Number(e.target.value))} />
        </label>
        <label>
          主觀感受
          <textarea
            rows={2}
            value={notes}
            placeholder="例如：腿有點重，呼吸順，右膝無異狀"
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <div className="row">
          <button
            className="primary"
            disabled={busy || sync.busy || !hasIntervals || selected === null}
            onClick={() => void submit()}
          >
            {busy ? "處理中…" : submitLabel}
          </button>
          <button disabled={busy || sync.busy || !hasIntervals} onClick={() => void sync.run()}>
            {sync.busy ? "同步中…" : "同步最近 14 天"}
          </button>
        </div>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        {sync.message && <div className={`notice ${sync.message.kind}`}>{sync.message.text}</div>}
        {report?.status === "saved" && (
          <div className="notice ok">
            <strong>已存檔</strong>
            <pre>{activityLines(report.activity)}</pre>
            {report.summary ? <Markdown>{report.summary}</Markdown> : <p className="muted">這次沒有產生分析摘要。</p>}
            <button
              className="primary"
              onClick={() =>
                goTo(
                  "chat",
                  analysisRequest(
                    report.activity,
                    submitted?.effort ?? 5,
                    submitted?.notes ?? "",
                    report.activity.date !== today,
                  ),
                )
              }
            >
              請教練分析
            </button>
          </div>
        )}
        {report?.status === "pending" && (
          <div className="notice warn">
            已暫存今天（{report.date}）的回報。等手錶上傳到 Intervals.icu 後按「同步最近 14 天」，就會配對到今天的跑步。
          </div>
        )}
      </section>

      <section className="card">
        <h2>最近 30 天的訓練</h2>
        {workouts.length === 0 && <p className="muted">還沒有訓練紀錄。</p>}
        <ul className="list">
          {workouts.map((w) => (
            <li key={w.id}>
              <div className="row between">
                <strong>{w.date}</strong>
                <span>
                  {w.distance_km ?? "?"}km｜{w.avg_pace ?? "?"}
                </span>
              </div>
              <div className="muted small">
                心率 {w.avg_hr ?? "?"}/{w.max_hr ?? "?"}bpm
                {w.training_load != null && `｜負荷 ${w.training_load}`}
                {w.perceived_effort != null && `｜體感 ${w.perceived_effort}/10`}
                {w.subjective_notes && `｜${w.subjective_notes}`}
              </div>
              {w.summary && (
                <div className="small">
                  <Markdown>{w.summary}</Markdown>
                </div>
              )}
              {editing?.id === w.id ? (
                <div className="backfill">
                  <label>
                    <span>
                      體感強度：<strong>{editing.effort}</strong> / 10
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={10}
                      value={editing.effort}
                      onChange={(e) => setEditing({ ...editing, effort: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    主觀感受
                    <textarea
                      rows={2}
                      value={editing.notes}
                      placeholder="例如：最後兩公里很喘，腿還好"
                      onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
                    />
                  </label>
                  <div className="row">
                    <button className="primary" disabled={saving} onClick={() => void saveBackfill()}>
                      {saving ? "儲存並分析中…" : "儲存並重新分析"}
                    </button>
                    <button disabled={saving} onClick={() => setEditing(null)}>
                      取消
                    </button>
                  </div>
                </div>
              ) : (
                <div className="row">
                  <button className="small" disabled={editing !== null} onClick={() => startEdit(w)}>
                    {w.perceived_effort != null ? "修改體感" : "補填體感"}
                  </button>
                  {backfilled?.workout.id === w.id && (
                    <button
                      className="small primary"
                      onClick={() =>
                        goTo(
                          "chat",
                          analysisRequest(
                            backfilled.workout,
                            backfilled.workout.perceived_effort ?? 5,
                            backfilled.workout.subjective_notes ?? "",
                            true,
                          ),
                        )
                      }
                    >
                      請教練分析
                    </button>
                  )}
                </div>
              )}
              {backfilled?.workout.id === w.id && !backfilled.summary && (
                <p className="muted small">體感已存檔；這次沒有重新產生分析。</p>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
