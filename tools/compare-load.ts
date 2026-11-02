/**
 * 比對我們算的負荷、體能與疲勞和 Intervals.icu 的（規格 12.37「不分來源的核心」）.
 *
 * 只讀不寫，用自己的 API key 在本機執行（使用者真實的資料不進雲端 session）：
 *   INTERVALS_API_KEY=... npx tsx tools/compare-load.ts
 * 目前目錄有 .env（INTERVALS_API_KEY、INTERVALS_ATHLETE_ID）時會自動讀取。
 * 選項：
 *   --days 180     抓幾天的活動與恢復資料（預設 180；體能要 42 天以上才穩定）
 *   --max-hr 188   實測的最大心率（選手資料的 max_hr；沒填時只用 Intervals.icu 的設定）
 * 設定 INTERVALS_BASE_URL 可以指向其他位址（例如模擬服務）。
 *
 * 印出：
 * 1. 每一趟：Intervals.icu 的負荷和我們用心率、配速、體感各自估的差（中位數、平均絕對誤差、比例），依運動分組.
 * 2. 有體感、也有 Intervals.icu 負荷的：依體感分組，我們「依體感估」的和 Intervals.icu 的差，
 *    以及 Intervals.icu 的負荷換算回去的強度係數（IF），拿來調 load.ts 的 RPE_INTENSITY.
 * 3. 體能與疲勞：最近 90 天每天，(a) 每一趟都用我們估的、(b) 有 Intervals.icu 的負荷就用它（驗證指數平均的模型），
 *    和 Intervals.icu 每天的 CTL、ATL 的差.
 * 結果也寫到 data/compare-load/（不進版控）。輸出只有日期、運動與數字，沒有名稱、說明與 id；貼給別人之前仍請自己看過一次。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import {
  addDays,
  DEFAULT_REST_HR,
  estimateVdot,
  fitnessSeries,
  hrLoad,
  IntervalsClient,
  loadContextOf,
  localDate,
  paceLoad,
  RPE_INTENSITY,
  rpeLoad,
  sportOfType,
  type LoadContext,
  type PaceCurveSummary,
  type SportSettings,
  type WellnessDay,
} from "../packages/core/src";

/** 比對用的一趟（從 Intervals.icu 的活動取出的數字） */
export interface CompareActivity {
  date: string;
  sport: string;
  minutes: number;
  km: number | null;
  avgHr: number | null;
  rpe: number | null;
  icuLoad: number | null;
}

export interface CompareInput {
  today: string;
  days: number;
  activities: CompareActivity[];
  /** 每天的 Intervals.icu CTL、ATL 與靜止心率 */
  wellness: { date: string; ctl: number | null; atl: number | null; restingHr: number | null }[];
  ctx: LoadContext;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Intervals.icu 的活動 → 比對用的一趟；不是活動（沒有時間）的略過 */
export function compareActivityOf(raw: Record<string, unknown>): CompareActivity | null {
  const start = typeof raw.start_date_local === "string" ? raw.start_date_local : "";
  const seconds = num(raw.moving_time) ?? num(raw.elapsed_time);
  if (!start || !seconds) return null;
  const meters = num(raw.distance);
  const rpe = num(raw.icu_rpe) ?? num(raw.perceived_exertion);
  return {
    date: start.slice(0, 10),
    sport: sportOfType(String(raw.type ?? "")),
    minutes: seconds / 60,
    km: meters ? meters / 1000 : null,
    avgHr: num(raw.average_heartrate),
    rpe: rpe !== null && rpe >= 1 && rpe <= 10 ? Math.round(rpe) : null,
    icuLoad: num(raw.icu_training_load),
  };
}

type Method = "hr" | "pace" | "rpe";

function ours(a: CompareActivity, method: Method, ctx: LoadContext): number | null {
  if (method === "hr") return a.avgHr ? hrLoad(a.minutes, a.avgHr, ctx.hr[a.sport] ?? ctx.hr.run ?? { maxHr: null, lthr: null }, ctx.restHr) : null;
  if (method === "pace") return a.sport === "run" && a.km && ctx.thresholdPaceSec ? paceLoad(a.minutes, a.km, ctx.thresholdPaceSec) : null;
  return a.rpe !== null ? rpeLoad(a.minutes, a.rpe) : null;
}

/** 我們估的（不看 Intervals.icu 的）：心率 → 配速 → 體感，和 load.ts 的 estimateLoad 同一個順序 */
function ourBest(a: CompareActivity, ctx: LoadContext): number | null {
  return ours(a, "hr", ctx) ?? ours(a, "pace", ctx) ?? ours(a, "rpe", ctx);
}

const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const r1 = (x: number | null) => (x === null ? "—" : String(Math.round(x * 10) / 10));
const r2 = (x: number | null) => (x === null ? "—" : String(Math.round(x * 100) / 100));

export interface DiffStats {
  n: number;
  /** 我們 − Intervals.icu 的中位數與平均絕對誤差 */
  medianDiff: number | null;
  mae: number | null;
  /** 我們 ÷ Intervals.icu 的中位數 */
  medianRatio: number | null;
  /** 差最多的幾筆 */
  worst: { date: string; sport: string; icu: number; ours: number }[];
}

function diffStats(pairs: { a: CompareActivity; ours: number }[]): DiffStats {
  const withIcu = pairs.filter((p) => p.a.icuLoad !== null);
  const diffs = withIcu.map((p) => p.ours - p.a.icuLoad!);
  return {
    n: withIcu.length,
    medianDiff: median(diffs),
    mae: mean(diffs.map(Math.abs)),
    medianRatio: median(withIcu.filter((p) => p.a.icuLoad! > 0).map((p) => p.ours / p.a.icuLoad!)),
    worst: [...withIcu]
      .sort((x, y) => Math.abs(y.ours - y.a.icuLoad!) - Math.abs(x.ours - x.a.icuLoad!))
      .slice(0, 5)
      .map((p) => ({ date: p.a.date, sport: p.a.sport, icu: p.a.icuLoad!, ours: p.ours })),
  };
}

export interface CompareResult {
  activities: number;
  byMethod: Record<Method, Record<string, DiffStats>>;
  /** 依體感分組：我們依體感估的和 Intervals.icu 的；icuIf 是 Intervals.icu 的負荷換算回去的強度係數的中位數 */
  byRpe: { rpe: number; n: number; table: number; icuIf: number | null; medianDiff: number | null; mae: number | null }[];
  /** 最近 90 天每天的 CTL、ATL 差（我們 − Intervals.icu）；mixed 是有 Intervals.icu 的負荷就用它 */
  fitness: Record<"ours" | "mixed", { days: number; ctlMae: number | null; atlMae: number | null; last: { date: string; ctl: number; atl: number; icuCtl: number | null; icuAtl: number | null } | null }>;
}

export function compareLoads(input: CompareInput): CompareResult {
  const { activities, ctx } = input;
  const byMethod = {} as CompareResult["byMethod"];
  for (const method of ["hr", "pace", "rpe"] as const) {
    const groups: Record<string, { a: CompareActivity; ours: number }[]> = {};
    for (const a of activities) {
      const value = ours(a, method, ctx);
      if (value === null) continue;
      (groups[a.sport] ??= []).push({ a, ours: value });
      (groups.all ??= []).push({ a, ours: value });
    }
    byMethod[method] = Object.fromEntries(Object.entries(groups).map(([sport, pairs]) => [sport, diffStats(pairs)]));
  }

  const byRpe: CompareResult["byRpe"] = [];
  for (let rpe = 1; rpe <= 10; rpe++) {
    const list = activities.filter((a) => a.rpe === rpe && a.icuLoad !== null && a.minutes > 0);
    if (!list.length) continue;
    const diffs = list.map((a) => rpeLoad(a.minutes, rpe)! - a.icuLoad!);
    byRpe.push({
      rpe,
      n: list.length,
      table: RPE_INTENSITY[rpe]!,
      icuIf: median(list.map((a) => Math.sqrt(Math.max(0, a.icuLoad!) / (a.minutes / 60) / 100))),
      medianDiff: median(diffs),
      mae: mean(diffs.map(Math.abs)),
    });
  }

  const from = addDays(input.today, -input.days);
  const since90 = addDays(input.today, -90);
  const icuByDate = new Map(input.wellness.map((w) => [w.date, w]));
  const fitness = {} as CompareResult["fitness"];
  for (const mode of ["ours", "mixed"] as const) {
    const daily = new Map<string, number>();
    for (const a of activities) {
      const value = mode === "mixed" && a.icuLoad !== null ? a.icuLoad : ourBest(a, ctx);
      if (value !== null) daily.set(a.date, (daily.get(a.date) ?? 0) + value);
    }
    const series = fitnessSeries(daily, from, input.today).filter((p) => p.date >= since90);
    const pairs = series.flatMap((p) => {
      const w = icuByDate.get(p.date);
      return w && w.ctl !== null && w.atl !== null ? [{ p, w }] : [];
    });
    const lastPoint = series[series.length - 1] ?? null;
    const lastIcu = lastPoint ? icuByDate.get(lastPoint.date) : undefined;
    fitness[mode] = {
      days: pairs.length,
      ctlMae: mean(pairs.map(({ p, w }) => Math.abs(p.ctl - w.ctl!))),
      atlMae: mean(pairs.map(({ p, w }) => Math.abs(p.atl - w.atl!))),
      last: lastPoint ? { date: lastPoint.date, ctl: lastPoint.ctl, atl: lastPoint.atl, icuCtl: lastIcu?.ctl ?? null, icuAtl: lastIcu?.atl ?? null } : null,
    };
  }
  return { activities: activities.length, byMethod, byRpe, fitness };
}

const METHOD_LABELS: Record<Method, string> = { hr: "依心率估（hrSS）", pace: "依配速估（rTSS，只有跑步）", rpe: "依體感估" };

export function reportText(result: CompareResult, ctx: LoadContext): string {
  const lines = [
    `活動 ${result.activities} 筆`,
    `估負荷的依據：跑步的最大心率 ${ctx.hr.run?.maxHr ?? "—"}、閾值心率 ${ctx.hr.run?.lthr ?? "—"}、靜止心率 ${r1(ctx.restHr)}${ctx.restHr === DEFAULT_REST_HR ? "（預設）" : ""}、閾值配速 ${ctx.thresholdPaceSec ? `${Math.floor(ctx.thresholdPaceSec / 60)}:${String(Math.round(ctx.thresholdPaceSec % 60)).padStart(2, "0")}/km` : "—"}`,
    "",
    "== 1. 每一趟的負荷：我們估的 − Intervals.icu 的 ==",
  ];
  for (const method of ["hr", "pace", "rpe"] as const) {
    lines.push(`-- ${METHOD_LABELS[method]}`);
    const groups = result.byMethod[method];
    if (!Object.keys(groups).length) lines.push("  （沒有可以估的紀錄）");
    for (const [sport, s] of Object.entries(groups)) {
      lines.push(`  ${sport.padEnd(9)} n=${s.n}  差的中位數 ${r1(s.medianDiff)}  平均絕對誤差 ${r1(s.mae)}  比例的中位數 ${r2(s.medianRatio)}`);
      if (sport === "all") for (const w of s.worst) lines.push(`      差最多：${w.date} ${w.sport} Intervals.icu ${w.icu}、我們 ${w.ours}`);
    }
  }
  lines.push("", "== 2. 依體感分組（有體感、也有 Intervals.icu 的負荷）==");
  if (!result.byRpe.length) lines.push("  （沒有同時有體感與負荷的紀錄：在 Intervals.icu 的活動填 RPE 後再跑一次）");
  for (const g of result.byRpe) {
    lines.push(`  體感 ${String(g.rpe).padStart(2)}  n=${g.n}  對照表 IF ${g.table}  Intervals.icu 換算的 IF（中位數）${r2(g.icuIf)}  差的中位數 ${r1(g.medianDiff)}  平均絕對誤差 ${r1(g.mae)}`);
  }
  lines.push("", "== 3. 體能（CTL）與疲勞（ATL）：最近 90 天每天和 Intervals.icu 的差 ==");
  for (const mode of ["ours", "mixed"] as const) {
    const f = result.fitness[mode];
    const label = mode === "ours" ? "全部用我們估的" : "有 Intervals.icu 的負荷就用它（驗證平均的模型）";
    lines.push(`-- ${label}：${f.days} 天  CTL 平均絕對誤差 ${r1(f.ctlMae)}  ATL 平均絕對誤差 ${r1(f.atlMae)}`);
    if (f.last) lines.push(`   ${f.last.date}：我們 CTL ${r1(f.last.ctl)} ATL ${r1(f.last.atl)}｜Intervals.icu CTL ${r1(f.last.icuCtl)} ATL ${r1(f.last.icuAtl)}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 在本機執行
// ---------------------------------------------------------------------------

async function main() {
  const { values: args } = parseArgs({ options: { days: { type: "string", default: "180" }, "max-hr": { type: "string" } } });
  const days = Math.max(42, Number(args.days) || 180);
  if (!process.env.INTERVALS_API_KEY && existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  const apiKey = process.env.INTERVALS_API_KEY?.trim();
  if (!apiKey) {
    console.error("找不到 INTERVALS_API_KEY：請設定環境變數，或在目前目錄放 .env。");
    process.exit(1);
  }
  const athleteId = process.env.INTERVALS_ATHLETE_ID?.trim() || "0";
  const baseUrl = (process.env.INTERVALS_BASE_URL ?? "https://intervals.icu/api/v1").replace(/\/$/, "");
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const today = localDate(new Date(), timeZone);
  const client = new IntervalsClient({ apiKey, athleteId, baseUrl, today: () => today });

  const get = async (path: string) => {
    const res = await fetch(`${baseUrl}/athlete/${encodeURIComponent(athleteId)}${path}`, {
      headers: { authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`, accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Intervals.icu 回應 ${res.status}（${path.split("?")[0]}）`);
    return res.json() as Promise<unknown>;
  };
  const oldest = addDays(today, -days);
  const [rawActivities, rawWellness, sportSettings, curve] = await Promise.all([
    get(`/activities?oldest=${oldest}&newest=${today}`),
    get(`/wellness?oldest=${oldest}&newest=${today}`),
    client.fetchSportSettings().catch(() => [] as SportSettings[]),
    client.fetchPaceCurve(90).catch(() => null as PaceCurveSummary | null),
  ]);
  const activities = (Array.isArray(rawActivities) ? (rawActivities as Record<string, unknown>[]) : []).flatMap((r) => compareActivityOf(r) ?? []);
  const wellness = (Array.isArray(rawWellness) ? (rawWellness as Record<string, unknown>[]) : []).flatMap((w) => {
    const date = typeof w.id === "string" ? w.id.slice(0, 10) : "";
    return date ? [{ date, ctl: num(w.ctl), atl: num(w.atl), restingHr: num(w.restingHR) }] : [];
  });
  const run = sportSettings.find((s) => s.types.includes("Run")) ?? null;
  const profile: Record<string, string> = args["max-hr"] ? { max_hr: args["max-hr"] } : {};
  const ctx = loadContextOf(
    profile,
    run ? { lthr: run.lthr, max_hr: run.max_hr, hr_zones: run.hr_zones, threshold_pace: run.threshold_pace } : null,
    sportSettings,
    wellness.filter((w) => w.date >= addDays(today, -28)).map((w) => ({ resting_hr: w.restingHr }) as Pick<WellnessDay, "resting_hr">),
    estimateVdot([], curve, today, profile),
  );
  const result = compareLoads({ today, days, activities, wellness, ctx });
  const text = reportText(result, ctx);
  console.log(text);
  mkdirSync("data/compare-load", { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  writeFileSync(`data/compare-load/${stamp}.txt`, `${text}\n`);
  writeFileSync(`data/compare-load/${stamp}.json`, JSON.stringify(result, null, 2));
  console.log(`\n已寫到 data/compare-load/${stamp}.txt 與 .json`);
}

if (process.argv[1] && /compare-load\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
