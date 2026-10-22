import { useEffect, useState } from "react";

import { addDays, type Accumulation } from "@running-coach/core";

/** 最多畫幾格；更早的以「+N」表示 */
const MAX_BLOCKS = 300;

/** 數字從 0 跑到目標值；系統設定減少動態效果時直接顯示 */
function useCountUp(target: number, ms = 900): number {
  const [value, setValue] = useState(() => (reducedMotion() ? target : 0));
  useEffect(() => {
    if (reducedMotion()) {
      setValue(target);
      return;
    }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      setValue(target * (1 - (1 - t) ** 3));
      if (t < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, ms]);
  return value;
}

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

const number = (n: number, digits = 0) => n.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });

function Tile({ label, value, unit, sub, accent = false }: { label: string; value: string; unit: string; sub?: string; accent?: boolean }) {
  return (
    <div className={accent ? "tile accent" : "tile"}>
      <span className="tile-label">{label}</span>
      <span className="tile-value">
        {value}
        <small> {unit}</small>
      </span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

/** 紀錄頁頁首（規格 12.9、12.5）：只增不減的累積；這週沒跑就不出現這週 */
export function AccumulationView({ totals, today }: { totals: Accumulation; today: string }) {
  const km = useCountUp(totals.km);
  const hours = totals.minutes / 60;
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const shown = totals.blocks.slice(-MAX_BLOCKS);
  const hidden = totals.blocks.length - shown.length;
  return (
    <section className="card totals">
      <div className="totals-hero">
        <span className="tile-label">累積跑了</span>
        <span className="hero-value">
          {number(km, 1)}
          <small> km</small>
        </span>
        {(totals.passed || totals.next) && (
          <span className="tile-sub">
            {totals.passed && `已經超過${totals.passed.name}（約 ${number(totals.passed.km)} km）`}
            {totals.passed && totals.next && "，"}
            {totals.next && `下一站：${totals.next.name}`}
          </span>
        )}
      </div>
      <div className="tiles">
        {totals.thisWeek && (
          <Tile
            accent
            label="這週"
            value={number(totals.thisWeek.km, 1)}
            unit="km"
            sub={`${totals.thisWeek.runs} 趟・${number(totals.thisWeek.minutes)} 分鐘`}
          />
        )}
        <Tile label="跑了" value={number(totals.runs)} unit="趟" sub={`${number(totals.weeks)} 週有跑步`} />
        <Tile label="時間" value={number(hours, hours < 10 ? 1 : 0)} unit="小時" />
        {totals.marathons >= 1 && <Tile label="相當於" value={number(totals.marathons, 1)} unit="場全馬" />}
        {totals.elevationM > 0 && (
          <Tile
            label="累積爬升"
            value={number(totals.elevationM)}
            unit="m"
            sub={totals.taipei101 >= 1 ? `約 ${number(totals.taipei101, 1)} 座台北 101` : undefined}
          />
        )}
        {totals.thisYearKm !== null && <Tile label={`${today.slice(0, 4)} 年`} value={number(totals.thisYearKm, 1)} unit="km" />}
        {totals.longest && <Tile label="最長的一趟" value={number(totals.longest.km, 1)} unit="km" sub={totals.longest.date} />}
      </div>
      {/* 每一趟一格，只有跑過的才出現，沒有空白的日子（12.5） */}
      <div className="blocks" role="img" aria-label={`每一趟一格，共 ${totals.runs} 趟`}>
        {hidden > 0 && <span className="blocks-more">+{number(hidden)}</span>}
        {shown.map((b) => (
          <span key={b.id} className={`block s${b.size}${b.date >= weekStart ? " recent" : ""}`} title={b.date} />
        ))}
      </div>
      {totals.since && <p className="muted small">從 {totals.since} 起已同步到 App 的跑步。</p>}
    </section>
  );
}
