import { useEffect, useState } from "react";

import {
  addDays,
  DIFFICULTY_LABELS,
  OUTCOME_LABELS,
  QUALITY_KINDS,
  STATUS_LABELS,
  weekdayName,
  type ActivePlan,
} from "@running-coach/core";

type SessionRow = ActivePlan["sessions"][number];

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Markdown } from "../Markdown";
import { RacesCard } from "./Races";

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
  const [error, setError] = useState<string | null>(null);
  const today = coach.today();

  const plan = current?.plan ?? null;
  const structured = current !== null && current.plan.week_start != null;

  // 週日先排好的下週課表：這週的還在用，下週的另外列在下面
  const [next, setNext] = useState<ActivePlan | null>(null);

  useEffect(() => {
    void coach.activePlan().then(setCurrent);
    void coach.nextPlan().then(setNext);
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

  return (
    <>
      <section className="card">
        <div className="row between">
          <h2>訓練計畫{plan ? `（${plan.week_label}${structured ? `，${plan.week_start!.slice(5)} 起` : ""}）` : ""}</h2>
          {planDraft === null && !structured && <button onClick={() => setPlanDraft(plan?.content ?? "")}>{plan ? "編輯" : "手動填寫"}</button>}
        </div>
        {error && <div className="notice error">{error}</div>}
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
            <AutoGrowTextarea minRows={6} maxRows={20} value={planDraft} aria-label="訓練計畫內容" onChange={(e) => setPlanDraft(e.target.value)} />
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

      {next?.plan.week_start && (
        <section className="card">
          <h2>
            下週的課表（{next.plan.week_label}，{next.plan.week_start.slice(5)} 起）
          </h2>
          <p className="small muted">
            {next.styleLabel}｜約 {next.totalKm} km。已經排好，下週一開始用。
          </p>
          {next.plan.reason && <p className="small">排課的原因：{next.plan.reason}</p>}
          <ul className="sessions">
            {next.sessions.map((s) => (
              <SessionCard
                key={s.id ?? s.title}
                s={s}
                weekStart={next.plan.week_start!}
                fixed={next.plan.style !== "flexible"}
                onChange={(action, date) =>
                  void run(async () => {
                    setChangeNote(await coach.changeSession(s.id!, action, { date, reason: "選手在計畫頁調整" }));
                  })
                }
              />
            ))}
          </ul>
        </section>
      )}

      <RacesCard />
    </>
  );
}
