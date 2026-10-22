/**
 * 查 Intervals.icu 上的活動是從哪裡來的（Garmin 連線、上傳的檔案、Strava…），以及每個月有幾筆，
 * 用來確認從 Garmin 匯入的舊資料缺了哪一段（規格 12.9）.
 *
 * 只讀不寫，用自己的 API key 在本機執行：
 *   INTERVALS_API_KEY=... npx tsx tools/intervals-sources.ts
 * 目前目錄有 .env（INTERVALS_API_KEY、INTERVALS_ATHLETE_ID）時會自動讀取。
 * 選項：
 *   --since 2015     從哪一年查起（預設 2015）
 * 結果印在終端機，也寫到 data/intervals-sources/（不進版控）。
 *
 * 輸出不含個人資訊：只印日期（年月）、筆數，以及來源、檔案格式、裝置型號、運動類型這類列舉值；
 * 活動名稱、說明、id 與數據一律不印。貼給別人之前仍請自己看過一次。
 * 設定 INTERVALS_BASE_URL 可以指向其他位址（例如模擬服務）。
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({ options: { since: { type: "string", default: "2015" } } });
const sinceYear = Math.min(new Date().getFullYear(), Math.max(2000, Number(args.since) || 2015));

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

type Raw = Record<string, unknown>;

const out: string[] = [];
const print = (line = "") => {
  console.log(line);
  out.push(line);
};

/** 列舉值才印：太長或像名稱的文字不印 */
const label = (value: unknown, fallback: string) => {
  const text = typeof value === "string" ? value.trim() : "";
  return text && text.length <= 40 ? text : fallback;
};

async function activities(oldest: string, newest: string): Promise<Raw[]> {
  const url = new URL(`${baseUrl}/athlete/${athleteId}/activities`);
  url.searchParams.set("oldest", oldest);
  url.searchParams.set("newest", newest);
  const res = await fetch(url, {
    headers: { Authorization: `Basic ${btoa(`API_KEY:${apiKey}`)}`, Accept: "application/json" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const hint = res.status === 401 || res.status === 403 ? "（請確認 API key 與 Athlete ID）" : "";
    throw new Error(`Intervals.icu 回應 ${res.status}${hint}`);
  }
  const body: unknown = await res.json();
  return Array.isArray(body) ? (body as Raw[]) : [];
}

// 本機時區的今天（sv-SE 的日期格式就是 YYYY-MM-DD）
const today = new Date().toLocaleDateString("sv-SE");
const all: Raw[] = [];
for (let year = Number(today.slice(0, 4)); year >= sinceYear; year--) {
  const oldest = `${year}-01-01`;
  const newest = year === Number(today.slice(0, 4)) ? today : `${year}-12-31`;
  process.stderr.write(`讀取 ${year} 年…\r`);
  all.push(...(await activities(oldest, newest)));
}
process.stderr.write("\n");

interface Row {
  month: string;
  source: string;
  type: string;
  fileType: string;
  device: string;
  /** Intervals.icu 不經 API 提供內容（從 Strava 匯入的） */
  stub: boolean;
}

const rows: Row[] = all
  .map((a) => {
    const start = typeof a.start_date_local === "string" ? a.start_date_local : "";
    const stub = (typeof a._note === "string" && a._note !== "") || (String(a.source ?? "").toUpperCase() === "STRAVA" && a.distance == null && a.moving_time == null);
    return {
      month: start.slice(0, 7),
      source: label(a.source, "（沒有標示）"),
      type: label(a.type, stub ? "（拿不到）" : "（沒有標示）"),
      fileType: label(a.file_type, "—"),
      device: label(a.device_name, "—"),
      stub,
    };
  })
  .filter((r) => /^\d{4}-\d{2}$/.test(r.month))
  .sort((a, b) => a.month.localeCompare(b.month));

const count = <T>(items: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of items) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};

print(`# Intervals.icu 的活動來源（${today}，從 ${sinceYear} 年查起）`);
print();
if (!rows.length) {
  print("沒有找到任何活動。");
} else {
  print(`共 ${rows.length} 筆，最早 ${rows[0]!.month}，最新 ${rows.at(-1)!.month}。`);
  const stubs = rows.filter((r) => r.stub).length;
  if (stubs) print(`其中 ${stubs} 筆是 Intervals.icu 不經 API 提供內容的（從 Strava 匯入的），我們的 App 讀不到。`);
  print();

  print("## 依來源");
  print();
  print("| 來源 | 筆數 | 最早 | 最晚 | 檔案格式 | 裝置 |");
  print("|---|---|---|---|---|---|");
  for (const [source, n] of count(rows, (r) => r.source)) {
    const of = rows.filter((r) => r.source === source);
    const files = count(of, (r) => r.fileType).map(([k, c]) => `${k} ${c}`).join("、");
    const devices = count(of, (r) => r.device).slice(0, 4).map(([k, c]) => `${k} ${c}`).join("、");
    print(`| ${source} | ${n} | ${of[0]!.month} | ${of.at(-1)!.month} | ${files} | ${devices} |`);
  }
  print();

  print("## 依類型");
  print();
  print(count(rows, (r) => r.type).map(([k, c]) => `${k} ${c}`).join("、"));
  print();

  // 從最早一筆到今天的每個月：沒有活動的月份也列出，才看得出缺了哪一段
  print("## 每個月（跑步／全部，後面是來源）");
  print();
  const sources = count(rows, (r) => r.source).map(([k]) => k);
  print(`| 月份 | 跑步 | 全部 | ${sources.join(" | ")} |`);
  print(`|---|---|---|${sources.map(() => "---").join("|")}|`);
  for (let month = rows[0]!.month; month <= today.slice(0, 7); month = nextMonth(month)) {
    const of = rows.filter((r) => r.month === month);
    const runs = of.filter((r) => r.type.toLowerCase().includes("run")).length;
    const bySource = sources.map((s) => of.filter((r) => r.source === s).length || "");
    print(`| ${month} | ${runs || "—"} | ${of.length || "—"} | ${bySource.join(" | ")} |`);
  }
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

const dir = "data/intervals-sources";
mkdirSync(dir, { recursive: true });
const file = `${dir}/${today}.md`;
writeFileSync(file, `${out.join("\n")}\n`);
console.error(`\n已寫到 ${file}`);
