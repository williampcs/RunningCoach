import { useEffect, useState, type CSSProperties } from "react";

import { addDays, regionOf, REGIONS, shortDateLabel, type Accumulation, type ImportProgress, type ImportResult } from "@running-coach/core";

import { CalendarDays, Check, Flame, MapPin, Medal, Ruler, Timer, type LucideIcon } from "lucide-react";

import { errorText, useApp } from "../app-context";
import { Disclosure, Icon, InfoTip, SportIcon } from "../ui";

/** 最多畫幾格；更早的以「+N」表示 */
const MAX_BLOCKS = 300;
/** 最多畫幾面獎牌、幾座 101 */
const MAX_MEDALS = 24;
const MAX_TOWERS = 12;

function reducedMotion(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 數字從 0 跑到目標值；系統設定減少動態效果時直接顯示 */
function useCountUp(target: number, ms = 1000): number {
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

/** 第一次畫出來之後才設成 true：讓寬度、高度的轉場從 0 開始 */
function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return mounted;
}

const number = (n: number, digits = 0) => n.toLocaleString("zh-TW", { minimumFractionDigits: digits, maximumFractionDigits: digits });
/** 里程碑的名稱附上距離，例：「台北到東京（2,100 km）」；名稱本身不一定說得出距離 */
const placeText = (place: { name: string; km: number }) => `${place.name}（${number(place.km)} km）`;

function Tile({ icon, label, value, digits = 0, unit, sub, accent = false }: { icon: LucideIcon | "run"; label: string; value: number; digits?: number; unit: string; sub?: string; accent?: boolean }) {
  const shown = useCountUp(value);
  return (
    <div className={accent ? "tile accent" : "tile"}>
      <span className="tile-label">
        {icon === "run" ? <SportIcon sport="run" size={14} /> : <Icon as={icon} size={14} />} {label}
      </span>
      <span className="tile-value">
        {number(shown, digits)}
        <small> {unit}</small>
      </span>
      {sub && <span className="tile-sub">{sub}</span>}
    </div>
  );
}

/** 一站的距離：用座標算的標「約」；短的路線寫到小數一位（全馬 42.2 km） */
const stationKm = (p: { km: number; approx: boolean }) =>
  `${p.approx ? "約 " : ""}${number(p.km, p.km < 100 && !Number.isInteger(p.km) ? 1 : 0)} km`;

/**
 * 四站的軌道（規格 12.29）：等距排，過了的站打勾，跑者停在現在的位置（這一段的進度照公里數算）.
 * 走完軌道的最後一站整組往前移兩站，除了一開始都在中段或後段
 */
function Journey({ totals }: { totals: Accumulation }) {
  const mounted = useMounted();
  const { stations, at, fraction, origin } = totals.track;
  if (stations.length < 2) return null;
  const last = stations.length - 1;
  const pos = Math.min(1, (at + fraction) / last);
  const here = stations[at]!;
  const ahead = stations[at + 1];
  const label = ahead
    ? `在${here.name}和${ahead.name}之間，這一段跑了 ${Math.round(fraction * 10)} 成`
    : `已經到了${here.name}`;
  return (
    <div className="journey" role="img" aria-label={label}>
      {origin && (
        <span className="journey-origin small muted">
          <Icon as={MapPin} size={14} /> 從{origin}出發
        </span>
      )}
      {/* 軌道從第一欄的中間畫到最後一欄的中間，站點和下面的字對齊 */}
      <div className="journey-track" style={{ "--cols": stations.length } as CSSProperties}>
        <div className="journey-line">
          <div className="journey-fill" style={{ width: mounted ? `${pos * 100}%` : "0%" }} />
          {stations.map((s, i) => (
            <span key={s.name} className={s.passed ? "journey-stop passed" : "journey-stop"} style={{ left: `${(i / last) * 100}%` }}>
              {s.passed && <Icon as={Check} size={12} />}
            </span>
          ))}
          <span className="journey-runner" style={{ left: mounted ? `${pos * 100}%` : "0%" }}>
            <SportIcon sport="run" size={18} />
          </span>
        </div>
      </div>
      <ol className="journey-stations" style={{ "--cols": stations.length } as CSSProperties}>
        {stations.map((s) => (
          <li key={s.name} className={s.passed ? "passed" : ""}>
            <span className="journey-name" title={s.name}>
              {s.short}
            </span>
            {s.km > 0 && <span className="small muted">{stationKm(s)}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/** 一面獎牌是一場全馬的距離 */
function Medals({ count }: { count: number }) {
  const whole = Math.floor(count);
  if (whole < 1) return null;
  const shown = Math.min(whole, MAX_MEDALS);
  return (
    <div className="showcase">
      <div className="medals" role="img" aria-label={`相當於 ${number(count, 1)} 場全馬`}>
        {Array.from({ length: shown }, (_, i) => (
          <span key={i} className="medal" style={{ "--i": i } as CSSProperties}>
            <Icon as={Medal} />
          </span>
        ))}
        {whole > shown && <span className="more">+{number(whole - shown)}</span>}
      </div>
      <span className="tile-sub">每一面是一場全馬的距離，共 {number(count, 1)} 場</span>
    </div>
  );
}

/** 台北 101 的剪影：塔身八節、塔頂與天線 */
function Tower({ fill, index }: { fill: number; index: number }) {
  const mounted = useMounted();
  return (
    <svg className="tower" viewBox="0 0 24 64" style={{ "--i": index } as CSSProperties} aria-hidden="true">
      <defs>
        <clipPath id={`tower-fill-${index}`}>
          <rect x="0" width="24" y={64 - 64 * (mounted ? fill : 0)} height="64" className="tower-clip" />
        </clipPath>
      </defs>
      <g className="tower-shape">
        <path d="M11.5 0h1v6h-1z M9 6h6v4H9z" />
        {Array.from({ length: 8 }, (_, i) => (
          <path key={i} d={`M${6 + 0.2 * i} ${10 + i * 6}h${12 - 0.4 * i}l-1.5 6h${-9 + 0.4 * i}z`} />
        ))}
        <path d="M4 58h16v6H4z" />
      </g>
      <g className="tower-shape filled" clipPath={`url(#tower-fill-${index})`}>
        <path d="M11.5 0h1v6h-1z M9 6h6v4H9z" />
        {Array.from({ length: 8 }, (_, i) => (
          <path key={i} d={`M${6 + 0.2 * i} ${10 + i * 6}h${12 - 0.4 * i}l-1.5 6h${-9 + 0.4 * i}z`} />
        ))}
        <path d="M4 58h16v6H4z" />
      </g>
    </svg>
  );
}

/** 山的剪影（聖母峰）：主峰與兩側的山 */
function Mountain({ fill, index }: { fill: number; index: number }) {
  const mounted = useMounted();
  const shape = "M0 64 L16 30 L22 38 L32 6 L44 34 L50 26 L64 64 Z";
  return (
    <svg className="tower mountain" viewBox="0 0 64 64" style={{ "--i": index } as CSSProperties} aria-hidden="true">
      <defs>
        <clipPath id={`mountain-fill-${index}`}>
          <rect x="0" width="64" y={64 - 64 * (mounted ? fill : 0)} height="64" className="tower-clip" />
        </clipPath>
      </defs>
      <path className="tower-shape" d={shape} />
      <path className="tower-shape filled" d={shape} clipPath={`url(#mountain-fill-${index})`} />
    </svg>
  );
}

function Climb({ climb, meters }: { climb: Accumulation["climb"]; meters: number }) {
  if (meters <= 0) return null;
  const { count } = climb;
  const Shape = climb.kind === "mountain" ? Mountain : Tower;
  const whole = Math.floor(count);
  const shown = Math.min(Math.ceil(count), MAX_TOWERS);
  return (
    <div className="showcase">
      <div className="towers" role="img" aria-label={`累積爬升 ${number(meters)} 公尺，約 ${number(count, count < 1 ? 2 : 1)} 座${climb.name}`}>
        {Array.from({ length: Math.max(1, shown) }, (_, i) => (
          <Shape key={i} index={i} fill={i < whole ? 1 : Math.max(0.05, count - whole)} />
        ))}
        {Math.ceil(count) > shown && <span className="more">+{number(Math.ceil(count) - shown)}</span>}
      </div>
      <span className="tile-sub">
        累積爬升 {number(meters)} m，約 {number(count, count < 1 ? 2 : 1)} 座{climb.name}（{number(climb.meters)} m）
      </span>
    </div>
  );
}

/** 匯入完整歷史：只存紀錄，不產生 AI 分析 */
function ImportHistory({ onDone }: { onDone: () => void }) {
  const { coach } = useApp();
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (!coach.canImportHistory) return null;

  async function run() {
    setError(null);
    setResult(null);
    setProgress({ oldest: coach.today(), newest: coach.today(), found: 0 });
    try {
      setResult(await coach.importHistory(setProgress));
      onDone();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
    }
  }

  return (
    <div className="import-history">
      {progress ? (
        <div className="import-progress" role="status">
          <div className="indeterminate" />
          <span className="small">
            正在讀 {progress.oldest} – {progress.newest} 的跑步…已找到 {number(progress.found)} 趟
          </span>
        </div>
      ) : (
        <div className="actions">
          <button onClick={() => void run()}>{result ? "再匯入一次" : "匯入完整歷史"}</button>
          {!result && <InfoTip label="匯入完整歷史的說明">把 Intervals.icu 上更早的跑步全部存進來：只存紀錄、不產生 AI 分析，不花模型的費用；可能要一兩分鐘。</InfoTip>}
        </div>
      )}
      {error && <div className="notice error">匯入失敗：{error}（再按一次會從頭重抓，已存的不會重複）</div>}
      {result && (
        <div className="notice ok">
          <p>
            <strong>匯入完成：新增 {number(result.added)} 趟</strong>
            {result.existing + result.merged > 0 && `，${number(result.existing + result.merged)} 趟原本就有`}
            {result.earliest && `。最早的一趟是 ${result.earliest}`}。
          </p>
          {result.perYear.length > 0 && (
            <div className="year-chips">
              {result.perYear.map((y) => (
                <span key={y.year} className="badge">
                  {y.year}：{number(y.runs)} 趟
                </span>
              ))}
            </div>
          )}
          {result.unavailable > 0 && (
            <p className="small">
              另有 {number(result.unavailable)} 筆是從 Strava 匯入 Intervals.icu 的，Intervals.icu 不經 API 提供它們的內容，所以沒有匯入。
            </p>
          )}
        </div>
      )}
      <Disclosure summary="更早的跑步沒有出現？" className="small">
        <ul>
          <li>這裡只讀得到 Intervals.icu 上已經有的紀錄。Garmin 連上 Intervals.icu 時，Garmin 只讓它補抓約一年的舊資料，所以更早的常常不在 Intervals.icu 上。</li>
          <li>
            補齊的方法：在 Garmin 帳戶的「資料管理」申請匯出全部資料（下載連結的信通常兩天內寄到），再到 Intervals.icu 的設定頁選「Import all Garmin data」，貼上信裡下載按鈕的連結；Intervals.icu 處理可能要一天以上。完成後回來再按一次匯入。
          </li>
          <li>匯出檔太大時曾有人匯入失敗或顯示 0 筆；論壇上的做法是只保留壓縮檔裡的 DI_CONNECT 資料夾再上傳。以上依 Intervals.icu 論壇的說明，我們沒有實測。</li>
          <li>從 Strava 匯入 Intervals.icu 的活動，Intervals.icu 不經 API 提供；改上傳 Strava 的「匯出帳戶資料」檔案就沒有這個限制。</li>
        </ul>
      </Disclosure>
    </div>
  );
}

/** 還沒選里程碑、而時區對得到某個地區：問一次要不要依時區自動判斷 */
const REGION_HINT_KEY = "running-coach.region-hint.dismissed";

function RegionHint({ region }: { region: Accumulation["region"] }) {
  const { coach, touch } = useApp();
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(REGION_HINT_KEY) === "1";
    } catch {
      return false;
    }
  });
  const byTimeZone = regionOf("auto", coach.settings.timeZone);
  if (region !== "" || dismissed || byTimeZone === "") return null;
  const dismiss = () => {
    try {
      localStorage.setItem(REGION_HINT_KEY, "1");
    } catch {
      // 記不住也沒關係，下次再問
    }
    setDismissed(true);
  };
  return (
    <p className="region-hint small muted">
      你的時區在{REGIONS[byTimeZone]}，要改用當地的里程碑嗎？之後可以在「選手」改。
      <button
        className="text"
        onClick={() =>
          void coach.db.setProfileKey("region", "auto").then(() => {
            dismiss();
            touch();
          })
        }
      >
        依時區自動判斷
      </button>
      <button className="text" onClick={dismiss}>
        維持通用
      </button>
    </p>
  );
}

/** 紀錄頁頁首（規格 12.9、12.5）：只增不減的累積，數字與圖都從 0 長上來；這週沒跑就不出現這週 */
export function AccumulationView({ totals, today, onImported }: { totals: Accumulation; today: string; onImported: () => void }) {
  const km = useCountUp(totals.km, 1200);
  const hours = totals.minutes / 60;
  const weekStart = addDays(today, -((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7));
  const shown = totals.blocks.slice(-MAX_BLOCKS);
  const hidden = totals.blocks.length - shown.length;
  // 格子依序長出來，整段約一秒
  const delay = (i: number) => `${Math.round((i / Math.max(1, shown.length)) * 900)}ms`;
  return (
    <section className="card totals">
      <div className="totals-hero">
        <span className="tile-label">累積跑了</span>
        <span className="num hero-value">
          {number(km, 1)}
          <small> km</small>
        </span>
        {totals.passed && <span className="tile-sub">已經超過{placeText(totals.passed)}</span>}
        <Journey totals={totals} />
        <RegionHint region={totals.region} />
      </div>
      <div className="tiles">
        {totals.thisWeek && (
          <Tile accent icon={Flame} label="這週" value={totals.thisWeek.km} digits={1} unit="km" sub={`${totals.thisWeek.runs} 趟・${number(totals.thisWeek.minutes)} 分鐘`} />
        )}
        <Tile icon="run" label="跑了" value={totals.runs} unit="趟" sub={`${number(totals.weeks)} 週有跑步`} />
        <Tile icon={Timer} label="時間" value={hours} digits={hours < 10 ? 1 : 0} unit="小時" />
        {totals.thisYearKm !== null && <Tile icon={CalendarDays} label={`${today.slice(0, 4)} 年`} value={totals.thisYearKm} digits={1} unit="km" />}
        {totals.longest && <Tile icon={Ruler} label="最長的一趟" value={totals.longest.km} digits={1} unit="km" sub={shortDateLabel(totals.longest.date)} />}
      </div>
      <div className="showcases">
        <Medals count={totals.marathons} />
        <Climb climb={totals.climb} meters={totals.elevationM} />
      </div>
      {/* 每一趟一格，只有跑過的才出現，沒有空白的日子（12.5） */}
      <div className="blocks" role="img" aria-label={`每一趟一格，共 ${totals.runs} 趟`}>
        {hidden > 0 && <span className="blocks-more">+{number(hidden)}</span>}
        {shown.map((b, i) => (
          <span
            key={b.id}
            className={`block s${b.size}${b.date >= weekStart ? " recent" : ""}`}
            style={{ animationDelay: delay(i) }}
            title={b.date}
          />
        ))}
      </div>
      {totals.since && <p className="muted small">從 {totals.since} 起，每一格是一趟，越長的格子越大，有外框的是這週。</p>}
      <ImportHistory onDone={onImported} />
    </section>
  );
}
