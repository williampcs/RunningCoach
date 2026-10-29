import { useEffect, useState } from "react";

import { monthDay, OUTCOME_LABELS, PAST_WEEKS_PAGE, weekdayName, type PastSession, type PastWeek } from "@running-coach/core";
import { Check, ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleMinus, type LucideIcon } from "lucide-react";

import { useApp } from "../app-context";
import { Disclosure, Icon, ICON_CHIP, SportIcon, SPORT_NAMES, type SportKey } from "../ui";

type Outcome = PastSession["outcome"];

/**
 * 每堂課的小圖示：和這週時間軸的結果標示同一套（做了是綠色的勾，其他是灰的，不用紅色，規格 12.34）.
 * 部分是虛線的圈、做了別的課或改用替代是有點的圈、跳過是一槓、沒做是空的圈
 */
const MARKS: Record<Outcome, LucideIcon> = {
  achieved: CircleCheck,
  partial: CircleDashed,
  different: CircleDot,
  fallback: CircleDot,
  skipped: CircleMinus,
  missed: Circle,
  rested: CircleCheck,
  not_rested: CircleDot,
};

/** 圖示的說明（點開「之前的週」時在最上面一行） */
const LEGEND: [Outcome, string][] = [
  ["achieved", "達成"],
  ["partial", "部分達成"],
  ["different", "換了別的課"],
  ["skipped", "跳過"],
  ["missed", "沒做"],
];

const weekdayOf = (date: string) => weekdayName(date).replace("星期", "");

/** 分鐘 → 「3 小時 20 分」「45 分鐘」（和這週的總量同一種寫法） */
const hoursText = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分鐘`);

function outcomeLabel(s: PastSession): string {
  // 不是跑步的課沒做寫「沒做」（和時間軸一樣）
  return s.outcome === "missed" && !s.isRun ? "沒做" : OUTCOME_LABELS[s.outcome];
}

function sportOf(s: PastSession): SportKey {
  if (s.kind === "strength") return "strength";
  if (s.sport === "ride" || s.sport === "swim" || s.sport === "other") return s.sport;
  return s.isRun ? "run" : "other";
}

/** 計畫與實際的總量：只有跑步的週寫距離，有其他運動時寫時間；文字課表只寫實際的 */
function totalText(w: PastWeek): string {
  const amount = (x: { km: number; minutes: number }) => (w.unit === "km" ? `${x.km} km` : hoursText(x.minutes));
  return w.planned ? `計畫 ${amount(w.planned)} · 實際 ${amount(w.actual)}` : `文字課表 · 實際 ${amount(w.actual)}`;
}

function Mark({ outcome }: { outcome: Outcome }) {
  return <Icon as={MARKS[outcome]} size={ICON_CHIP} className={`icon past-mark ${outcome}`} />;
}

/** 一週的小圖示：螢幕閱讀器讀「做了 3、沒做 1」 */
function Marks({ sessions }: { sessions: PastSession[] }) {
  const counts = new Map<string, number>();
  for (const s of sessions) counts.set(outcomeLabel(s), (counts.get(outcomeLabel(s)) ?? 0) + 1);
  const label = [...counts].map(([l, n]) => `${l} ${n}`).join("、");
  return (
    <span className="past-marks" role="img" aria-label={label || "沒有課"}>
      {sessions.map((s) => (
        <Mark key={s.id} outcome={s.outcome} />
      ))}
    </span>
  );
}

/** 點開一週：每堂課的標題、結果與實際；配到紀錄的那一堂點了到紀錄頁那一趟 */
function WeekSessions({ week }: { week: PastWeek }) {
  const { openHistory } = useApp();
  return (
    <ol className="rows past-sessions">
      {week.sessions.map((s) => {
        const sport = sportOf(s);
        const when = s.date ? `${monthDay(s.date)}（${weekdayOf(s.date)}）` : "這週任一天";
        const target = s.workoutId !== null ? { workoutId: s.workoutId } : s.activityId ? { activityId: s.activityId } : null;
        const body = (
          <>
            <span className="list-row-icon" title={SPORT_NAMES[sport]}>
              <SportIcon sport={sport} />
            </span>
            <span className="list-row-text">
              <span className="list-row-title">{s.title}</span>
              <span className="list-row-sub">{[when, s.actual].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="list-row-end">
              <span className={`badge ${s.outcome}`}>
                {s.outcome === "achieved" && <Icon as={Check} size={ICON_CHIP} />}
                {outcomeLabel(s)}
              </span>
              {target && <Icon as={ChevronRight} size={16} className="icon chev" />}
            </span>
          </>
        );
        return (
          <li key={s.id} data-outcome={s.outcome}>
            {target ? (
              <button type="button" className="list-row" onClick={() => openHistory({ ...target, date: s.date ?? week.weekStart })}>
                {body}
              </button>
            ) : (
              <div className="list-row">{body}</div>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 計畫頁最下面「之前的週」（規格 12.34）：預設收起；只列有課表的週，最近的在上面，先 8 週 */
export function PastWeeks() {
  const { coach, revision } = useApp();
  const [limit, setLimit] = useState(PAST_WEEKS_PAGE);
  const [data, setData] = useState<{ weeks: PastWeek[]; more: boolean } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let alive = true;
    void coach.pastPlanWeeks(limit).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [coach, revision, limit]);

  if (!data?.weeks.length) return null;
  const toggle = (weekStart: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(weekStart)) next.delete(weekStart);
      else next.add(weekStart);
      return next;
    });

  return (
    <section className="card past-weeks-card">
      <Disclosure className="past-weeks" summary="之前的週">
        <p className="past-legend small muted">
          {LEGEND.map(([o, label]) => (
            <span key={o}>
              <Mark outcome={o} />
              {label}
            </span>
          ))}
        </p>
        <ol className="rows past-weeks-list">
          {data.weeks.map((w) => {
            const expanded = open.has(w.weekStart);
            return (
              <li key={w.weekStart} className={`past-week${expanded ? " open" : ""}`} data-week={w.weekStart}>
                {w.text ? (
                  <div className="list-row">
                    <span className="list-row-text">
                      <span className="list-row-title">{w.range}</span>
                      <span className="list-row-sub">{totalText(w)}</span>
                    </span>
                  </div>
                ) : (
                  <button type="button" className="list-row past-week-row" aria-expanded={expanded} onClick={() => toggle(w.weekStart)}>
                    <span className="list-row-text">
                      <span className="list-row-title">{w.range}</span>
                      <span className="list-row-sub">{totalText(w)}</span>
                    </span>
                    <span className="list-row-end">
                      <Marks sessions={w.sessions} />
                      <Icon as={ChevronRight} size={16} className="icon chev" />
                    </span>
                  </button>
                )}
                {expanded && <WeekSessions week={w} />}
              </li>
            );
          })}
        </ol>
        {data.more && (
          <div className="actions">
            <button className="text" onClick={() => setLimit(limit + PAST_WEEKS_PAGE)}>
              再看更早的
            </button>
          </div>
        )}
      </Disclosure>
    </section>
  );
}
