/**
 * 列出 Intervals.icu API 實際回傳的欄位（規格 12.8）.
 *
 * 只讀不寫，用自己的 API key 在本機執行：
 *   INTERVALS_API_KEY=... npx tsx tools/intervals-fields.ts
 * 目前目錄有 .env（INTERVALS_API_KEY、INTERVALS_ATHLETE_ID）時會自動讀取。
 * 選項：
 *   --days 42        活動、恢復資料與行事曆往回查幾天（預設 42）
 *   --names-only     只列欄位名稱與有值的比例，不列數字的範圍
 * 結果印在終端機，也寫到 data/intervals-fields/（不進版控）。
 *
 * 輸出不含個人資訊：文字只印類型、單位這類列舉值，名稱、說明、email、金鑰與各種 id 一律不印；
 * 數字只印最小到最大值，用來判斷單位；不下載串流（含 GPS）。貼給別人之前仍請自己看過一次。
 * 設定 INTERVALS_BASE_URL 可以指向其他位址（例如模擬服務）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    days: { type: "string", default: "42" },
    "names-only": { type: "boolean", default: false },
  },
});
const days = Math.max(1, Number(args.days) || 42);
const namesOnly = args["names-only"];

if (!process.env.INTERVALS_API_KEY && existsSync(".env") && typeof process.loadEnvFile === "function") {
  process.loadEnvFile(".env");
}
const apiKey = process.env.INTERVALS_API_KEY?.trim();
if (!apiKey) {
  console.error("找不到 INTERVALS_API_KEY：請設定環境變數，或在目前目錄放 .env。");
  process.exit(1);
}
const athleteId = encodeURIComponent(process.env.INTERVALS_ATHLETE_ID?.trim() || "0");
const baseUrl = (process.env.INTERVALS_BASE_URL ?? "https://intervals.icu/api/v1").replace(/\/$/, "");

// ---------------------------------------------------------------------------
// 遮蔽規則
// ---------------------------------------------------------------------------

/** 這些欄位的數字也不印：各種 id、序號 */
const ID_KEY = /(^|_)ids?$|^id_|serial|token|api_key|secret|password|strava|external/i;
/** 只有這些欄位的文字會印出（類型、單位、模型這類列舉值） */
const ENUM_KEY =
  /^(type|types|sub_type|category|source|file_type|target|pace_units|power_field|measurement_preference|gap_model|elevation_correction)$|_(type|types|units|model|keys|order)$/;
/** 動態的鍵（例如以活動 id 為鍵的物件）合併成一個；只看長的數字，`r2` 這類欄位名稱不算 */
const DYNAMIC_KEY = /^[a-z]?\d{4,}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+Z?)?$/;

interface Stat {
  kinds: Set<string>;
  present: number;
  min: number;
  max: number;
  trues: number;
  falses: number;
  /** 陣列長度的範圍 */
  lenMin: number;
  lenMax: number;
  samples: Set<string>;
  /** 列舉值太多，沒有全部列出 */
  more: boolean;
  masked: boolean;
}

class Collector {
  readonly stats = new Map<string, Stat>();
  /** 每一層物件被看過幾次，作為有值比例的分母 */
  private readonly parents = new Map<string, number>();

  add(records: unknown[]): void {
    for (const r of records) if (isObject(r)) this.visit(r, "");
  }

  total(path: string): number {
    const i = path.lastIndexOf(".");
    return this.parents.get(i < 0 ? "" : path.slice(0, i + 1)) ?? 0;
  }

  private stat(path: string): Stat {
    let s = this.stats.get(path);
    if (!s) {
      s = {
        kinds: new Set(),
        present: 0,
        min: Infinity,
        max: -Infinity,
        trues: 0,
        falses: 0,
        lenMin: Infinity,
        lenMax: -Infinity,
        samples: new Set(),
        more: false,
        masked: false,
      };
      this.stats.set(path, s);
    }
    return s;
  }

  private visit(obj: Record<string, unknown>, prefix: string): void {
    this.parents.set(prefix, (this.parents.get(prefix) ?? 0) + 1);
    for (const [rawKey, value] of Object.entries(obj)) {
      const key = DYNAMIC_KEY.test(rawKey) ? "{id}" : rawKey;
      const path = prefix + key;
      const s = this.stat(path);
      if (value === null || value === undefined) {
        s.kinds.add("null");
        continue;
      }
      s.present++;
      if (Array.isArray(value)) {
        s.lenMin = Math.min(s.lenMin, value.length);
        s.lenMax = Math.max(s.lenMax, value.length);
        const objects = value.filter(isObject);
        if (objects.length) {
          s.kinds.add("object[]");
          for (const o of objects) this.visit(o, `${path}[].`);
        }
        for (const item of value) if (!isObject(item)) this.primitive(s, key, item, true);
      } else if (isObject(value)) {
        s.kinds.add("object");
        this.visit(value, `${path}.`);
      } else {
        this.primitive(s, key, value, false);
      }
    }
  }

  private primitive(s: Stat, key: string, value: unknown, inArray: boolean): void {
    const suffix = inArray ? "[]" : "";
    if (typeof value === "number") {
      s.kinds.add(`number${suffix}`);
      if (ID_KEY.test(key)) s.masked = true;
      else if (Number.isFinite(value)) {
        s.min = Math.min(s.min, value);
        s.max = Math.max(s.max, value);
      }
    } else if (typeof value === "boolean") {
      s.kinds.add(`boolean${suffix}`);
      if (value) s.trues++;
      else s.falses++;
    } else if (typeof value === "string") {
      if (DATE.test(value)) {
        s.kinds.add(`date${suffix}`);
      } else {
        s.kinds.add(`string${suffix}`);
        if (!ENUM_KEY.test(key) || ID_KEY.test(key) || value.length > 40) s.masked = true;
        else if (s.samples.size < 20) s.samples.add(value);
        else if (!s.samples.has(value)) s.more = true;
      }
    } else {
      s.kinds.add(Array.isArray(value) ? `array${suffix}` : typeof value);
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toPrecision(4)));
}

function describe(s: Stat): string {
  const parts: string[] = [];
  const kinds = [...s.kinds].filter((k) => k !== "null");
  if (!kinds.length && s.lenMax >= 0) kinds.push("array");
  if (s.lenMax >= 0) parts.push(s.lenMin === s.lenMax ? `長度 ${s.lenMin}` : `長度 ${s.lenMin}–${s.lenMax}`);
  if (!namesOnly && s.min <= s.max) parts.push(s.min === s.max ? fmt(s.min) : `${fmt(s.min)} – ${fmt(s.max)}`);
  if (s.trues + s.falses) parts.push(`true ${s.trues}／false ${s.falses}`);
  if (s.samples.size) parts.push([...s.samples].join(", ") + (s.more ? " …" : ""));
  if (s.masked) parts.push("（不印）");
  return `${kinds.join("|") || "null"}  ${parts.join("  ")}`.trimEnd();
}

// ---------------------------------------------------------------------------
// 呼叫 API
// ---------------------------------------------------------------------------

interface Result {
  status: number;
  body: unknown;
  error?: string;
}

async function get(path: string, query: Record<string, string | number | boolean> = {}): Promise<Result> {
  const url = new URL(baseUrl + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`, Accept: "application/json" },
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { status: res.status, body, error: res.ok ? undefined : text.slice(0, 200) };
  } catch (e) {
    return { status: 0, body: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const out: string[] = [];
const print = (line = "") => {
  out.push(line);
  console.log(line);
};

/** 印出一個端點的結果；records 為要統計欄位的物件（預設為整個回應） */
function report(title: string, note: string, r: Result, records?: unknown[]): void {
  print(`## ${title}`);
  if (note) print(note);
  if (r.status !== 200) {
    print(`狀態 ${r.status || "連線失敗"}${r.error ? `：${r.error.replace(/\s+/g, " ")}` : ""}`);
    print();
    return;
  }
  const list = records ?? (Array.isArray(r.body) ? r.body : [r.body]);
  print(`狀態 200，${list.length} 筆`);
  if (!list.length) {
    print();
    return;
  }
  const c = new Collector();
  c.add(list);
  const width = Math.min(48, Math.max(...[...c.stats.keys()].map((k) => k.length)));
  print("```");
  for (const [path, s] of c.stats) {
    // 以 id 為鍵的物件：列出有幾個，不是有值的比例
    const count = path.endsWith("{id}") ? `${s.present} 個` : `${s.present}/${c.total(path)}`;
    print(`${path.padEnd(width)}  ${count.padStart(7)}  ${describe(s)}`);
  }
  print("```");
  print();
}

function isRun(a: Record<string, unknown>): boolean {
  return String(a.type ?? "").toLowerCase().includes("run");
}

// ---------------------------------------------------------------------------

// 本機時區的今天（sv-SE 的日期格式就是 YYYY-MM-DD）
const today = new Date().toLocaleDateString("sv-SE");
const oldest = addDays(today, -(days - 1));
const athlete = `/athlete/${athleteId}`;

print(`# Intervals.icu 的欄位（${today}，往回 ${days} 天）`);
print();
print("每一行：欄位、有值的筆數／總筆數、型別與範圍。「（不印）」是為了隱私不列出的值。");
print();

// 選手與運動設定
const me = await get(athlete);
report(`GET /athlete/{id}`, "選手設定；運動設定另列在下一段", me, isObject(me.body) ? [omit(me.body, "sportSettings")] : undefined);
const settings = isObject(me.body) && Array.isArray(me.body.sportSettings) ? me.body.sportSettings.filter(isObject) : [];
const runSettings = settings.find((s) => Array.isArray(s.types) && s.types.includes("Run"));
report(
  "GET /athlete/{id} 的 sportSettings（跑步）",
  `共 ${settings.length} 組運動設定，以下只列包含 Run 的那組`,
  { status: me.status, body: null },
  runSettings ? [runSettings] : [],
);

// 活動
const acts = await get(`${athlete}/activities`, { oldest, newest: today });
const all = Array.isArray(acts.body) ? acts.body.filter(isObject) : [];
const runs = all.filter(isRun);
const byType = new Map<string, number>();
for (const a of all) byType.set(String(a.type ?? "未知"), (byType.get(String(a.type ?? "未知")) ?? 0) + 1);
report(
  "GET /athlete/{id}/activities",
  `最近 ${days} 天共 ${all.length} 筆（${[...byType].map(([t, n]) => `${t} ${n}`).join("、") || "無"}），以下只統計跑步`,
  acts,
  runs,
);

const latest = runs[0];
const runId = latest ? encodeURIComponent(String(latest.id)) : null;
if (runId) {
  report("GET /activity/{id}?intervals=true", "最新一筆跑步，含分段（icu_intervals）", await get(`/activity/${runId}`, { intervals: true }));
  report("GET /activity/{id}/hr-load-model", "", await get(`/activity/${runId}/hr-load-model`));
  report(
    "GET /activity/{id}/best-efforts",
    "最新一筆跑步中最快的 1 km（stream=velocity_smooth）",
    await get(`/activity/${runId}/best-efforts`, { stream: "velocity_smooth", distance: 1000, count: 3 }),
  );
} else {
  print(`## 單筆活動\n最近 ${days} 天沒有跑步，略過單筆活動的端點\n`);
}

// 最佳表現曲線與臨界速度
report(
  "GET /athlete/{id}/pace-curves.json",
  "跑步的最佳配速曲線，最近 90 天與 1 年，附臨界速度模型（pmType=CS）",
  await get(`${athlete}/pace-curves.json`, { type: "Run", curves: "90d,1y", pmType: "CS" }),
);
report("GET /athlete/{id}/hr-curves.json", "跑步的最佳心率曲線，最近 90 天", await get(`${athlete}/hr-curves.json`, { type: "Run", curves: "90d" }));

// 恢復、體能與疲勞
report("GET /athlete/{id}/wellness", `最近 ${days} 天`, await get(`${athlete}/wellness`, { oldest, newest: today }));
report(
  "GET /athlete/{id}/athlete-summary.json",
  `最近 ${days} 天的週摘要（體能、疲勞、狀態、各區間時間）`,
  await get(`${athlete}/athlete-summary.json`, { start: oldest, end: today }),
);

// 行事曆與計畫
report(
  "GET /athlete/{id}/events",
  `行事曆：往前 ${days} 天到往後 28 天（課表、比賽、筆記），resolve=true 換算目標`,
  await get(`${athlete}/events`, { oldest, newest: addDays(today, 28), resolve: true }),
);
report("GET /athlete/{id}/training-plan", "是否套用了 Intervals.icu 的訓練計畫", await get(`${athlete}/training-plan`));
report(
  "GET /athlete/{id}/activities/interval-search",
  "有 2～20 分鐘、閾值 85～120% 分段的活動，最多 5 筆",
  await get(`${athlete}/activities/interval-search`, { minSecs: 120, maxSecs: 1200, minIntensity: 85, maxIntensity: 120, limit: 5 }),
);
if (runSettings?.id !== undefined) {
  report(
    "GET /athlete/{id}/sport-settings/{id}/pace_distances",
    "跑步的最佳努力距離",
    await get(`${athlete}/sport-settings/${encodeURIComponent(String(runSettings.id))}/pace_distances`),
  );
}

function omit(obj: Record<string, unknown>, key: string): Record<string, unknown> {
  const { [key]: _, ...rest } = obj;
  return rest;
}

const dir = "data/intervals-fields";
mkdirSync(dir, { recursive: true });
const file = `${dir}/fields-${today}.md`;
writeFileSync(file, `${out.join("\n")}\n`);
console.error(`\n已寫到 ${file}（不進版控）。貼給別人之前請先看過一次。`);
