import { useState } from "react";

import type { WeekVolume } from "@running-coach/core";

import { Disclosure, SportIcon } from "../ui";

/** 長條的一段：值與樣式（強度的顏色，或跑步、騎車的中性色） */
interface Segment {
  key: string;
  value: number;
  className: string;
}

const md = (iso: string) => `${Number(iso.slice(5, 7))}/${Number(iso.slice(8, 10))}`;
const hm = (m: number) => (m >= 60 ? `${Math.floor(m / 60)} 小時${m % 60 ? ` ${m % 60} 分` : ""}` : `${m} 分鐘`);
const pct = (part: number, total: number) => (total > 0 ? Math.round((part / total) * 100) : 0);

/**
 * 每週一根的長條（由下往上疊）：點一根看那週的數字（下面一行）；滑鼠移上去有提示.
 * 高度依所有週裡最大的那週；全部是 0 時不畫
 */
function WeekBars({
  weeks,
  segments,
  describe,
  selected,
  onSelect,
}: {
  weeks: WeekVolume[];
  segments: (w: WeekVolume) => Segment[];
  describe: (w: WeekVolume) => string;
  selected: number;
  onSelect: (i: number) => void;
}) {
  const totals = weeks.map((w) => segments(w).reduce((s, x) => s + x.value, 0));
  const max = Math.max(...totals);
  if (max <= 0) return <p className="small muted">這段時間還沒有資料。</p>;
  return (
    <div className="week-bars">
      <div className="week-bars-plot">
        {weeks.map((w, i) => (
          <button
            key={w.weekStart}
            type="button"
            className={`week-bar${i === selected ? " selected" : ""}`}
            aria-pressed={i === selected}
            aria-label={describe(w)}
            title={describe(w)}
            onClick={() => onSelect(i)}
          >
            <span className="week-bar-stack" style={{ height: `${(totals[i]! / max) * 100}%` }}>
              {segments(w)
                .filter((s) => s.value > 0)
                .map((s) => (
                  <span key={s.key} className={s.className} style={{ flexGrow: s.value }} />
                ))}
            </span>
          </button>
        ))}
      </div>
      <div className="week-bars-axis" aria-hidden="true">
        {weeks.map((w, i) => (
          // 每兩週標一次日期（手機上放不下每一週），最後一週標「這週」
          <span key={w.weekStart}>{i === weeks.length - 1 ? "這週" : (weeks.length - 1 - i) % 2 === 0 ? md(w.weekStart) : ""}</span>
        ))}
      </div>
    </div>
  );
}

/**
 * 騎車的週趨勢（多運動，規格 12.31）：
 * 1. 騎車的時間，依心率區間疊成低、中、高強度（顏色只代表強度，和課表、紀錄一致）；沒有區間資料的騎車是灰色.
 * 2. 跑步＋騎車的總量（時間或負荷）：運動用圖示與兩種中性色分（深的是跑步、淺的是騎車），不用強度的顏色，
 *    避免和上面的強度混淆.
 * 點任一根長條，兩張圖一起選那週，下面一行寫那週的數字；「每週的數字」是表格
 */
export function WeeklyVolumeCard({ weeks }: { weeks: WeekVolume[] }) {
  const [selected, setSelected] = useState(weeks.length - 1);
  const [metric, setMetric] = useState<"minutes" | "load">("minutes");
  const week = weeks[selected] ?? weeks.at(-1)!;
  const z = week.ride.intensity;
  const zoned = z.low + z.moderate + z.high;
  const hasUnknown = weeks.some((w) => w.ride.intensity.unknown > 0);
  const rideText = (w: WeekVolume) =>
    w.ride.count
      ? `騎 ${w.ride.count} 次、${hm(w.ride.minutes)}${w.ride.km ? `、${w.ride.km} km` : ""}、負荷 ${w.ride.load}`
      : "沒有騎車";
  const zoneText = (w: WeekVolume) => {
    const t = w.ride.intensity;
    const sum = t.low + t.moderate + t.high;
    return sum > 0 ? `低 ${pct(t.low, sum)}%、中 ${pct(t.moderate, sum)}%、高 ${pct(t.high, sum)}%` : "";
  };
  const totalText = (w: WeekVolume) =>
    metric === "minutes"
      ? `跑步 ${hm(w.run.minutes)}、騎車 ${hm(w.ride.minutes)}，共 ${hm(w.run.minutes + w.ride.minutes)}`
      : `跑步負荷 ${w.run.load}、騎車負荷 ${w.ride.load}，共 ${w.run.load + w.ride.load}`;

  return (
    <section className="card weekly-volume">
      <h2 className="row">
        <SportIcon sport="ride" />
        騎車的每週
      </h2>
      <WeekBars
        weeks={weeks}
        selected={selected}
        onSelect={setSelected}
        describe={(w) => `${md(w.weekStart)} 那週：${rideText(w)}${zoneText(w) ? `；${zoneText(w)}` : ""}`}
        segments={(w) => [
          { key: "low", value: w.ride.intensity.low, className: "low" },
          { key: "moderate", value: w.ride.intensity.moderate, className: "moderate" },
          { key: "high", value: w.ride.intensity.high, className: "high" },
          { key: "unknown", value: w.ride.intensity.unknown, className: "unknown" },
        ]}
      />
      <p className="small muted legend">
        <span>
          <span className="dot low" />低
        </span>
        <span>
          <span className="dot moderate" />中
        </span>
        <span>
          <span className="dot high" />高
        </span>
        {hasUnknown && (
          <span>
            <span className="dot unknown" />沒有心率區間
          </span>
        )}
      </p>
      <p className="small week-detail">
        <strong>{selected === weeks.length - 1 ? "這週" : `${md(week.weekStart)} 那週`}</strong>：{rideText(week)}
        {zoned > 0 && `；${zoneText(week)}`}
      </p>

      <div className="row between week-total-head">
        <h3>跑步＋騎車</h3>
        <div className="segmented" role="group" aria-label="看時間或負荷">
          <button type="button" aria-pressed={metric === "minutes"} onClick={() => setMetric("minutes")}>
            時間
          </button>
          <button type="button" aria-pressed={metric === "load"} onClick={() => setMetric("load")}>
            負荷
          </button>
        </div>
      </div>
      <WeekBars
        weeks={weeks}
        selected={selected}
        onSelect={setSelected}
        describe={(w) => `${md(w.weekStart)} 那週：${totalText(w)}`}
        segments={(w) => [
          { key: "run", value: metric === "minutes" ? w.run.minutes : w.run.load, className: "vol-run" },
          { key: "ride", value: metric === "minutes" ? w.ride.minutes : w.ride.load, className: "vol-ride" },
        ]}
      />
      <p className="small muted legend">
        <span>
          <span className="dot vol-run" />
          <SportIcon sport="run" size={16} />
          跑步
        </span>
        <span>
          <span className="dot vol-ride" />
          <SportIcon sport="ride" size={16} />
          騎車
        </span>
      </p>
      <p className="small week-detail">
        <strong>{selected === weeks.length - 1 ? "這週" : `${md(week.weekStart)} 那週`}</strong>：{totalText(week)}
      </p>

      <Disclosure summary="每週的數字">
        <table className="week-table">
          <thead>
            <tr>
              <th scope="col">週</th>
              <th scope="col">騎車</th>
              <th scope="col">騎車負荷</th>
              <th scope="col">跑步</th>
              <th scope="col">跑步負荷</th>
            </tr>
          </thead>
          <tbody>
            {[...weeks].reverse().map((w) => (
              <tr key={w.weekStart}>
                <th scope="row">{md(w.weekStart)}</th>
                <td>{w.ride.count ? hm(w.ride.minutes) : "—"}</td>
                <td>{w.ride.count ? w.ride.load : "—"}</td>
                <td>{w.run.count ? hm(w.run.minutes) : "—"}</td>
                <td>{w.run.count ? w.run.load : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Disclosure>
    </section>
  );
}
