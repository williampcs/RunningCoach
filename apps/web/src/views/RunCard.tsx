import type { ReactNode } from "react";

import { Check } from "lucide-react";

import { addDays, shortDateLabel, type RideAccumulation, type RideCard, type RunCard } from "@running-coach/core";

import { Markdown } from "../Markdown";
import { Disclosure, Icon, ICON_CHIP, SportIcon } from "../ui";

/** 今天、昨天；更早的顯示 10/27（二） */
export function dayText(date: string, today: string): string {
  if (date === today) return "今天";
  if (date === addDays(today, -1)) return "昨天";
  return shortDateLabel(date);
}

/** 距離到小數一位 */
export const kmText = (km: number | null | undefined) => (km == null ? "?" : String(Math.round(km * 10) / 10));

/** 時間：一小時以上 1:05，以下 45（單位另外寫） */
function minutesText(minutes: number | null): { value: string; unit: string } {
  if (minutes == null) return { value: "?", unit: "" };
  const m = Math.round(minutes);
  return m >= 60 ? { value: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}`, unit: "" } : { value: `${m}`, unit: "分" };
}

/** 數字格的一格：大數字＋單位，下面一行小標 */
function Stat({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {value}
        {unit && <small className="small muted"> {unit}</small>}
      </dd>
    </div>
  );
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
          <span>
            <span className="dot low" />低 {pct(intensity.low, total)}%
          </span>
          <span>
            <span className="dot moderate" />中 {pct(intensity.moderate, total)}%
          </span>
          <span>
            <span className="dot high" />高 {pct(intensity.high, total)}%
          </span>
        </p>
      )}
    </div>
  );
}

/** 體感 1–10 的刻度：預期的範圍畫成底色，選手的體感是一個點 */
function EffortScale({ effort, expected, difficulty }: { effort: number | null; expected: [number, number] | null; difficulty: string | null }) {
  if (effort == null) return <p className="small muted">還沒填體感。</p>;
  const text =
    `體感 ${effort}/10` + (expected ? ` · 這種課預期 ${expected[0]}–${expected[1]}` : "") + (difficulty ? ` · ${difficulty}` : "");
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
export function PlanBadge({ card }: { card: Pick<RunCard, "plan" | "outsidePlan"> }) {
  if (card.plan)
    return (
      <span className={`badge ${card.plan.outcome}`}>
        {card.plan.outcome === "achieved" && <Icon as={Check} size={ICON_CHIP} />}
        {card.plan.outcomeLabel}
      </span>
    );
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
        <Stat label="距離" value={kmText(w.distance_km)} unit="km" />
        <Stat label="時間" {...minutesText(w.duration_min)} />
        <Stat label="配速" value={w.avg_pace?.replace("/km", "") ?? "?"} unit="/km" />
        <Stat label="心率" value={w.avg_hr ?? "—"} />
      </dl>
      {extra.length > 0 && <p className="small muted">{extra.join("・")}</p>}
      {card.intensity && <IntensityBar intensity={card.intensity} />}
      <EffortScale effort={w.perceived_effort} expected={card.expectedRpe} difficulty={card.plan?.difficultyLabel ?? null} />
      {w.subjective_notes && <p className="small">「{w.subjective_notes}」</p>}
      {(card.headline || card.details) && (
        <div className="run-summary">
          {card.headline && <Markdown>{card.headline}</Markdown>}
          {card.details && (
            <Disclosure summary={card.headline ? "看完整分析" : "看教練的分析"}>
              <Markdown>{card.details}</Markdown>
            </Disclosure>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

/** 一趟騎車（多運動）：和跑步的卡片同樣的樣式，數字換成騎車用的（時間、距離、平均心率、負荷、有功率時的功率） */
export function RideCardView({ card, children }: { card: RideCard; children?: ReactNode }) {
  const a = card.activity;
  return (
    <div className="run-card ride-card">
      {card.plan && card.plan.reasons.length > 0 && <p className="small">{card.plan.reasons.join("、")}</p>}
      <dl className="stats">
        <Stat label="時間" {...minutesText(a.duration_min)} />
        <Stat label="距離" value={a.distance_km ? kmText(a.distance_km) : "—"} unit={a.distance_km ? "km" : undefined} />
        <Stat label="平均心率" value={a.avg_hr ?? "—"} />
        <Stat label={card.watts ? "功率" : "負荷"} value={card.watts ?? a.training_load ?? "—"} unit={card.watts ? "W" : undefined} />
      </dl>
      {card.watts && a.training_load != null && <p className="small muted">負荷 {a.training_load}</p>}
      {a.avg_hr == null && <p className="small muted">沒有心率資料</p>}
      {card.intensity && <IntensityBar intensity={card.intensity} />}
      <EffortScale effort={a.perceived_effort ?? null} expected={card.expectedRpe} difficulty={card.plan?.difficultyLabel ?? null} />
      {a.subjective_notes && <p className="small">「{a.subjective_notes}」</p>}
      {children}
    </div>
  );
}

/** 騎車的累積（多運動，簡單的一塊）：總次數、時間、距離、這週、最長的一趟 */
export function RideTotals({ totals }: { totals: RideAccumulation }) {
  const hours = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時 ${m % 60} 分` : `${m} 分鐘`);
  return (
    <section className="card ride-totals">
      <h2 className="row">
        <SportIcon sport="ride" />
        騎車的累積
      </h2>
      <dl className="stats">
        <Stat label="騎了" value={totals.rides} unit="次" />
        <Stat label="時間" value={Math.round(totals.minutes / 6) / 10} unit="小時" />
        <Stat label="距離" value={Math.round(totals.km)} unit="km" />
      </dl>
      <p className="small muted">
        {totals.thisWeek ? `這週 ${totals.thisWeek.rides} 次、${hours(totals.thisWeek.minutes)}` : "這週還沒騎"}
        {totals.longest && ` · 最長的一趟 ${hours(totals.longest.minutes)}，${shortDateLabel(totals.longest.date)}`}
        {totals.since && ` · 從 ${totals.since} 起`}
      </p>
    </section>
  );
}
