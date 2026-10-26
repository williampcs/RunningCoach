import { useEffect, useState, type MouseEvent } from "react";

import {
  addDays,
  DIFFICULTY_LABELS,
  monthDay,
  OUTCOME_LABELS,
  planTimeline,
  QUALITY_KINDS,
  raceStatusText,
  STATUS_LABELS,
  weekdayName,
  type ActivePlan,
  type PlanTimeline,
  type Race,
  type SessionKind,
  type StepIntensity,
  type StepRow,
  type TimelineSession,
} from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { featureEnabled } from "../environment";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Markdown } from "../Markdown";
import { RacesCard } from "./Races";

type SessionChange = (s: TimelineSession, action: "move" | "skip" | "fallback" | "restore" | "done" | "undone", date?: string) => void;

const weekdayOf = (date: string) => weekdayName(date).replace("星期", "");

/** 一堂課的色條：和紀錄頁的強度橫條同一套顏色 */
const KIND_INTENSITY: Record<SessionKind, StepIntensity> = {
  easy: "low",
  long: "low",
  marathon: "moderate",
  threshold: "moderate",
  interval: "high",
  repetition: "high",
  race: "high",
  rest: "other",
  cross: "other",
  strength: "other",
};

function statusOf(s: TimelineSession): { label: string; cls: string } | null {
  const r = s.result && s.result.outcome !== "pending" ? s.result : null;
  // 選手在 App 裡回報做完了（肌力等沒有手錶紀錄的課，規格 12.24）
  if (s.doneAt && r?.outcome === "achieved" && r.workoutId === null) return { label: "做完了", cls: "achieved" };
  // 跳過與改用替代以外，顯示程式依實際紀錄的判斷
  const label =
    r && !["skipped", "fallback"].includes(r.outcome)
      ? r.outcome === "missed" && !s.isRun
        ? "沒做"
        : OUTCOME_LABELS[r.outcome]
      : STATUS_LABELS[s.status];
  return label ? { label, cls: r?.outcome ?? s.status } : null;
}

function Steps({ rows }: { rows: StepRow[] }) {
  const line = (x: { name: string; target: string; length: string; intensity: StepIntensity }, key: number) => (
    <li key={key} className="plan-step">
      <span className={`bar ${x.intensity}`} aria-hidden="true" />
      <span className="plan-step-name">
        {x.name}
        {x.target && <span className="muted"> {x.target}</span>}
      </span>
      <span className="muted plan-step-length">{x.length}</span>
    </li>
  );
  return (
    <ol className="plan-steps">
      {rows.map((row, i) =>
        row.type === "repeat" ? (
          <li key={i} className="plan-repeat">
            <span className="plan-repeat-head">重複 {row.times} 次</span>
            <ol className="plan-steps">{row.steps.map(line)}</ol>
          </li>
        ) : (
          line(row, i)
        ),
      )}
    </ol>
  );
}

/** 一堂課：今天（或下一堂）放大；其他天是小卡片，點了展開成同樣的內容 */
function SessionItem({ s, focus, onChange }: { s: TimelineSession; focus: boolean; onChange: SessionChange }) {
  // 放大的那張預設展開，點了也可以收合；放大的換成別堂時（例如跳過後）跟著換
  const [open, setOpen] = useState(focus);
  useEffect(() => setOpen(focus), [focus]);
  const [details, setDetails] = useState(false);
  const [moving, setMoving] = useState(false);
  const status = statusOf(s);
  const r = s.result && s.result.outcome !== "pending" ? s.result : null;
  const done = r !== null && r.workoutId !== null;
  // 肌力的課可以在 App 裡回報做完了（多運動，規格 12.24）：今天以前（或沒有日期）、還沒配到手錶紀錄的
  const today = useApp().coach.today();
  const reportable =
    featureEnabled("multisport") && s.kind === "strength" && s.id !== null && (!s.date || s.date <= today) && !(r?.outcome === "achieved" && !s.doneAt);

  if (s.kind === "rest") {
    // 休息日只有一行，沒有按鈕
    return (
      <div className="plan-rest muted">
        {s.title === "休息" ? "休息" : s.title}
        {status && <span className={`badge ${status.cls}`}>{status.label}</span>}
      </div>
    );
  }

  const expanded = open;
  // 點卡片的任何地方都展開或收合；卡片裡的按鈕、連結照原本的行為；選取文字時不觸發
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, summary")) return;
    if (window.getSelection()?.toString()) return;
    setOpen(!open);
  };
  const title = (
    <>
      <span className={`bar ${KIND_INTENSITY[s.kind]}`} aria-hidden="true" />
      <span className="plan-session-title">
        <strong className={focus ? "plan-session-name big" : "plan-session-name"}>{s.title}</strong>
        {s.kindHint && <span className="muted small"> {s.kindHint}</span>}
      </span>
      {status && <span className={`badge ${status.cls}`}>{status.label}</span>}
    </>
  );
  const chips = (list: string[]) =>
    list.length > 0 && (
      <div className="chips">
        {list.map((c) => (
          <span key={c} className="chip">
            {c}
          </span>
        ))}
      </div>
    );
  const days = Array.from({ length: 7 }, (_, i) => addDays(s.weekStart, i));
  const hasDetails = !!(s.purpose || s.success || s.fallback);

  return (
    <article className={`plan-session ${focus ? "focus" : ""} ${s.status}`} data-kind={s.kind} onClick={onCardClick}>
      <button type="button" className="plan-session-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
      </button>
      {!expanded && chips(s.brief)}
      {expanded && (
        <>
          {chips(s.chips)}
          {s.rows.length > 0 && <Steps rows={s.rows} />}
          {r && (r.actual || r.reasons.length > 0) && (
            <p className="small session-result">
              {r.actual && `實際：${r.actual}`}
              {r.reasons.length > 0 && `${r.actual ? "。" : ""}${r.reasons.join("、")}`}
              {r.difficulty && `。${DIFFICULTY_LABELS[r.difficulty]}`}
            </p>
          )}
          {s.note && <p className="small muted">調整的原因：{s.note}</p>}
          {hasDetails && (
            <button type="button" className="link-button muted" aria-expanded={details} onClick={() => setDetails(!details)}>
              細節 {details ? "▴" : "▾"}
            </button>
          )}
          {details && (
            <dl className="plan-details small">
              {s.purpose && (
                <>
                  <dt>目的</dt>
                  <dd>{s.purpose}</dd>
                </>
              )}
              {s.success && (
                <>
                  <dt>完成的標準</dt>
                  <dd>{s.success}</dd>
                </>
              )}
              {s.fallback && (
                <>
                  <dt>狀況不好時</dt>
                  <dd>{s.fallback}</dd>
                </>
              )}
            </dl>
          )}
          {s.id !== null && !done && (
            <div className="row session-actions">
              {s.doneAt ? (
                featureEnabled("multisport") && <button onClick={() => onChange(s, "undone")}>取消「做完了」</button>
              ) : s.status === "planned" ? (
                <>
                  {reportable && (
                    <button className="primary" onClick={() => onChange(s, "done")}>
                      做完了
                    </button>
                  )}
                  {s.fallback && QUALITY_KINDS.has(s.kind) && <button onClick={() => onChange(s, "fallback")}>改用替代</button>}
                  {s.fixed && <button onClick={() => setMoving(!moving)}>移到別天</button>}
                  <button onClick={() => onChange(s, "skip")}>跳過</button>
                </>
              ) : (
                <button onClick={() => onChange(s, "restore")}>恢復原本的課</button>
              )}
            </div>
          )}
          {moving && (
            <div className="row session-actions move-days">
              {days
                .filter((d) => d !== s.date)
                .map((d) => (
                  <button
                    key={d}
                    className="small"
                    onClick={() => {
                      setMoving(false);
                      onChange(s, "move", d);
                    }}
                  >
                    {monthDay(d)}（{weekdayOf(d)}）
                  </button>
                ))}
            </div>
          )}
        </>
      )}
    </article>
  );
}

const FLAG = (
  <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
    <path d="M3 15V2M3 2h9l-2 3 2 3H3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
  </svg>
);

/** 賽事卡：點了捲到下面的賽事區 */
function RaceItem({ race, today }: { race: Race; today: string }) {
  return (
    <button type="button" className="plan-race" onClick={() => document.getElementById("races")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
      <span className="plan-race-head">
        <span className="plan-race-flag">{FLAG}</span>
        <strong>{race.name}</strong>
        <span className="plan-race-days">{raceStatusText(race, today)}</span>
      </span>
      <span className="chips">
        <span className="chip">{Math.round(race.distance_km * 10) / 10} km</span>
        {race.target_time && <span className="chip">目標 {race.target_time}</span>}
      </span>
    </button>
  );
}

/** 日期欄：手機上日期與星期分兩行（「二」），電腦上夠寬時一行（「10/27 星期二」） */
function DateLabel({ label, weekday, today, race }: { label: string; weekday?: string; today?: boolean; race?: boolean }) {
  return (
    <div className={`tl-date ${today ? "today" : ""} ${race ? "race" : ""}`}>
      <span className="tl-when">
        <span className="tl-label">{label}</span>
        {weekday && (
          <span className="tl-weekday">
            <span className="wide-only">星期</span>
            {weekday}
          </span>
        )}
      </span>
    </div>
  );
}


function Timeline({ t, today, onChange }: { t: PlanTimeline; today: string; onChange: SessionChange }) {
  const item = (s: TimelineSession) => <SessionItem key={s.id ?? s.title} s={s} focus={s === t.focus} onChange={onChange} />;
  return (
    <ol className="timeline">
      {t.undated.length > 0 && (
        <li className="tl-day">
          <DateLabel label="這週任一天" />
          <div className="tl-items">{t.undated.map(item)}</div>
        </li>
      )}
      {t.days.map((d) => (
        <li key={d.date} className={`tl-day ${d.date === today ? "today" : ""}`} data-date={d.date}>
          {d.nextWeek && (
            <div className="tl-week small muted">
              下週 {d.nextWeek.range} · {d.nextWeek.km} km · {d.nextWeek.runs} 次跑步
            </div>
          )}
          <div className="tl-row">
            <DateLabel label={d.label} weekday={d.weekday} today={d.date === today} race={d.races.length > 0 && !d.sessions.length} />
            <div className="tl-items">
              {d.sessions.map(item)}
              {!d.sessions.length && !d.races.length && <div className="plan-rest muted">休息</div>}
              {d.races.map((r) => (
                <RaceItem key={r.id} race={r} today={today} />
              ))}
            </div>
          </div>
        </li>
      ))}
      {t.laterRaces.length > 0 && (
        <>
          <li className="tl-gap small muted">之後的課表還沒排</li>
          {t.laterRaces.map((r) => (
            <li key={r.id} className="tl-day" data-date={r.date}>
              <div className="tl-row">
                <DateLabel label={monthDay(r.date)} weekday={weekdayOf(r.date)} race />
                <div className="tl-items">
                  <RaceItem race={r} today={today} />
                </div>
              </div>
            </li>
          ))}
        </>
      )}
    </ol>
  );
}

/** 這週今天以前的課：收成一行，點了展開 */
function Earlier({ t, extras, onChange }: { t: PlanTimeline; extras: string[]; onChange: SessionChange }) {
  const counts = new Map<string, number>();
  for (const s of t.earlier) {
    const label = statusOf(s)?.label;
    if (label) counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const summary = [...counts].map(([label, n]) => `${label} ${n}`).join(" · ");
  return (
    <details className="plan-earlier">
      <summary>
        {t.thisWeek ? "這週稍早" : `之前的課（${t.week.range}）`}
        {summary && <span className="muted"> · {summary}</span>}
      </summary>
      <div className="plan-earlier-list">
        {t.earlier.map((s) => (
          <div key={s.id ?? s.title} className="plan-earlier-item">
            <span className="tl-label muted">
              {monthDay(s.date!)}（{weekdayOf(s.date!)}）
            </span>
            <SessionItem s={s} focus={false} onChange={onChange} />
          </div>
        ))}
        {extras.length > 0 && <p className="small muted">課表外的跑步（排課前已跑或額外多跑的，算進這週的跑量）：{extras.join("；")}</p>}
        <p className="small muted">實際的紀錄同步後自動對照課表。跑了不一樣的課、沒跑的課都不是失敗；沒跑的跳過即可，不要補。</p>
      </div>
    </details>
  );
}

function Why({ current, next }: { current: ActivePlan; next: ActivePlan | null }) {
  const plan = current.plan;
  return (
    <div className="plan-why small" id="plan-why">
      {plan.reason && <p>{plan.reason}</p>}
      {current.coachNote && <p>{current.coachNote}</p>}
      {next?.plan.reason && (
        <p>
          下週：{next.plan.reason}
          {next.coachNote && ` ${next.coachNote}`}
        </p>
      )}
      {plan.outline && (
        <>
          <h3>之後幾週</h3>
          <Markdown>{plan.outline}</Markdown>
        </>
      )}
    </div>
  );
}

export function PlanView() {
  const { coach, revision, touch } = useApp();
  const [current, setCurrent] = useState<ActivePlan | null>(null);
  // 週日先排好的下週課表：接在這週的後面
  const [next, setNext] = useState<ActivePlan | null>(null);
  const [races, setRaces] = useState<Race[]>([]);
  const [changeNote, setChangeNote] = useState<string | null>(null);
  const [planDraft, setPlanDraft] = useState<string | null>(null);
  const [why, setWhy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = coach.today();

  const plan = current?.plan ?? null;
  const structured = current !== null && current.plan.week_start != null;
  const timeline = structured ? planTimeline(current, next, races, today) : null;
  const hasWhy = structured && !!(plan!.reason || current.coachNote || plan!.outline || next?.plan.reason);

  useEffect(() => {
    void coach.activePlan().then(setCurrent);
    void coach.nextPlan().then(setNext);
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

  const onChange: SessionChange = (s, action, date) =>
    void run(async () => {
      setChangeNote(await coach.changeSession(s.id!, action, { date, reason: "選手在計畫頁調整" }));
    });

  return (
    <>
      <section className="card plan-card">
        {timeline ? (
          <>
            <h2 className="sr-only">訓練計畫</h2>
            <div className="plan-top">
              <span className="plan-week">
                <strong>{timeline.thisWeek ? "這週" : timeline.week.range}</strong> {timeline.week.km} km · {timeline.week.runs} 次跑步
                {plan!.style === "flexible" && " · 彈性"}
              </span>
              {hasWhy && (
                <button type="button" className="link-button" aria-expanded={why} aria-controls="plan-why" onClick={() => setWhy(!why)}>
                  為什麼這樣排
                </button>
              )}
            </div>
            {timeline.thisWeek && <p className="small muted plan-range">{timeline.week.range}</p>}
            {why && <Why current={current!} next={next} />}
            {error && <div className="notice error">{error}</div>}
            {changeNote && <div className="notice ok small">{changeNote}</div>}
            {timeline.earlier.length > 0 && <Earlier t={timeline} extras={current!.extras} onChange={onChange} />}
            <Timeline t={timeline} today={today} onChange={onChange} />
          </>
        ) : (
          <>
            <div className="row between">
              <h2>訓練計畫</h2>
              {planDraft === null && <button onClick={() => setPlanDraft(plan?.content ?? "")}>{plan ? "編輯" : "手動填寫"}</button>}
            </div>
            {error && <div className="notice error">{error}</div>}
            {planDraft === null ? (
              plan ? (
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
          </>
        )}
      </section>

      <RacesCard />
    </>
  );
}
