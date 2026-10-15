import { useEffect, useState } from "react";

import type { Activity, RunReport, Workout } from "@running-coach/core";

import { errorText, useApp } from "../app-context";

function activityLines(a: Activity): string {
  return [
    `日期：${a.date}`,
    `距離：${a.distance_km ?? "?"}km｜時長：${a.duration_min ?? "?"}分鐘`,
    `配速：${a.avg_pace ?? "未知"}｜心率：${a.avg_hr ?? "未記錄"}/${a.max_hr ?? "未記錄"}bpm`,
    `爬升：${a.elevation_m ?? 0}m` + (a.training_load != null ? `｜負荷：${a.training_load}` : ""),
  ].join("\n");
}

/** 交給教練分析的訊息：資料已由表單存檔，一次呼叫就能完成，不必再走工具迴圈 */
function analysisRequest(a: Activity, effort: number, notes: string): string {
  return [
    "我剛完成今天的跑步，請以教練角度給我回饋。",
    "",
    activityLines(a),
    `體感強度：${effort}/10`,
    `主觀感受：${notes || "未記錄"}`,
    "",
    "（這筆紀錄已經存檔，不需要再呼叫 fetch_latest_activity 或 save_workout。）",
  ].join("\n");
}

export function ReportView() {
  const { coach, settings, revision, touch, goTo } = useApp();
  const [effort, setEffort] = useState(5);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState<"report" | "sync" | null>(null);
  const [report, setReport] = useState<RunReport | null>(null);
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [workouts, setWorkouts] = useState<Workout[]>([]);

  useEffect(() => {
    void coach.db.getRecentWorkouts(30).then(setWorkouts);
  }, [coach, revision]);

  const hasIntervals = settings.intervals.apiKey.trim() !== "";

  async function submit() {
    setBusy("report");
    setMessage(null);
    setReport(null);
    try {
      setReport(await coach.reportRun(effort, notes.trim()));
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(null);
    }
  }

  async function sync() {
    setBusy("sync");
    setMessage(null);
    try {
      const text = await coach.sync();
      setMessage({ kind: text.startsWith("❌") ? "error" : "ok", text });
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setBusy(null);
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
        <h2>今天跑完了？</h2>
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
          <button className="primary" disabled={busy !== null || !hasIntervals} onClick={() => void submit()}>
            {busy === "report" ? "處理中…" : "儲存跑後回報"}
          </button>
          <button disabled={busy !== null || !hasIntervals} onClick={() => void sync()}>
            {busy === "sync" ? "同步中…" : "同步最近 14 天"}
          </button>
        </div>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        {report?.status === "saved" && (
          <div className="notice ok">
            <strong>已存檔</strong>
            <pre>{activityLines(report.activity)}</pre>
            {report.summary ? <p>{report.summary}</p> : <p className="muted">這次沒有產生分析摘要。</p>}
            <button className="primary" onClick={() => goTo("chat", analysisRequest(report.activity, effort, notes.trim()))}>
              請教練分析
            </button>
          </div>
        )}
        {report?.status === "pending" && (
          <div className="notice warn">
            Intervals.icu 上還沒有今天（{report.date}）的跑步活動
            {report.latest ? `，最新一筆是 ${report.latest.date}` : ""}。
            你的體感已先暫存，等手錶同步後按「同步最近 14 天」就會自動合併。
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
              {w.summary && <p className="small">{w.summary}</p>}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
