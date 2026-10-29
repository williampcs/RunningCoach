import {
  computeTrainingValues,
  distanceText,
  durationText,
  formatPace,
  HR_SOURCE_LABELS,
  predictSecs,
  type TrainingValues,
} from "@running-coach/core";
import { useEffect, useState } from "react";

import { useApp } from "../app-context";
import { InfoTip } from "../ui";

const PREDICTIONS: [number, string][] = [
  [5000, "5 km"],
  [10_000, "10 km"],
  [21_097.5, "半馬"],
  [42_195, "全馬"],
];

const VDOT_KIND: Record<NonNullable<TrainingValues["vdot"]>["kind"], string> = {
  race: "比賽成績",
  race_effort: "Intervals.icu 標為比賽",
  best_effort: "訓練中的最佳表現，可能低估",
  profile: "你填的個人最佳，可能不是現在的體能",
};

const pace = (secs: number) => formatPace(secs).replace("/km", "");
const pct = (part: number, total: number) => Math.round((part / total) * 100);

/** 沒有心率時的強度分配：依體感（1–4 輕鬆、5–6 中等、7 以上高強度），以次數計 */
export function EffortSplit({ efforts: e }: { efforts: TrainingValues["efforts"] }) {
  return (
    <>
      <div
        className="split-bar"
        role="img"
        aria-label={`依體感：輕鬆 ${pct(e.low, e.rated)}%、中等 ${pct(e.moderate, e.rated)}%、高強度 ${pct(e.high, e.rated)}%`}
      >
        <span className="low" style={{ flexGrow: e.low }} />
        <span className="moderate" style={{ flexGrow: e.moderate }} />
        <span className="high" style={{ flexGrow: e.high }} />
      </div>
      <p className="small legend">
        <span>
          <span className="dot low" />輕鬆 {pct(e.low, e.rated)}%
        </span>
        <span>
          <span className="dot moderate" />中 {pct(e.moderate, e.rated)}%
        </span>
        <span>
          <span className="dot high" />高 {pct(e.high, e.rated)}%
        </span>
        <span className="muted">依體感，{e.rated} 次</span>
      </p>
    </>
  );
}

/** 教練排課表用的數字與來源：和 get_training_values 給教練的是同一份 */
export function TrainingValuesCard() {
  const { coach, revision } = useApp();
  const [values, setValues] = useState<TrainingValues | null>(null);

  useEffect(() => {
    void computeTrainingValues(coach.db, coach.db.today()).then(setValues);
  }, [coach, revision]);

  if (!values) return null;
  const { hr, vdot, paces, distribution: d, coverage, fitness } = values;
  const total = d.lowSecs + d.moderateSecs + d.highSecs;

  return (
    <section className="card training-values">
      <div className="card-head">
        <h2>訓練數值</h2>
        <InfoTip label="訓練數值的說明">由程式依你的資料計算，教練排課表時用這些數字；同步後更新。</InfoTip>
      </div>

      <h3>心率</h3>
      {hr ? (
        <>
          <p className="small muted">來源：{HR_SOURCE_LABELS[hr.source]}</p>
          {coverage.runs > 0 && coverage.withHr === 0 && (
            <p className="small muted">最近的跑步都沒有心率，這些區間暫時用不到，強度以配速與體感為主。</p>
          )}
          <dl className="values">
            {hr.lthr ? (
              <>
                <dt>閾值心率</dt>
                <dd>{hr.lthr} bpm</dd>
              </>
            ) : null}
            {hr.maxHr ? (
              <>
                <dt>最大心率</dt>
                <dd>{hr.maxHr} bpm</dd>
              </>
            ) : null}
            <dt>輕鬆跑上限</dt>
            <dd>{hr.easyMax} bpm</dd>
            <dt>區間</dt>
            <dd className="chips">
              {hr.zones.map((z) => (
                <span key={z.name}>
                  {z.name} {z.min === null ? `≤${z.max}` : `${z.min}–${z.max}`}
                </span>
              ))}
            </dd>
          </dl>
        </>
      ) : (
        <p className="small muted">
          {values.noHr ? `量不到心率（${values.noHr.replace(/^選手/, "你")}）；強度看體感與配速，輕鬆的強度是能說完整的句子。` : "沒有閾值心率，也沒有最大心率或出生年；強度以配速與體感為主。"}
        </p>
      )}

      <h3>配速（Daniels）</h3>
      {vdot && paces ? (
        <>
          <p className="small muted">
            VDOT {vdot.value.toFixed(1)}，依據：{distanceText(vdot.distanceM)} {durationText(vdot.secs)}
            {vdot.date ? `（${vdot.date}）` : ""}，{VDOT_KIND[vdot.kind]}
          </p>
          {values.adjustment && (
            <p className="small">
              依最近的結果放慢：課表用 VDOT {(vdot.value - values.adjustment.penalty).toFixed(1)}（{values.adjustment.reason}）。之後的強度課達成且不覺得難，就逐步回升。
            </p>
          )}
          <dl className="values">
            <dt>E 輕鬆、長跑</dt>
            <dd>
              {pace(paces.easy[0])}–{pace(paces.easy[1])}/km
            </dd>
            <dt>M 馬拉松</dt>
            <dd>{pace(paces.marathon)}/km</dd>
            <dt>T 閾值</dt>
            <dd>{pace(paces.threshold)}/km</dd>
            <dt>I 間歇</dt>
            <dd>{pace(paces.interval)}/km</dd>
            <dt>R 反覆</dt>
            <dd>{pace(paces.repetition)}/km</dd>
            <dt>推算完賽</dt>
            <dd className="chips">
              {PREDICTIONS.map(([m, label]) => (
                <span key={label}>
                  {label} {durationText(predictSecs(vdot.value, m))}
                </span>
              ))}
            </dd>
          </dl>
        </>
      ) : (
        <p className="small muted">最近 90 天沒有可以推算的比賽成績或最佳表現。回報最近的比賽成績、在選手資料填 5 km 或 10 km 的個人最佳，或做一次 5 km 計時跑，就能算出配速。</p>
      )}

      <h3>最近 28 天的強度分配</h3>
      {total > 0 ? (
        <>
          <div
            className="split-bar"
            role="img"
            aria-label={`低強度 ${pct(d.lowSecs, total)}%、中強度 ${pct(d.moderateSecs, total)}%、高強度 ${pct(d.highSecs, total)}%`}
          >
            <span className="low" style={{ flexGrow: d.lowSecs }} />
            <span className="moderate" style={{ flexGrow: d.moderateSecs }} />
            <span className="high" style={{ flexGrow: d.highSecs }} />
          </div>
          <p className="small legend">
            <span>
              <span className="dot low" />低 {pct(d.lowSecs, total)}%
            </span>
            <span>
              <span className="dot moderate" />中 {pct(d.moderateSecs, total)}%
            </span>
            <span>
              <span className="dot high" />高 {pct(d.highSecs, total)}%
            </span>
            <span className="muted">目標：低強度約 80%</span>
          </p>
        </>
      ) : values.efforts.rated >= 3 ? (
        // 沒有心率：依回報的體感粗分（以次數計，規格 12.36）
        <EffortSplit efforts={values.efforts} />
      ) : (
        <p className="small muted">沒有心率區間的資料，回報體感的次數也還不夠。</p>
      )}

      {fitness && (
        <p className="small">
          體能 {fitness.ctl.toFixed(1)} · 疲勞 {fitness.atl.toFixed(1)} · 狀態 {(fitness.ctl - fitness.atl).toFixed(1)}
          <span className="muted"> · Intervals.icu {fitness.date.slice(5).replace("-", "/")}</span>
        </p>
      )}
      <p className="small muted row">
        <span>最近 28 天 {coverage.runs} 次跑步</span>
        <InfoTip label="資料的完整度">
          有心率 {coverage.withHr} 次、有區間時間 {coverage.withZones} 次、有回報體感 {coverage.rated} 次。缺的資料不補也不估。
        </InfoTip>
      </p>
    </section>
  );
}
