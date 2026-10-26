import { useEffect, useRef, useState } from "react";

import {
  activityLabel,
  addDays,
  heartRateText,
  type Activity,
  type OtherActivity,
  type ReportCandidate,
  type ReportTarget,
  type RunCard,
  type RunReport,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { featureEnabled } from "../environment";
import { SyncNotice } from "./PhoneGuide";
import { RunCardView } from "./RunCard";
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
    `配速：${a.avg_pace ?? "未知"}｜心率：${heartRateText(a.avg_hr, a.max_hr, "未記錄") ?? "沒有資料"}`,
    `爬升：${a.elevation_m ?? 0}m` + (a.training_load != null ? `｜負荷：${a.training_load}` : ""),
  ].join("\n");
}

/** 交給教練分析的訊息：資料已由表單存檔，一次呼叫就能完成，不必再走工具迴圈 */
export function analysisRequest(a: RunData, effort: number, notes: string, backfilled = false): string {
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

/** 騎車等其他運動交給教練分析的訊息（多運動）：體感已存檔，教練用 get_recent_workouts 看得到這趟 */
export function otherAnalysisRequest(a: OtherActivity, effort: number, notes: string): string {
  const parts = [`${Math.round(a.duration_min ?? 0)} 分鐘`, a.distance_km ? `${a.distance_km} km` : null, a.avg_hr != null ? `平均心率 ${a.avg_hr}` : null, a.training_load != null ? `負荷 ${a.training_load}` : null];
  return [
    `我在 ${a.date} 做了${activityLabel(a.type)}，請以教練角度給我回饋。`,
    "",
    `${activityLabel(a.type)}：${parts.filter(Boolean).join("｜")}`,
    `體感強度：${effort}/10`,
    `主觀感受：${notes || "未記錄"}`,
    "",
    "（體感已經存檔，不需要再呼叫 save_activity_feedback；這趟的數據在 get_recent_workouts 的其他運動，對照課表用 get_training_plan。）",
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
  t.kind === "saved" ? `saved:${t.workoutId}` : t.kind === "new" ? `new:${t.intervalsId}` : t.kind === "other" ? `other:${t.intervalsId}` : PENDING;

/** preselect：從教練動態進來時要預先選好的紀錄（跑步是 workout id，騎車等是 intervals_id） */
export function ReportView({ preselect, onPreselectUsed }: { preselect: number | string | null; onPreselectUsed: () => void }) {
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
  // 剛存檔那一趟的卡片
  const [card, setCard] = useState<RunCard | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (report?.status !== "saved") {
      setCard(null);
      return;
    }
    let alive = true;
    void coach.runCards(7).then((cards) => alive && setCard(cards.find((c) => c.workout.id === report.workoutId) ?? null));
    return () => {
      alive = false;
    };
  }, [coach, report, revision]);

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
      const key = typeof preselect === "number" ? `saved:${preselect}` : `other:${preselect}`;
      if (keys.includes(key)) {
        setSelected(key);
        return;
      }
    }
    setSelected((current) => (current && (current === PENDING || keys.includes(current)) ? current : (keys[0] ?? PENDING)));
  }, [choices, preselect, onPreselectUsed]);

  // 結果在表單下方：存檔後捲到結果
  useEffect(() => {
    if (card) resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [card?.workout.id]);

  const chosen = choices?.candidates.find((c) => targetKey(c.target) === selected) ?? null;
  const when = (c: ReportCandidate) => `${dayLabel(c.activity.date, today)}${c.startTime ? ` ${c.startTime}` : ""}`;
  const multisport = featureEnabled("multisport");
  const isOther = (c: ReportCandidate) => c.target.kind === "other";
  const submitLabel = chosen
    ? isOther(chosen)
      ? `存到${dayLabel(chosen.activity.date, today)}${chosen.startTime ? ` ${chosen.startTime} ` : ""}的${activityLabel(chosen.activity.type)}（${Math.round(chosen.activity.duration_min ?? 0)} 分鐘）`
      : `存到${dayLabel(chosen.activity.date, today)}${chosen.startTime ? ` ${chosen.startTime} ` : ""}的 ${chosen.activity.distance_km ?? "?"} km`
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
        <h2>{multisport ? "運動回報" : "跑後回報"}</h2>
        <p className="muted small">
          {multisport
            ? "選一趟跑步或騎車，填上體感。騎車要先同步才會出現；更早的可以在「紀錄」補填。"
            : "選一趟跑步，填上體感。更早的跑步可以在「紀錄」補填。"}
        </p>
        {hasIntervals &&
          (choices === null ? (
            <p className="muted small">讀取最近的跑步…</p>
          ) : (
            <fieldset className="choices" aria-label={multisport ? "要回報的運動" : "要回報的跑步"}>
              {choices.fetchError && (
                <div className="notice warn">無法取得 Intervals.icu 的活動（{choices.fetchError}），只列出已同步的紀錄。</div>
              )}
              {choices.candidates.length === 0 && !choices.fetchError && (
                <p className="muted small">{multisport ? "最近 3 天沒有還沒回報的跑步或騎車。" : "最近 3 天沒有還沒回報的跑步。"}</p>
              )}
              {choices.candidates.map((c) => {
                const key = targetKey(c.target);
                return (
                  <label key={key} className={`choice${selected === key ? " selected" : ""}`}>
                    <input type="radio" name="report-target" checked={selected === key} onChange={() => setSelected(key)} />
                    <span>
                      <strong>
                        {when(c)}
                        {isOther(c) && ` ${c.sport === "ride" ? "🚴 " : ""}${activityLabel(c.activity.type)}`}
                      </strong>
                      <span className="muted small">
                        {isOther(c)
                          ? [`${Math.round(c.activity.duration_min ?? 0)} 分`, c.activity.distance_km ? `${c.activity.distance_km} km` : null, c.activity.avg_hr != null ? `心率 ${c.activity.avg_hr}` : null]
                              .filter(Boolean)
                              .join("・")
                          : `${c.activity.distance_km ?? "?"} km・${c.activity.duration_min ?? "?"} 分${c.activity.avg_pace ? `・${c.activity.avg_pace}` : ""}`}
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
          <AutoGrowTextarea
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
        <SyncNotice message={sync.message} />
        {report?.status === "saved" && (
          <div className="report-result" ref={resultRef}>
            <div className="notice ok">已存檔。</div>
            {card ? (
              <RunCardView card={card} today={today}>
                <div className="row">
                  <button
                    className="primary"
                    onClick={() =>
                      goTo(
                        "chat",
                        analysisRequest(report.activity, submitted?.effort ?? 5, submitted?.notes ?? "", report.activity.date !== today),
                      )
                    }
                  >
                    請教練分析
                  </button>
                  <button className="link" onClick={() => goTo("history")}>
                    看所有紀錄
                  </button>
                </div>
              </RunCardView>
            ) : (
              <p className="muted small">讀取中…</p>
            )}
          </div>
        )}
        {report?.status === "other" && (
          <div className="report-result" ref={resultRef}>
            <div className="notice ok">已存到這趟{activityLabel(report.activity.type)}。</div>
            <div className="row">
              <button className="primary" onClick={() => goTo("chat", otherAnalysisRequest(report.activity, submitted?.effort ?? 5, submitted?.notes ?? ""))}>
                請教練分析
              </button>
              <button className="link" onClick={() => goTo("history")}>
                看所有紀錄
              </button>
            </div>
          </div>
        )}
        {report?.status === "pending" && (
          <div className="notice warn">
            已暫存今天（{report.date}）的回報。等手錶上傳到 Intervals.icu 後按「同步最近 14 天」，就會配對到今天的跑步。
          </div>
        )}
      </section>
    </>
  );
}
