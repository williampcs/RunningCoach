import { useEffect, useState } from "react";

import { dataSourceLine, mergeDataSources, monthDay, OUTCOME_LABELS, PAST_WEEKS_PAGE, ratioText, weekdayName, type PastSession, type PastWeek } from "@running-coach/core";
import { Check, ChevronRight, Circle, CircleCheck, CircleDashed, CircleDot, CircleMinus, type LucideIcon } from "lucide-react";

import { useApp } from "../app-context";
import { featureEnabled } from "../environment";
import { SessionReportForm } from "./SessionReport";
import { DataSource, Disclosure, Icon, ICON_CHIP, SportIcon, SPORT_NAMES, type SportKey } from "../ui";

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

/** 自己改過的課（規格 12.34 第 3 點 B）：「自己改短到約 3/4」「自己換成輕鬆」 */
const selfText = (s: PastSession) =>
  s.selfChange ? (s.selfChange.action === "shorten" ? `自己改短到${ratioText(s.selfChange.ratio)}` : "自己換成輕鬆") : null;

function sportOf(s: PastSession): SportKey {
  if (s.kind === "strength") return "strength";
  if (s.sport === "ride" || s.sport === "swim" || s.sport === "other") return s.sport;
  return s.isRun ? "run" : "other";
}

/** 這台沒抓過那段時間的紀錄（規格 12.34）：不寫實際與沒做 */
const UNCOVERED = "這台沒有這段時間的紀錄";

/** 計畫與實際的總量：只有跑步的週寫距離，有其他運動時寫時間；文字課表只寫實際的 */
function totalText(w: PastWeek): string {
  const amount = (x: { km: number; minutes: number }) => (w.unit === "km" ? `${x.km} km` : hoursText(x.minutes));
  const actual = w.uncovered ? UNCOVERED : `實際 ${amount(w.actual)}`;
  return w.planned ? `計畫 ${amount(w.planned)} · ${actual}` : `文字課表 · ${actual}`;
}

function Mark({ outcome }: { outcome: Outcome }) {
  return <Icon as={MARKS[outcome]} size={ICON_CHIP} className={`icon past-mark ${outcome}`} />;
}

/** 一週的小圖示：螢幕閱讀器讀「做了 3、沒做 1」 */
function Marks({ sessions, uncovered }: { sessions: PastSession[]; uncovered: boolean }) {
  const counts = new Map<string, number>();
  const labelOf = (s: PastSession) => (uncovered && s.outcome === "missed" ? "沒有紀錄" : outcomeLabel(s));
  for (const s of sessions) counts.set(labelOf(s), (counts.get(labelOf(s)) ?? 0) + 1);
  const label = [...counts].map(([l, n]) => `${l} ${n}`).join("、");
  return (
    <span className="past-marks" role="img" aria-label={label || "沒有課"}>
      {sessions.map((s) => (
        <Mark key={s.id} outcome={s.outcome} />
      ))}
    </span>
  );
}

/**
 * 點開一週：每堂課的標題、結果與實際；配到手錶紀錄的那一堂點了到紀錄頁那一趟.
 * 沒有手錶紀錄的課（功能開關 report，規格 12.48）：點了在那一列下面打開回報的表單（還沒回報的回報、回報過的修改），不繞到紀錄頁
 */
function WeekSessions({ week }: { week: PastWeek }) {
  // 這台沒有那段時間的紀錄：沒配到的課不寫「沒做」（可能是有做、這台沒抓到）
  const label = (s: PastSession) => (week.uncovered && s.outcome === "missed" ? "沒有紀錄" : outcomeLabel(s));
  const { openHistory } = useApp();
  const [reporting, setReporting] = useState<number | null>(null);
  const reportOn = featureEnabled("report");
  return (
    <ol className="rows past-sessions">
      {week.sessions.map((s) => {
        const sport = sportOf(s);
        const when = s.date ? `${monthDay(s.date)}（${weekdayOf(s.date)}）` : "這週任一天";
        const report = reportOn ? s.report : null;
        const target = report ? null : s.workoutId !== null ? { workoutId: s.workoutId } : s.activityId ? { activityId: s.activityId } : null;
        const open = report !== null && reporting === s.id;
        const body = (
          <>
            <span className="list-row-icon" title={SPORT_NAMES[sport]}>
              <SportIcon sport={sport} />
            </span>
            <span className="list-row-text">
              <span className="list-row-title">{s.title}</span>
              <span className="list-row-sub">{[when, selfText(s), s.actual, s.garmin].filter(Boolean).join(" · ")}</span>
            </span>
            <span className="list-row-end">
              <span className={`badge ${s.outcome}`}>
                {s.outcome === "achieved" && <Icon as={Check} size={ICON_CHIP} />}
                {label(s)}
              </span>
              {report && <span className="small muted past-report-label">{report.reported ? "修改回報" : "回報"}</span>}
              {(target || report) && <Icon as={ChevronRight} size={16} className="icon chev" />}
            </span>
          </>
        );
        return (
          <li key={s.id} data-outcome={s.outcome} data-session={s.id}>
            {report ? (
              <button type="button" className="list-row past-report-row" aria-expanded={open} onClick={() => setReporting(open ? null : s.id)}>
                {body}
              </button>
            ) : target ? (
              <button type="button" className="list-row" onClick={() => openHistory({ ...target, date: s.date ?? week.weekStart })}>
                {body}
              </button>
            ) : (
              <div className="list-row">{body}</div>
            )}
            {open && (
              <SessionReportForm
                session={{ id: s.id, title: s.title, sport: report.sport, minutes: report.minutes, km: report.km }}
                onDone={() => setReporting(null)}
                onCancel={() => setReporting(null)}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/** 計畫頁最下面「之前的週」（規格 12.34）：預設收起；只列有課表的週，最近的在上面，先 8 週 */
export function PastWeeks() {
  const { coach, revision, touch, activitiesReady } = useApp();
  const [limit, setLimit] = useState(PAST_WEEKS_PAGE);
  const [data, setData] = useState<{ weeks: PastWeek[]; more: boolean } | null>(null);
  const [open, setOpen] = useState<Set<string>>(new Set());
  // 「之前的週」打開了（收起時不補抓）
  const [shown, setShown] = useState(false);
  const [backfill, setBackfill] = useState<"idle" | "busy" | "failed">("idle");

  useEffect(() => {
    let alive = true;
    void coach.pastPlanWeeks(limit, { checkCoverage: activitiesReady }).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [coach, revision, limit, activitiesReady]);

  // 打開「之前的週」時，這台沒有紀錄的週從 Intervals.icu 補抓一次（只存紀錄、不產生分析；同一段這次打開 App 只試一次）
  useEffect(() => {
    if (!shown || !activitiesReady || !data?.weeks.some((w) => w.uncovered)) return;
    let alive = true;
    // 試過失敗的那段這次不再試（backfillPastWeeks 回 null）：失敗的說明留著
    const keepFailed = (next: "idle" | "busy") => setBackfill((current) => (current === "failed" ? current : next));
    keepFailed("busy");
    coach
      .backfillPastWeeks(data.weeks)
      .then((result) => {
        if (!alive) return;
        if (result) {
          setBackfill("idle");
          touch();
        } else keepFailed("idle");
      })
      .catch(() => alive && setBackfill("failed"));
    return () => {
      alive = false;
    };
  }, [coach, data, shown, activitiesReady, touch]);

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
      <Disclosure className="past-weeks" summary="之前的週" onToggle={(o) => o && setShown(true)}>
        {/* 每週的實際總量用到 Garmin 的資料時（KI-048） */}
        <DataSource text={dataSourceLine(mergeDataSources(data.weeks.map((w) => w.sources)))} />
        {backfill === "busy" && <p className="small muted past-backfill">正在從 Intervals.icu 補抓這台沒有的紀錄…</p>}
        {backfill === "failed" && <p className="small muted past-backfill">補抓不到這台沒有的紀錄，下次打開 App 再試；這段時間的課先不算沒做。</p>}
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
                      <Marks sessions={w.sessions} uncovered={w.uncovered} />
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
