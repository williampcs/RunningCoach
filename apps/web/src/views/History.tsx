import { useEffect, useState } from "react";

import type { Accumulation, RunCard, Workout } from "@running-coach/core";

import { errorText, useApp } from "../app-context";
import { analysisRequest } from "./Report";
import { AccumulationView } from "./Accumulation";
import { dayText, IntensityBar, PlanBadge, RunCardView } from "./RunCard";

const HISTORY_DAYS = 30;

/** 紀錄頁（規格 12.9）：每一趟一列，點開看卡片；補填或修改體感 */
export function HistoryView() {
  const { coach, revision, touch, goTo } = useApp();
  const today = coach.today();
  const [cards, setCards] = useState<RunCard[] | null>(null);
  const [totals, setTotals] = useState<Accumulation | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  // 補填已存檔紀錄的體感：一次只開一筆的表單
  const [editing, setEditing] = useState<{ id: number; effort: number; notes: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [backfilled, setBackfilled] = useState<{ workout: Workout; summary: string | null } | null>(null);

  useEffect(() => {
    let alive = true;
    void coach.runCards(HISTORY_DAYS).then((c) => alive && setCards(c));
    void coach.accumulation().then((a) => alive && setTotals(a));
    return () => {
      alive = false;
    };
  }, [coach, revision]);

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
      );
    }
    return (
      <>
        <div className="row">
          <button
            className="small"
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
                className="link small"
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
        {backfilled?.workout.id === w.id && !backfilled.summary && <p className="muted small">體感已存檔；這次沒有重新產生分析。</p>}
      </>
    );
  }

  return (
    <>
      {totals && totals.runs > 0 && <AccumulationView totals={totals} today={today} />}
      <section className="card">
        <h2>最近 {HISTORY_DAYS} 天的跑步</h2>
        <p className="muted small">點一趟看數據、強度與教練的分析；也可以在這裡補填或修改體感。</p>
        {message && <div className={`notice ${message.kind}`}>{message.text}</div>}
        {cards === null && <p className="muted small">讀取中…</p>}
        {cards?.length === 0 && <p className="muted">還沒有跑步紀錄。同步後會出現在這裡。</p>}
        <ul className="runs">
          {cards?.map((card) => {
            const w = card.workout;
            const expanded = open.has(w.id) || editing?.id === w.id;
            return (
              <li key={w.id} className={expanded ? "open" : ""}>
                <button className="run-row" aria-expanded={expanded} onClick={() => toggle(w.id)}>
                  <span className="run-date">{dayText(w.date, today)}</span>
                  {/* 點開時數字與橫條在卡片上，列上只留課與標記 */}
                  <span className="run-main">
                    {expanded ? (
                      <strong>{card.plan ? `${card.plan.kindLabel}：${card.plan.title}` : "跑步"}</strong>
                    ) : (
                      <>
                        <strong>{w.distance_km ?? "?"} km</strong>
                        <span className="muted small">{w.avg_pace ?? ""}</span>
                      </>
                    )}
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
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}
