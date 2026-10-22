import type { ReactNode } from "react";

import { addDays, type RunCard } from "@running-coach/core";

import { Markdown } from "../Markdown";

/** 今天、昨天；更早的顯示月-日 */
export function dayText(date: string, today: string): string {
  if (date === today) return "今天";
  if (date === addDays(today, -1)) return "昨天";
  return date.slice(5);
}

function minutesText(minutes: number | null): string {
  if (minutes == null) return "?";
  const m = Math.round(minutes);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}` : `${m}`;
}

const pct = (part: number, total: number) => Math.round((part / total) * 100);

/** 低、中、高強度的時間比例；compact 時只有橫條 */
export function IntensityBar({ intensity, compact = false }: { intensity: NonNullable<RunCard["intensity"]>; compact?: boolean }) {
  const total = intensity.low + intensity.moderate + intensity.high;
  if (total <= 0) return null;
  const label = `低強度 ${pct(intensity.low, total)}%、中強度 ${pct(intensity.moderate, total)}%、高強度 ${pct(intensity.high, total)}%`;
  return (
    <div className={compact ? "intensity compact" : "intensity"}>
      <div className="split-bar" role="img" aria-label={label}>
        <span className="low" style={{ flexGrow: intensity.low }} />
        <span className="moderate" style={{ flexGrow: intensity.moderate }} />
        <span className="high" style={{ flexGrow: intensity.high }} />
      </div>
      {!compact && (
        <p className="small muted legend">
          <span className="dot low" />低 {pct(intensity.low, total)}%<span className="dot moderate" />中 {pct(intensity.moderate, total)}%
          <span className="dot high" />高 {pct(intensity.high, total)}%
        </p>
      )}
    </div>
  );
}

/** 體感 1–10 的刻度：預期的範圍畫成底色，選手的體感是一個點 */
function EffortScale({ effort, expected, difficulty }: { effort: number | null; expected: [number, number] | null; difficulty: string | null }) {
  if (effort == null) return <p className="small muted">還沒填體感。</p>;
  const text =
    `體感 ${effort}/10` + (expected ? `，這種課預期 ${expected[0]}–${expected[1]}` : "") + (difficulty ? `（${difficulty}）` : "");
  return (
    <div className="effort">
      <div className="effort-scale" role="img" aria-label={text}>
        {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
          <span
            key={n}
            className={[expected && n >= expected[0] && n <= expected[1] ? "expected" : "", n === effort ? "mark" : ""].join(" ").trim()}
          />
        ))}
      </div>
      <p className="small muted">{text}</p>
    </div>
  );
}

/** 和課表比的結果；不在課表上時標示「課表外」 */
export function PlanBadge({ card }: { card: RunCard }) {
  if (card.plan) return <span className={`badge ${card.plan.outcome}`}>{card.plan.outcomeLabel}</span>;
  if (card.outsidePlan) return <span className="badge missed">課表外</span>;
  return null;
}

/** 一趟跑步：判斷、數字、強度、體感、分析摘要（第一句以外預設收起）；children 放動作 */
/** showDate：紀錄頁點開時，列上已經有日期、課與結果，卡片不再顯示 */
export function RunCardView({ card, today, showDate = true, children }: { card: RunCard; today: string; showDate?: boolean; children?: ReactNode }) {
  const w = card.workout;
  const extra = [
    w.avg_hr == null && w.max_hr == null ? "沒有心率資料" : null,
    w.max_hr != null ? `最高心率 ${w.max_hr}` : null,
    w.elevation_m ? `爬升 ${w.elevation_m} m` : null,
    w.training_load != null ? `負荷 ${w.training_load}` : null,
  ].filter(Boolean);
  return (
    <div className="run-card">
      {showDate && (
        <div className="run-card-head">
          <strong>{dayText(w.date, today)}</strong>
          {card.plan && (
            <span className="muted small">
              {card.plan.kindLabel}：{card.plan.title}
            </span>
          )}
          <PlanBadge card={card} />
        </div>
      )}
      {card.plan && card.plan.reasons.length > 0 && <p className="small">{card.plan.reasons.join("、")}</p>}
      <dl className="stats">
        <div>
          <dt>距離 km</dt>
          <dd>{w.distance_km ?? "?"}</dd>
        </div>
        <div>
          <dt>{(w.duration_min ?? 0) >= 60 ? "時間" : "時間 分"}</dt>
          <dd>{minutesText(w.duration_min)}</dd>
        </div>
        <div>
          <dt>配速 /km</dt>
          <dd>{w.avg_pace?.replace("/km", "") ?? "?"}</dd>
        </div>
        <div>
          <dt>心率</dt>
          <dd>{w.avg_hr ?? "—"}</dd>
        </div>
      </dl>
      {extra.length > 0 && <p className="small muted">{extra.join("・")}</p>}
      {card.intensity && <IntensityBar intensity={card.intensity} />}
      <EffortScale effort={w.perceived_effort} expected={card.expectedRpe} difficulty={card.plan?.difficultyLabel ?? null} />
      {w.subjective_notes && <p className="small">「{w.subjective_notes}」</p>}
      {(card.headline || card.details) && (
        <div className="run-summary">
          {card.headline && <Markdown>{card.headline}</Markdown>}
          {card.details && (
            <details>
              <summary>{card.headline ? "看完整分析" : "看教練的分析"}</summary>
              <Markdown>{card.details}</Markdown>
            </details>
          )}
        </div>
      )}
      {children}
    </div>
  );
}
