import { useEffect, useState, type MouseEvent } from "react";

import {
  addDays,
  DIFFICULTY_LABELS,
  distanceText,
  monthDay,
  activityLabel,
  isQualityKind,
  OUTCOME_LABELS,
  planTimeline,
  sportOfType,
  raceStatusText,
  STATUS_LABELS,
  weekdayName,
  type ActivePlan,
  type OtherActivity,
  type PlanTimeline,
  type Race,
  type SessionKind,
  type StepIntensity,
  type StepRow,
  type StructureSegment,
  type TimelineSession,
} from "@running-coach/core";

import { Activity, Check, Gauge, HeartPulse, Repeat, Route, Timer, Zap, type LucideIcon } from "lucide-react";

import { errorText, useApp } from "../app-context";
import { Disclosure, DisclosureButton, Icon, ICON_CHIP, SportIcon, SPORT_NAMES, type SportKey } from "../ui";
import { featureEnabled } from "../environment";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { Markdown } from "../Markdown";
import { RacesCard } from "./Races";

type SessionChange = (s: TimelineSession, action: "move" | "skip" | "fallback" | "restore" | "done" | "undone", date?: string) => void;

const weekdayOf = (date: string) => weekdayName(date).replace("星期", "");

/** 一堂課的強度：運動圖示的顏色（和紀錄頁的強度橫條同一套顏色）；不算強度的是灰 */
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
  ride_recovery: "low",
  ride_endurance: "low",
  ride_long: "low",
  ride_tempo: "moderate",
  ride_sweetspot: "moderate",
  ride_threshold: "moderate",
  ride_vo2: "high",
  ride_anaerobic: "high",
};

const INTENSITY_NAMES: Record<StepIntensity, string> = { low: "低強度", moderate: "中強度", high: "高強度", other: "" };
const PHASE_NAMES: Record<StructureSegment["phase"], string> = { warmup: "暖身", main: "主課", cooldown: "緩和" };

/** 運動種類用圖示分（規格 12.28）：跑步、騎車、肌力、游泳、其他 */
function sportOf(s: TimelineSession): SportKey {
  if (s.kind === "strength") return "strength";
  if (s.sport === "ride" || s.sport === "swim" || s.sport === "other") return s.sport;
  if (s.kind === "cross") return "other";
  return s.isRun ? "run" : "other";
}

/** 分鐘 → 「3 小時 20 分」「45 分鐘」 */
const hoursText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分鐘`);

/** 課表外的其他運動（多運動）：一行，例「課表外的騎車 60 分鐘・心率 128」 */
function OtherItem({ a }: { a: OtherActivity }) {
  const sport = sportOfType(a.type);
  const facts = [`${Math.round(a.duration_min ?? 0)} 分鐘`, a.avg_hr != null ? `心率 ${a.avg_hr}` : null, a.training_load != null ? `負荷 ${a.training_load}` : null];
  return (
    <div className="plan-other" data-sport={sport}>
      <SportIcon sport={sport === "ride" || sport === "swim" ? sport : "other"} />
      <span>
        課表外的{activityLabel(a.type)}
        <span className="muted small"> {facts.filter(Boolean).join("・")}</span>
      </span>
    </div>
  );
}

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

/** 狀態：達成打勾（綠），其他是灰（不用紅，課表是建議不是考核） */
function StatusBadge({ status }: { status: { label: string; cls: string } }) {
  return (
    <span className={`badge ${status.cls}`}>
      {status.cls === "achieved" && <Icon as={Check} size={ICON_CHIP} />}
      {status.label}
    </span>
  );
}

function Steps({ rows }: { rows: StepRow[] }) {
  const line = (x: { name: string; target: string; length: string; intensity: StepIntensity }, key: number) => (
    <li key={key} className="plan-step">
      <span className={`dot ${x.intensity}`} aria-hidden="true" />
      <span className="plan-step-name">
        {x.name}
        {x.target && <span className="muted"> {x.target}</span>}
      </span>
      <span className="plan-step-length">{x.length}</span>
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

/**
 * 整堂課的結構：一條強度條（長度是時間、顏色是強度），下面一行標暖身、主課、緩和.
 * 說明依序排、不照比例：很短的一段（例如緩和 10 分）照比例會被截掉，放不下時換行
 */
function Structure({ segments }: { segments: StructureSegment[] }) {
  if (!segments.length) return null;
  const phases: { phase: StructureSegment["phase"]; minutes: number }[] = [];
  for (const seg of segments) {
    const last = phases.at(-1);
    if (last?.phase === seg.phase) last.minutes += seg.minutes;
    else phases.push({ phase: seg.phase, minutes: seg.minutes });
  }
  const label = segments
    .map((seg) => INTENSITY_NAMES[seg.intensity])
    .filter((name, i, all) => name && name !== all[i - 1])
    .join("、");
  return (
    <div className="strip">
      <div className="split-bar" role="img" aria-label={`這堂課的強度：${label || "不分強度"}`}>
        {segments.map((seg, i) => (
          <span key={i} className={seg.intensity} style={{ flexGrow: seg.minutes }} />
        ))}
      </div>
      {phases.length > 1 && (
        <div className="strip-labels">
          {phases.map((p, i) => (
            <span key={i}>
              {PHASE_NAMES[p.phase]} {Math.round(p.minutes)} 分
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 標籤的圖示：時間、距離、心率、配速、體感、功率、重複 */
function chipIcon(text: string): LucideIcon | null {
  if (/×/.test(text)) return Repeat;
  if (/心率/.test(text)) return HeartPulse;
  if (/體感/.test(text)) return Activity;
  if (/功率|\bW\b/.test(text)) return Zap;
  if (/\/km/.test(text)) return Gauge;
  if (/km$/.test(text)) return Route;
  if (/(分鐘|秒|小時|分)$/.test(text)) return Timer;
  return null;
}

/** 標籤最多三個，不重複標題已經寫的；括號裡的說明留在「細節」 */
function chipsOf(s: TimelineSession): string[] {
  const words = s.title.replace(/\s+/g, "");
  return s.chips
    .filter((c) => !words.includes(c.replace(/\s+/g, "")))
    // 數字的括號（心率的範圍）留著；文字的說明（短間歇看體感…）收進「細節」
    .map((c) => c.replace(/（[^）]*[\u4e00-\u9fff，][^）]*）?$/u, "").replace(/(\d) 分鐘$/, "$1 分").trim())
    .filter(Boolean)
    .slice(0, 3);
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
      <div className="plan-rest">
        <SportIcon sport="rest" />
        {s.title === "休息" ? "休息" : s.title}
        {status && <StatusBadge status={status} />}
      </div>
    );
  }

  const expanded = open;
  const sport = sportOf(s);
  const intensity = KIND_INTENSITY[s.kind];
  // 點卡片的任何地方都展開或收合；卡片裡的按鈕、連結照原本的行為；選取文字時不觸發
  const onCardClick = (e: MouseEvent<HTMLElement>) => {
    if ((e.target as HTMLElement).closest("button, a, input, select, textarea, summary")) return;
    if (window.getSelection()?.toString()) return;
    setOpen(!open);
  };
  // 副標：和課名不同時的種類，加上收起時的時間或距離
  const sub = [s.kindHint, ...(expanded ? [] : s.brief)].filter(Boolean).join(" · ");
  const days = Array.from({ length: 7 }, (_, i) => addDays(s.weekStart, i));
  const hasDetails = !!(s.purpose || s.success || s.fallback || s.rows.length);
  const chips = chipsOf(s);
  const detailsId = `session-details-${s.id ?? s.title}`;

  return (
    <article className={`plan-session ${focus ? "focus" : ""} ${s.status}`} data-kind={s.kind} data-sport={sport} onClick={onCardClick}>
      <button type="button" className="plan-session-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`plan-sport-icon ${intensity}`} title={SPORT_NAMES[sport]}>
          <SportIcon sport={sport} />
          <span className="sr-only">{SPORT_NAMES[sport]}</span>
        </span>
        <span className="plan-session-title">
          <span className={focus ? "plan-session-name big" : "plan-session-name"}>{s.title}</span>
          {sub && <span className="plan-session-sub">{sub}</span>}
        </span>
        {status && <StatusBadge status={status} />}
      </button>
      {expanded && (
        <>
          {chips.length > 0 && (
            <div className="chips">
              {chips.map((c) => {
                const icon = chipIcon(c);
                return (
                  <span key={c} className="chip">
                    {icon && <Icon as={icon} size={ICON_CHIP} />}
                    {c}
                  </span>
                );
              })}
            </div>
          )}
          {s.structure.length > 0 && <Structure segments={s.structure} />}
          {r && (r.actual || r.reasons.length > 0) && (
            <p className="small session-result">
              {r.actual && `實際：${r.actual}`}
              {r.reasons.length > 0 && `${r.actual ? "。" : ""}${r.reasons.join("、")}`}
              {r.difficulty && `。${DIFFICULTY_LABELS[r.difficulty]}`}
            </p>
          )}
          {s.note && <p className="small muted">調整的原因：{s.note}</p>}
          {hasDetails && <DisclosureButton open={details} onToggle={() => setDetails(!details)} controls={detailsId} />}
          {details && (
            <div id={detailsId} className="stack small">
              {s.rows.length > 0 && <Steps rows={s.rows} />}
              {(s.purpose || s.success || s.fallback) && (
                <dl className="plan-details">
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
            </div>
          )}
          {s.id !== null && !done && (
            <div className="session-actions">
              {s.doneAt ? (
                featureEnabled("multisport") && (
                  <button className="text" onClick={() => onChange(s, "undone")}>
                    取消「做完了」
                  </button>
                )
              ) : s.status === "planned" ? (
                <>
                  {reportable && (
                    <button className="primary" onClick={() => onChange(s, "done")}>
                      做完了
                    </button>
                  )}
                  {s.fallback && isQualityKind(s.kind) && <button onClick={() => onChange(s, "fallback")}>改用替代</button>}
                  {s.fixed && <button onClick={() => setMoving(!moving)}>移到別天</button>}
                  <button className="text" onClick={() => onChange(s, "skip")}>
                    跳過
                  </button>
                </>
              ) : (
                <button onClick={() => onChange(s, "restore")}>恢復原本的課</button>
              )}
            </div>
          )}
          {moving && (
            <div className="session-actions move-days">
              {days
                .filter((d) => d !== s.date)
                .map((d) => (
                  <button
                    key={d}
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

/** 賽事卡：點了捲到下面的賽事區 */
function RaceItem({ race, today }: { race: Race; today: string }) {
  const sub = [
    featureEnabled("multisport") && race.sport === "ride" ? "騎車" : null,
    distanceText(race.distance_km * 1000),
    race.target_time ? `目標 ${race.target_time}` : null,
  ].filter(Boolean);
  return (
    <button type="button" className="plan-race" onClick={() => document.getElementById("races")?.scrollIntoView({ behavior: "smooth", block: "start" })}>
      <span className="plan-race-icon">
        <SportIcon sport="race" />
      </span>
      <span className="plan-race-text">
        <strong>{race.name}</strong>
        <span className="small muted">{sub.join(" · ")}</span>
      </span>
      <span className="plan-race-days">{raceStatusText(race, today)}</span>
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

/** 一週的總量：跑步的公里與次數；有單車的課時加上騎車的時間（多運動），只騎車時只寫騎車 */
function weekText(w: { km: number; runs: number; rides: number; rideMinutes: number }): string {
  const run = `${w.km} km · ${w.runs} 次跑步`;
  if (!w.rides) return run;
  const ride = `騎車 ${w.rides} 次 ${hoursText(w.rideMinutes)}`;
  return w.runs ? `${run} · ${ride}` : ride;
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
              下週 {d.nextWeek.range} · {weekText(d.nextWeek)}
            </div>
          )}
          <div className="tl-row">
            <DateLabel label={d.label} weekday={d.weekday} today={d.date === today} race={d.races.length > 0 && !d.sessions.length} />
            <div className="tl-items">
              {d.sessions.map(item)}
              {d.others.map((a) => (
                <OtherItem key={a.intervals_id} a={a} />
              ))}
              {!d.sessions.length && !d.races.length && !d.others.length && (
                <div className="plan-rest">
                  <SportIcon sport="rest" />
                  休息
                </div>
              )}
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
    <Disclosure
      className="plan-earlier"
      summary={
        <>
          {t.thisWeek ? "這週稍早" : `之前的課 ${t.week.range}`}
          {summary && <span className="muted"> · {summary}</span>}
        </>
      }
    >
      <div className="plan-earlier-list">
        {t.earlier.map((s) => (
          <div key={s.id ?? s.title} className="plan-earlier-item">
            <span className="tl-label muted">
              {monthDay(s.date!)}（{weekdayOf(s.date!)}）
            </span>
            <SessionItem s={s} focus={false} onChange={onChange} />
          </div>
        ))}
        {extras.length > 0 && <p className="small muted">課表外的跑步，算進這週的跑量：{extras.join("；")}</p>}
        {t.earlierOthers.map((a) => (
          <div key={a.intervals_id} className="plan-earlier-item">
            <span className="tl-label muted">
              {monthDay(a.date)}（{weekdayOf(a.date)}）
            </span>
            <OtherItem a={a} />
          </div>
        ))}
        <p className="small muted">跑了不一樣的課、沒跑的課都不是失敗；沒跑的跳過即可，不要補。</p>
      </div>
    </Disclosure>
  );
}

function Why({ current, next }: { current: ActivePlan; next: ActivePlan | null }) {
  const plan = current.plan;
  return (
    <div className="plan-why" id="plan-why">
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
  const timeline = structured ? planTimeline(current, next, races, today, { others: featureEnabled("multisport") }) : null;
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
                <span className="title">{timeline.thisWeek ? "這週" : timeline.week.range}</span>
                <span className="small muted">
                  {weekText(timeline.week)}
                  {plan!.style === "flexible" && " · 彈性"}
                  {timeline.thisWeek && ` · ${timeline.week.range}`}
                </span>
              </span>
              {hasWhy && (
                <DisclosureButton open={why} onToggle={() => setWhy(!why)} controls="plan-why">
                  為什麼這樣排
                </DisclosureButton>
              )}
            </div>
            {why && <Why current={current!} next={next} />}
            {error && <div className="notice error">{error}</div>}
            {changeNote && <div className="notice ok">{changeNote}</div>}
            {timeline.earlier.length > 0 && <Earlier t={timeline} extras={current!.extras} onChange={onChange} />}
            <Timeline t={timeline} today={today} onChange={onChange} />
          </>
        ) : (
          <>
            <div className="card-head">
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
                <div className="actions">
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
                  <button className="text" onClick={() => setPlanDraft(null)}>取消</button>
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
