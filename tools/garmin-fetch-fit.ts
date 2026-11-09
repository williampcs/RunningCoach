/**
 * 作者自用：用 Garmin Connect 個人 API 抓自己最近 N 天的活動原始檔（zip 裡的 FIT），存到 data/garmin-fit/（不進版控），
 * 之後在網頁版的紀錄頁「匯入檔案」選那個資料夾裡的檔案（規格 12.40「讀 FIT 檔」）.
 *
 *   npx tsx tools/garmin-fetch-fit.ts              最近 30 天
 *   npx tsx tools/garmin-fetch-fit.ts --days 365   最近一年（已經下載過的不重抓）
 *   選項：--out data/garmin-fit（存放的資料夾）、--types running,cycling（只抓這些活動類型，預設全部）
 *
 * 條款（Garmin Connect 個人 API 補充條款，2026-10-01 版；規格 12.40）：
 * - key 屬於你個人，只能由你本人用在「為你自己的用途而開發或操作」的工具上；這支腳本在你自己的電腦跑、抓你自己的資料，符合這個用途.
 * - 不要把 key 交給任何人（包括貼到對話、寫進檔案、放進別人的 App 或伺服器）；不得販售、轉讓、再授權、發佈、揭露或分享.
 * - Garmin 可以設用量限制；違反條款會被停權、撤銷 key. 這支腳本每抓一個檔停 1 秒，不要改成大量並行.
 * - 個人 API「不是給服務多位使用者的商業 App」：不要把這支腳本做成給別人用的服務.
 *
 * key 放在 repo 根目錄的 .env：GARMIN_PERSONAL_API_KEY=...（.env 不進版控）. key 與 token 不印出、不寫進檔案.
 * 抓下來的檔是你自己的訓練資料：只放在 data/garmin-fit/（不進版控），不要 commit、不要上傳到雲端的開發環境.
 * 端點與做法照 tools/garmin-personal-api.ts 的測試結果：換 token 只帶 Authorization、回應是純文字的 token、
 * 資料端點用 Bearer、下載端點 /download-service/files/activity/{id} 回 zip.
 * 指向其他位址（例如模擬服務）：GARMIN_TOKEN_URL、GARMIN_API_BASE.
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { API_BASE, TOKEN_URL } from "./garmin-personal-api";

export const TERMS = `Garmin 個人 API 的條款（補充條款 2026-10-01 版）：key 只能由你本人用在為自己的用途開發或操作的工具上，
不得販售、轉讓、再授權、發佈、揭露或分享給任何人；Garmin 可以設用量限制，違反會停權、撤銷 key。
這支腳本在你自己的電腦抓你自己的資料；不要把 key 交給別人，也不要把這支腳本做成給別人用的服務。`;

export interface FetchOptions {
  apiKey: string;
  fetch?: typeof fetch;
  tokenUrl?: string;
  apiBase?: string;
  /** 本機的今天 YYYY-MM-DD */
  today: string;
  days: number;
  outDir: string;
  /** 只抓這些活動類型（Garmin 的 typeKey，例：running）；空的是全部 */
  types?: string[];
  /** 每抓一個檔停多久（毫秒） */
  delayMs?: number;
  log?: (line: string) => void;
}

export interface FetchResult {
  listed: number;
  downloaded: number;
  skipped: number;
  failed: number;
}

/** 列活動一次查的天數（文件沒寫上限，保守一點） */
const WINDOW_DAYS = 28;
const PAGE = 99;

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GarminError extends Error {}

/** 用 key 換 24 小時的 access token（回應是純文字的 token；官方的 cURL 範例只帶 Authorization） */
export async function accessToken(f: typeof fetch, tokenUrl: string, apiKey: string): Promise<string> {
  const res = await f(tokenUrl, { method: "POST", headers: { Authorization: `ApiKey ${apiKey}`, Accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
  const text = (await res.text()).trim();
  if (res.status === 401 || res.status === 403) throw new GarminError("換 token 失敗：key 不對、過期或被刪了（到 Garmin Connect 的帳號設定重新產生）");
  if (!res.ok || !text) throw new GarminError(`換 token 失敗（HTTP ${res.status}）`);
  // 回應可能是純文字的 token，也可能是 JSON
  try {
    const body = JSON.parse(text) as unknown;
    if (typeof body === "string") return body;
    if (body && typeof body === "object") {
      const found = Object.entries(body).find(([k, v]) => typeof v === "string" && /token/i.test(k));
      if (found) return found[1] as string;
    }
  } catch {
    // 不是 JSON：本文就是 token
  }
  return text.replace(/^"|"$/g, "");
}

interface ListedActivity {
  id: string;
  date: string;
  type: string;
}

/** 檔名：日期_類型_活動 id.zip（只在你的電腦上） */
export const fileNameOf = (a: ListedActivity) => `${a.date}_${a.type.replace(/[^a-z0-9_-]/gi, "") || "activity"}_${a.id}.zip`;

export async function fetchFits(o: FetchOptions): Promise<FetchResult> {
  const f = o.fetch ?? fetch;
  const base = (o.apiBase ?? API_BASE).replace(/\/$/, "");
  const log = o.log ?? (() => {});
  const result: FetchResult = { listed: 0, downloaded: 0, skipped: 0, failed: 0 };
  const token = await accessToken(f, o.tokenUrl ?? TOKEN_URL, o.apiKey);
  const auth = { Authorization: `Bearer ${token}` };

  // 1. 列活動：每 28 天一段、每段分頁
  const activities: ListedActivity[] = [];
  const oldest = addDays(o.today, -(o.days - 1));
  for (let from = oldest; from <= o.today; from = addDays(from, WINDOW_DAYS)) {
    const to = addDays(from, WINDOW_DAYS - 1) < o.today ? addDays(from, WINDOW_DAYS - 1) : o.today;
    for (let start = 0; ; start += PAGE) {
      const url = `${base}/activitylist-service/activities/search/activities?startDate=${from}&endDate=${to}&start=${start}&limit=${PAGE}`;
      const res = await f(url, { headers: { ...auth, Accept: "application/json" }, signal: AbortSignal.timeout(60_000) });
      if (res.status === 401 || res.status === 403) throw new GarminError("列活動被拒（token 過期或沒有權限）");
      if (res.status === 429) throw new GarminError("Garmin 說請求太多了（429）：過一陣子再跑");
      if (!res.ok) throw new GarminError(`列活動失敗（HTTP ${res.status}）`);
      const page = (await res.json()) as unknown;
      const list = Array.isArray(page) ? page : [];
      for (const a of list as Record<string, unknown>[]) {
        const id = a.activityId != null ? String(a.activityId) : "";
        if (!/^\d+$/.test(id)) continue;
        const type = String((a.activityType as { typeKey?: unknown } | undefined)?.typeKey ?? "");
        const date = String(a.startTimeLocal ?? a.startTimeGMT ?? "").slice(0, 10);
        activities.push({ id, type, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "unknown" });
      }
      if (list.length < PAGE) break;
      await sleep(o.delayMs ?? 1000);
    }
  }
  const wanted = activities.filter((a) => !o.types?.length || o.types.includes(a.type));
  result.listed = wanted.length;
  log(`最近 ${o.days} 天有 ${activities.length} 個活動${o.types?.length ? `，其中 ${wanted.length} 個是 ${o.types.join("、")}` : ""}`);

  // 2. 下載原始檔（已經有的不重抓）
  mkdirSync(o.outDir, { recursive: true });
  const have = new Set(readdirSync(o.outDir).map((name) => /_(\d+)\.zip$/.exec(name)?.[1]).filter(Boolean));
  for (const a of wanted) {
    if (have.has(a.id)) {
      result.skipped++;
      continue;
    }
    const res = await f(`${base}/download-service/files/activity/${a.id}`, { headers: { ...auth, Accept: "*/*" }, signal: AbortSignal.timeout(120_000) });
    if (res.status === 429) throw new GarminError(`Garmin 說請求太多了（429）：已下載 ${result.downloaded} 個，過一陣子再跑會從沒抓到的繼續`);
    if (!res.ok) {
      result.failed++;
      log(`  ${a.date} ${a.type}：下載失敗（HTTP ${res.status}）`);
      continue;
    }
    const data = Buffer.from(await res.arrayBuffer());
    const zip = data.length >= 4 && data.readUInt32LE(0) === 0x04034b50;
    const fit = data.length >= 12 && data.toString("ascii", 8, 12) === ".FIT";
    if (!zip && !fit) {
      result.failed++;
      log(`  ${a.date} ${a.type}：回來的不是 zip 或 FIT`);
      continue;
    }
    writeFileSync(join(o.outDir, fit ? fileNameOf(a).replace(/\.zip$/, ".fit") : fileNameOf(a)), data);
    result.downloaded++;
    log(`  ${a.date} ${a.type}：已下載`);
    await sleep(o.delayMs ?? 1000);
  }
  return result;
}

async function main() {
  const { values: args } = parseArgs({
    options: { days: { type: "string", default: "30" }, out: { type: "string", default: "data/garmin-fit" }, types: { type: "string", default: "" } },
  });
  if (!process.env.GARMIN_PERSONAL_API_KEY && existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  console.log(TERMS, "\n");
  const apiKey = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  if (!apiKey) {
    console.error("找不到 GARMIN_PERSONAL_API_KEY：在 repo 根目錄的 .env 加一行 GARMIN_PERSONAL_API_KEY=你的 key（不要貼到對話）。");
    process.exit(1);
  }
  const outDir = args.out!;
  const result = await fetchFits({
    apiKey,
    tokenUrl: process.env.GARMIN_TOKEN_URL?.trim() || TOKEN_URL,
    apiBase: process.env.GARMIN_API_BASE?.trim() || API_BASE,
    today: new Date().toLocaleDateString("sv-SE"),
    days: Math.min(3650, Math.max(1, Number(args.days) || 30)),
    outDir,
    types: args.types ? args.types.split(",").map((s) => s.trim()).filter(Boolean) : [],
    log: (line) => console.log(line),
  });
  console.log(
    `\n完成：下載 ${result.downloaded} 個，已經有的 ${result.skipped} 個${result.failed ? `，失敗 ${result.failed} 個` : ""}。` +
      `\n檔案在 ${outDir}/（不進版控）。到網頁版的「紀錄」→「匯入檔案」，選這個資料夾裡的檔案（可以一次全選）。`,
  );
}

if (process.argv[1] && /garmin-fetch-fit\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
