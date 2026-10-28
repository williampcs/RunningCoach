import { useEffect, useState } from "react";

import { checkRedFlags } from "../red-flag-alert";
import type { Accumulation, RideAccumulation, RideCard, RunCard, WeekVolume, Workout } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { AutoGrowTextarea } from "../AutoGrowTextarea";
import { featureEnabled } from "../environment";
import { analysisRequest } from "./Report";
import { AccumulationView } from "./Accumulation";
import { FirstSync } from "./FirstSync";
import { SyncNotice } from "./PhoneGuide";
import { useSync } from "../use-sync";
import { dayText, IntensityBar, kmText, PlanBadge, RideCardView, RideTotals, RunCardView } from "./RunCard";
import { EffortPicker, SportIcon } from "../ui";
import { WeeklyVolumeCard } from "./WeeklyVolume";

const HISTORY_DAYS = 30;
/** 騎車的週趨勢看幾週（規格 12.31：8–12 週） */
const WEEKLY_WEEKS = 10;

/** 紀錄頁（規格 12.9）：每一趟一列，點開看卡片；補填或修改體感 */
export function HistoryView() {
  const { coach, revision, touch, goTo, activitiesReady } = useApp();
  const sync = useSync();
  const today = coach.today();
  const [cards, setCards] = useState<RunCard[] | null>(null);
  const [totals, setTotals] = useState<Accumulation | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // 補填已存檔紀錄的體感：一次只開一筆的表單
  const [editing, setEditing] = useState<{ id: number; effort: number; notes: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [backfilled, setBackfilled] = useState<{ workout: Workout; summary: string | null } | null>(null);
  // 多運動：騎車也列出來（規格 12.24 的第 3 階段）
  const multisport = featureEnabled("multisport");
  const [rides, setRides] = useState<RideCard[]>([]);
  const [rideTotals, setRideTotals] = useState<RideAccumulation | null>(null);
  const [weeks, setWeeks] = useState<WeekVolume[] | null>(null);
  const [openRides, setOpenRides] = useState<Set<string>>(new Set());
  const [rideEditing, setRideEditing] = useState<{ id: string; effort: number; notes: string } | null>(null);
  // 正在產生分析的騎車（規格 12.31）
  const [analyzing, setAnalyzing] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void coach.runCards(HISTORY_DAYS).then((c) => alive && setCards(c));
    void coach.accumulation().then((a) => alive && setTotals(a));
    if (multisport) {
      void coach.rideCards(HISTORY_DAYS).then((c) => alive && setRides(c));
      void coach.rideAccumulation().then((a) => alive && setRideTotals(a));
      void coach.weeklyVolume(WEEKLY_WEEKS).then((w) => alive && setWeeks(w));
    }
    return () => {
      alive = false;
    };
  }, [coach, revision, multisport]);

  async function saveRideFeedback() {
    if (!rideEditing) return;
    setSaving(true);
    setMessage(null);
    try {
      // 騎車：存了體感就重新產生分析（和跑步的「儲存並重新分析」一樣）
      const report = await coach.reportRun(rideEditing.effort, rideEditing.notes, { kind: "other", intervalsId: rideEditing.id });
      checkRedFlags(rideEditing.notes);
      if (report.status === "other" && report.summary === null && multisport) setMessage({ kind: "error", text: "體感已存檔；這次沒有產生分析，可以稍後按「請教練分析」再試。" });
      setRideEditing(null);
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  async function analyzeRide(id: string) {
    setAnalyzing(id);
    setMessage(null);
    try {
      await coach.analyzeRide(id);
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: `分析失敗：${errorText(e)}` });
    } finally {
      setAnalyzing(null);
    }
  }

  function rideRow(card: RideCard) {
    const a = card.activity;
    const expanded = openRides.has(a.intervals_id) || rideEditing?.id === a.intervals_id;
    const toggleRide = () =>
      setOpenRides((current) => {
        const next = new Set(current);
        if (next.has(a.intervals_id)) next.delete(a.intervals_id);
        else next.add(a.intervals_id);
        return next;
      });
    return (
      <li key={`ride-${a.intervals_id}`} className={`ride${expanded ? " open" : ""}`} data-sport="ride">
        <button className="run-row" aria-expanded={expanded} onClick={toggleRide}>
          <span className="list-row-icon">
            <SportIcon sport="ride" />
          </span>
          <span className="run-main">
            {expanded ? (
              <strong>{card.plan ? (card.plan.title.includes(card.plan.kindLabel) ? card.plan.title : `${card.plan.kindLabel}：${card.plan.title}`) : "騎車"}</strong>
            ) : (
              <strong>{Math.round(a.duration_min ?? 0)} 分鐘</strong>
            )}
            <span className="muted small run-date">
              {[dayText(a.date, today), !expanded && a.distance_km ? `${kmText(a.distance_km)} km` : null].filter(Boolean).join(" · ")}
            </span>
          </span>
          <span className="run-tags">
            <PlanBadge card={card} />
            {a.perceived_effort == null && <span className="badge">未填體感</span>}
          </span>
          {card.intensity && !expanded && <IntensityBar intensity={card.intensity} compact />}
        </button>
        {expanded && (
          <RideCardView card={card}>
            {rideEditing?.id === a.intervals_id ? (
              <div className="backfill">
                <h3>
                  體感 <span className="muted">{rideEditing.effort}/10</span>
                </h3>
                <EffortPicker value={rideEditing.effort} onChange={(effort) => setRideEditing({ ...rideEditing, effort })} />
                <label>
                  一句話的感受
                  <AutoGrowTextarea value={rideEditing.notes} placeholder="例如：爬坡腿很酸，最後一組撐不住" onChange={(e) => setRideEditing({ ...rideEditing, notes: e.target.value })} />
                </label>
                <div className="actions">
                  <button className="primary" disabled={saving} onClick={() => void saveRideFeedback()}>
                    {saving ? "儲存並分析中…" : "儲存並重新分析"}
                  </button>
                  <button className="text" disabled={saving} onClick={() => setRideEditing(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : (
              <div className="actions">
                <button
                  className={a.perceived_effort == null ? "primary" : ""}
                  disabled={rideEditing !== null || editing !== null}
                  onClick={() => setRideEditing({ id: a.intervals_id, effort: a.perceived_effort ?? 5, notes: a.subjective_notes ?? "" })}
                >
                  {a.perceived_effort != null ? "修改體感" : "補填體感"}
                </button>
                {/* 還沒有分析的騎車：請教練分析（用跑後摘要的模型，結果存在這張卡上） */}
                {!a.summary && (
                  <button disabled={analyzing !== null || rideEditing !== null} onClick={() => void analyzeRide(a.intervals_id)}>
                    {analyzing === a.intervals_id ? "分析中…" : "請教練分析"}
                  </button>
                )}
              </div>
            )}
          </RideCardView>
        )}
      </li>
    );
  }

  const toggle = (id: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  async function saveBackfill() {
    if (!editing) return;
    setSaving(true);
    setMessage(null);
    try {
      setBackfilled(await coach.addSubjective(editing.id, editing.effort, editing.notes));
      checkRedFlags(editing.notes);
      setEditing(null);
      touch();
    } catch (e) {
      setMessage({ kind: "error", text: errorText(e) });
    } finally {
      setSaving(false);
    }
  }

  function actions(w: Workout) {
    if (editing?.id === w.id) {
      return (
        <div className="backfill">
          <h3>
            體感 <span className="muted">{editing.effort}/10</span>
          </h3>
          <EffortPicker value={editing.effort} onChange={(effort) => setEditing({ ...editing, effort })} />
          <label>
            一句話的感受
            <AutoGrowTextarea
              value={editing.notes}
              placeholder="例如：最後兩公里很喘，腿還好"
              onChange={(e) => setEditing({ ...editing, notes: e.target.value })}
            />
          </label>
          <div className="actions">
            <button className="primary" disabled={saving} onClick={() => void saveBackfill()}>
              {saving ? "儲存並分析中…" : "儲存並重新分析"}
            </button>
            <button className="text" disabled={saving} onClick={() => setEditing(null)}>
              取消
            </button>
          </div>
        </div>
      );
    }
    return (
      <>
        <div className="actions">
          <button
            className={backfilled?.workout.id === w.id ? "" : w.perceived_effort == null ? "primary" : ""}
            disabled={editing !== null}
            onClick={() => {
              setEditing({ id: w.id, effort: w.perceived_effort ?? 5, notes: w.subjective_notes ?? "" });
              setBackfilled(null);
            }}
          >
            {w.perceived_effort != null ? "修改體感" : "補填體感"}
          </button>
          {(w.duplicate_count ?? 0) > 0 && (
            <>
              <span className="muted small">已合併 {w.duplicate_count} 筆重複的紀錄</span>
              <button
                className="text"
                onClick={() =>
                  void coach.splitDuplicates(w.id).then(() => {
                    setMessage({ kind: "ok", text: `已拆開 ${w.date} 的紀錄，之後會分開計算。` });
                    touch();
                  })
                }
              >
                不是同一趟
              </button>
            </>
          )}
          {backfilled?.workout.id === w.id && (
            <button
              className="primary"
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
        {backfilled?.workout.id === w.id && !backfilled.summary && <p className="muted small">體感已存檔；這次沒有重新產生分析。</p>}
      </>
    );
  }

  return (
    <>
      {totals && totals.runs > 0 && <AccumulationView totals={totals} today={today} onImported={touch} />}
      {multisport && rideTotals && rideTotals.rides > 0 && <RideTotals totals={rideTotals} />}
      {multisport && rideTotals && rideTotals.rides > 0 && weeks && <WeeklyVolumeCard weeks={weeks} />}
      <section className="card">
        <h2>
          最近 {HISTORY_DAYS} 天的{multisport && rides.length ? (cards?.length ? "跑步與騎車" : "騎車") : "跑步"}
        </h2>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        {cards === null && <p className="muted small">讀取中…</p>}
        {cards?.length === 0 &&
          !rides.length &&
          (totals?.runs === 0 ? (
            <>
              <p className="muted">還沒有跑步紀錄。</p>
              {!activitiesReady && <p className="muted small">先到「設定」填好 Intervals.icu 才能抓紀錄。</p>}
              <FirstSync sync={sync} disabled={!activitiesReady} />
            </>
          ) : (
            <p className="muted">最近 {HISTORY_DAYS} 天沒有跑步。</p>
          ))}
        {sync.message && totals !== null && totals.runs > 0 && <SyncNotice message={sync.message} />}
        <ul className="runs">
          {cards?.map((card, index) => {
            const w = card.workout;
            const expanded = open.has(w.id) || editing?.id === w.id;
            // 騎車依日期插在跑步之間（新的在前）
            const newer = index === 0 ? "9999" : cards[index - 1]!.workout.date;
            const before = rides.filter((r) => r.activity.date > w.date && r.activity.date <= newer);
            return [
              ...before.map(rideRow),
              <li key={w.id} className={expanded ? "open" : ""}>
                <button className="run-row" aria-expanded={expanded} onClick={() => toggle(w.id)}>
                  <span className="list-row-icon">
                    <SportIcon sport="run" />
                  </span>
                  {/* 點開時數字與橫條在卡片上，列上只留課與標記 */}
                  <span className="run-main">
                    {expanded ? <strong>{card.plan ? `${card.plan.kindLabel}：${card.plan.title}` : "跑步"}</strong> : <strong>{kmText(w.distance_km)} km</strong>}
                    <span className="muted small run-date">{[dayText(w.date, today), !expanded ? w.avg_pace : null].filter(Boolean).join(" · ")}</span>
                  </span>
                  <span className="run-tags">
                    <PlanBadge card={card} />
                    {w.perceived_effort == null && <span className="badge">未填體感</span>}
                    {(w.duplicate_count ?? 0) > 0 && <span className="badge missed">已合併</span>}
                  </span>
                  {card.intensity && !expanded && <IntensityBar intensity={card.intensity} compact />}
                </button>
                {expanded && (
                  <RunCardView card={card} today={today} showDate={false}>
                    {actions(w)}
                  </RunCardView>
                )}
              </li>,
            ];
          })}
          {/* 比最舊的跑步還早的騎車（或沒有跑步時的全部） */}
          {rides.filter((r) => !cards?.length || r.activity.date <= cards.at(-1)!.workout.date).map(rideRow)}
        </ul>
      </section>
    </>
  );
}
