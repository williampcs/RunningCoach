/**
 * Garmin Connect 個人 API（Personal API）的可行性測試（KI-048、規格 12.40）. 只讀，用你自己的 key 在你的電腦上執行：
 *
 *   npx tsx tools/garmin-personal-api.ts            測 API（換 token、活動、FIT、健康資料）與 CORS 的回應標頭
 *   npx tsx tools/garmin-personal-api.ts --serve    另外開一個本機網頁（http://localhost:8790/），從瀏覽器直接呼叫，看 CORS 允不允許
 *
 * key 放在 repo 根目錄的 .env：GARMIN_PERSONAL_API_KEY=...（.env 不進版控）。key 與 token 不印出、不寫進檔案.
 * 選項：--days 30（列活動的天數，預設 30）、--port 8790（--serve 的埠）.
 * 結果印在終端機，也寫到 data/garmin-personal-api/（不進版控）。報告只有：HTTP 狀態、筆數、欄位名稱與型別、
 * 活動類型（例：running）、FIT 裡的訊息與欄位名稱與有值的筆數、CORS 的回應標頭；不含任何數值、日期、id、名稱或位置.
 * 貼給協調 session 之前仍請自己看過一次.
 *
 * 依據：Garmin 開發者網站的 Personal API 說明、FAQ 與 Swagger（2026-11-09 讀的，見下面 TERMS 與規格 12.40）.
 * 文件沒寫、這支腳本要實測的：換 token 的回應欄位、資料端點的驗證方式（先試 Bearer）、CORS、速率限制.
 * 指向其他位址（例如模擬服務）：GARMIN_TOKEN_URL、GARMIN_API_BASE.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { fitFieldSummary, fitFromDownload, type FitMessageSummary } from "./lib/fit";

export const TOKEN_URL = "https://personal.connectapi.garmin.com/personalapitoken-service/personal-api/personal-api-key/token";
export const API_BASE = "https://personal.connectapi.garmin.com";

/** 條款與限制（Garmin 開發者網站的 Personal API 頁與 FAQ，2026-11-09）；報告的開頭也印這段 */
export const TERMS = `Garmin 個人 API 的條款與限制（developer.garmin.com 的 Personal API 說明與 FAQ，2026-11-09 讀的）：
- 用途：給「想用自己的 Garmin 資料做個人 App」的人；「不是給服務多位使用者的商業 App」。
- key 要像密碼一樣保管；只顯示一次，弄丟要刪掉重建；可以隨時刪除，刪了之後 key 與換到的 token 都不能用。
- key 的效期 30 天、90 天、180 天或 1 年；到期前約一週 Garmin 會寄信。
- access token 24 小時有效（或到 key 過期，看哪個先到）；沒有 refresh token，過期再用 key 換一個。
- 只能讀（只有 GET）；資料用拉的（Pull），沒有推送。
- 條款全文只在 Garmin Connect 產生 key 的頁面上（開發者網站沒有）：產生 key 時請把條款存一份，特別看「能不能把 key 用在別人開發的 App」「資料能不能存」「要不要標示 Garmin」。
- 文件沒寫的（待確認）：速率限制、CORS（瀏覽器能不能直接呼叫）、換 token 的回應格式、資料端點的驗證方式。`;

type Json = unknown;

export interface CorsInfo {
  preflightStatus: number | null;
  allowOrigin: string | null;
  allowMethods: string | null;
  allowHeaders: string | null;
  allowCredentials: string | null;
  /** 實際請求（帶 Origin）的回應裡的 Access-Control-Allow-Origin */
  responseAllowOrigin: string | null;
}

export interface Step {
  name: string;
  /** 方法與路徑（查詢參數只列名稱） */
  request: string;
  status: number | null;
  ok: boolean;
  notes: string[];
  /** 欄位名稱與型別 */
  shape?: string[];
  cors?: CorsInfo;
}

export interface ProbeResult {
  when: string;
  steps: Step[];
  /** 資料端點用哪一種驗證成功（Bearer token 或直接用 key） */
  auth: string | null;
  fit: FitMessageSummary[] | null;
}

export interface ProbeOptions {
  apiKey: string;
  fetch?: typeof fetch;
  tokenUrl?: string;
  apiBase?: string;
  /** 本機的今天 YYYY-MM-DD */
  today: string;
  days?: number;
  /** CORS 檢查用的來源（--serve 的網頁的網址） */
  origin?: string;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** 路徑與查詢參數的名稱（不印參數的值：日期、id） */
function describeRequest(method: string, url: string): string {
  const u = new URL(url);
  const path = u.pathname.replace(/\/\d{4}-\d{2}-\d{2}/g, "/{日期}").replace(/\/\d{5,}/g, "/{id}");
  const params = [...u.searchParams.keys()];
  return `${method} ${u.host}${path}${params.length ? `?${params.join("&")}` : ""}`;
}

const typeOf = (v: unknown): string => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

/** 欄位名稱與型別（第二層的物件列出欄位名稱）；不含任何值 */
export function shapeOf(value: Json, depth = 2): string[] {
  if (Array.isArray(value)) {
    const keys = new Map<string, Set<string>>();
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        for (const [k, v] of Object.entries(item)) (keys.get(k) ?? keys.set(k, new Set()).get(k)!).add(typeOf(v));
      }
    }
    if (!keys.size) return [`陣列 ${value.length} 筆（${[...new Set(value.map(typeOf))].join("、") || "空的"}）`];
    return [`陣列 ${value.length} 筆，每筆的欄位：`, ...[...keys].sort(([a], [b]) => a.localeCompare(b)).map(([k, t]) => `  ${k}: ${[...t].join("|")}`)];
  }
  if (value && typeof value === "object") {
    return Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => {
        if (depth > 1 && v && typeof v === "object" && !Array.isArray(v)) return `${k}: object { ${Object.keys(v).sort().join(", ")} }`;
        if (Array.isArray(v)) return `${k}: array（${v.length} 筆）`;
        return `${k}: ${typeOf(v)}`;
      });
  }
  return [typeOf(value)];
}

/** 把錯誤訊息裡可能出現的 key、token 換掉 */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join("***");
  return out.slice(0, 200);
}

async function corsOf(f: typeof fetch, url: string, method: string, origin: string): Promise<CorsInfo> {
  const info: CorsInfo = { preflightStatus: null, allowOrigin: null, allowMethods: null, allowHeaders: null, allowCredentials: null, responseAllowOrigin: null };
  try {
    const res = await f(url, {
      method: "OPTIONS",
      headers: { Origin: origin, "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization" },
      signal: AbortSignal.timeout(20_000),
    });
    info.preflightStatus = res.status;
    info.allowOrigin = res.headers.get("access-control-allow-origin");
    info.allowMethods = res.headers.get("access-control-allow-methods");
    info.allowHeaders = res.headers.get("access-control-allow-headers");
    info.allowCredentials = res.headers.get("access-control-allow-credentials");
  } catch {
    // 連不上：留 null
  }
  return info;
}

/** 照順序測：換 token → 列活動 → 一趟的細節 → 下載 FIT → 睡眠、每日摘要、HRV、心率；每一步失敗不影響下一步（需要 token 的除外） */
export async function probe(options: ProbeOptions): Promise<ProbeResult> {
  const f = options.fetch ?? fetch;
  const tokenUrl = options.tokenUrl ?? TOKEN_URL;
  const base = (options.apiBase ?? API_BASE).replace(/\/+$/, "");
  const origin = options.origin ?? "http://localhost:8790";
  const days = options.days ?? 30;
  const { today, apiKey } = options;
  const secrets = [apiKey];
  const steps: Step[] = [];
  const result: ProbeResult = { when: new Date().toISOString().slice(0, 10), steps, auth: null, fit: null };

  // 1. 換 token
  const tokenStep: Step = { name: "用 key 換 access token", request: describeRequest("POST", tokenUrl), status: null, ok: false, notes: [] };
  steps.push(tokenStep);
  let token: string | null = null;
  try {
    // 照官方的 cURL 範例只帶 Authorization：帶 Accept: application/json 時 Garmin 回 406（2026-11-09 使用者實測）
    const res = await f(tokenUrl, { method: "POST", headers: { Authorization: `ApiKey ${apiKey}`, Accept: "*/*" }, signal: AbortSignal.timeout(20_000) });
    tokenStep.status = res.status;
    tokenStep.notes.push(`Content-Type：${res.headers.get("content-type") ?? "（沒有）"}`);
    const text = await res.text();
    let body: Json = null;
    try {
      body = JSON.parse(text);
    } catch {
      tokenStep.notes.push(`回應不是 JSON（${text.length} 個字元）`);
    }
    if (body && typeof body === "object") {
      tokenStep.shape = shapeOf(body, 1);
      const entries = Object.entries(body as Record<string, unknown>);
      const field = entries.find(([k, v]) => typeof v === "string" && /^access_?token$/i.test(k)) ?? entries.find(([k, v]) => typeof v === "string" && /token/i.test(k));
      if (field) {
        token = field[1] as string;
        secrets.push(token);
        tokenStep.notes.push(`token 在「${field[0]}」欄位（${token.split(".").length === 3 ? "看起來是 JWT" : "不是 JWT 的格式"}）`);
      }
      const expiry = entries.filter(([k]) => /expir|ttl|valid/i.test(k)).map(([k]) => k);
      tokenStep.notes.push(expiry.length ? `效期的欄位：${expiry.join("、")}` : "回應沒有效期的欄位（說明寫 24 小時）");
    } else if (res.ok && text.trim() && !text.trim().startsWith("<")) {
      // 回應可能就是 token 本身
      token = text.trim().replace(/^"|"$/g, "");
      secrets.push(token);
      tokenStep.notes.push("回應的本文就是 token（不是 JSON 物件）");
    }
    tokenStep.ok = res.ok && token !== null;
    if (!res.ok) tokenStep.notes.push(res.status === 401 || res.status === 403 ? "key 不對、過期或被刪了" : res.status === 406 ? "換 token 失敗（406：伺服器不接受請求的格式）" : "換 token 失敗");
  } catch (e) {
    tokenStep.notes.push(`連線失敗：${scrub(e instanceof Error ? e.message : String(e), secrets)}`);
  }
  tokenStep.cors = await corsOf(f, tokenUrl, "POST", origin);

  // 資料端點的驗證：說明只寫「OAuth2 access token」，先試 Bearer；不行再試直接用 key
  const authHeaders: [string, string][] = [];
  if (token) authHeaders.push(["Bearer token", `Bearer ${token}`]);
  authHeaders.push(["直接用 key（ApiKey）", `ApiKey ${apiKey}`]);

  async function get(name: string, path: string, read: "json" | "bytes" = "json"): Promise<{ step: Step; body: Json; bytes: Buffer | null }> {
    const url = `${base}${path}`;
    const step: Step = { name, request: describeRequest("GET", url), status: null, ok: false, notes: [] };
    steps.push(step);
    let body: Json = null;
    let bytes: Buffer | null = null;
    const tries = result.auth ? authHeaders.filter(([label]) => label === result.auth) : authHeaders;
    for (const [label, header] of tries) {
      try {
        const res = await f(url, { headers: { Authorization: header, Accept: read === "json" ? "application/json" : "*/*", Origin: origin }, signal: AbortSignal.timeout(60_000) });
        step.status = res.status;
        if (res.status === 401 && !result.auth) {
          step.notes.push(`${label}：401`);
          continue;
        }
        result.auth ??= res.ok ? label : null;
        step.ok = res.ok;
        step.cors = { preflightStatus: null, allowOrigin: null, allowMethods: null, allowHeaders: null, allowCredentials: null, responseAllowOrigin: res.headers.get("access-control-allow-origin") };
        step.notes.push(`Content-Type：${res.headers.get("content-type") ?? "（沒有）"}`);
        if (res.status === 204) {
          step.notes.push("204：這段期間沒有資料");
        } else if (read === "bytes") {
          bytes = Buffer.from(await res.arrayBuffer());
          step.notes.push(`大小：約 ${Math.max(1, Math.round(bytes.length / 1024))} KB`);
        } else {
          const text = await res.text();
          try {
            body = JSON.parse(text);
            step.shape = shapeOf(body);
          } catch {
            step.notes.push(`回應不是 JSON（${text.length} 個字元）`);
          }
        }
        if (res.status === 429) step.notes.push("429：超過速率限制");
        if (res.status === 403) step.notes.push("403：沒有權限讀這類資料");
        break;
      } catch (e) {
        step.notes.push(`${label}：連線失敗（${scrub(e instanceof Error ? e.message : String(e), secrets)}）`);
      }
    }
    return { step, body, bytes };
  }

  const from = addDays(today, -(days - 1));
  const week = addDays(today, -6);
  const yesterday = addDays(today, -1);

  // 2. 列活動
  const list = await get("列最近的活動", `/activitylist-service/activities/search/activities?startDate=${from}&endDate=${today}&start=0&limit=50`);
  const activities = Array.isArray(list.body) ? (list.body as Record<string, unknown>[]) : [];
  if (Array.isArray(list.body)) {
    const typeKey = (a: Record<string, unknown>) => {
      const t = a.activityType as Record<string, unknown> | string | undefined;
      const key = typeof t === "string" ? t : typeof t?.typeKey === "string" ? t.typeKey : "（沒有類型）";
      return key.length <= 40 ? key : "（類型太長）";
    };
    const counts = new Map<string, number>();
    for (const a of activities) counts.set(typeKey(a), (counts.get(typeKey(a)) ?? 0) + 1);
    list.step.notes.push(`最近 ${days} 天 ${activities.length} 筆${activities.length === 50 ? "（只拿第一頁 50 筆）" : ""}；類型：${[...counts].map(([k, n]) => `${k} ${n}`).join("、") || "—"}`);
    const withHr = activities.filter((a) => typeof a.averageHR === "number").length;
    list.step.notes.push(`有平均心率（averageHR）的：${withHr} 筆`);
  }

  // 3. 一趟跑步的細節與 FIT（沒有跑步就用第一筆）
  const pick =
    activities.find((a) => JSON.stringify(a.activityType ?? "").toLowerCase().includes("running")) ?? activities[0];
  const id = pick && (typeof pick.activityId === "number" || typeof pick.activityId === "string") ? String(pick.activityId) : null;
  if (id) {
    await get("一趟活動的細節", `/activity-service/activity/${encodeURIComponent(id)}`);
    const download = await get("下載這趟的原始檔（FIT）", `/download-service/files/activity/${encodeURIComponent(id)}`, "bytes");
    if (download.bytes) {
      const fit = fitFromDownload(download.bytes);
      download.step.notes.push(download.bytes.readUInt32LE(0) === 0x04034b50 ? "是 zip" : "不是 zip");
      if (!fit) download.step.notes.push("找不到 FIT 檔（可能是 TCX、GPX 或其他格式）");
      else {
        result.fit = fitFieldSummary(fit);
        download.step.notes.push(result.fit ? `讀得懂：${result.fit.length} 種訊息` : "是 FIT，但讀不懂");
      }
    }
  } else {
    steps.push({ name: "一趟活動的細節與 FIT", request: "—", status: null, ok: false, notes: ["沒有活動或沒有 activityId，略過"] });
  }

  // 4. 健康資料
  const sleep = await get("睡眠（最近 7 天）", `/sleep-service/sleep/dailySleepSummariesByDate?startDate=${week}&endDate=${today}`);
  if (Array.isArray(sleep.body)) sleep.step.notes.push(`${sleep.body.length} 天`);
  const daily = await get("每日摘要（昨天）", `/usersummary-service/usersummary/daily?calendarDate=${yesterday}`);
  if (daily.body && typeof daily.body === "object") {
    const rhr = (daily.body as Record<string, unknown>).restingHeartRate;
    daily.step.notes.push(`靜止心率（restingHeartRate）：${typeof rhr === "number" ? "有" : "沒有"}`);
  }
  await get("每日摘要（最近 7 天）", `/usersummary-service/v2/dailysummaries?startDate=${week}&endDate=${today}`);
  const heart = await get("心率（昨天）", `/wellness-service/wellness/dailyHeartRate?date=${yesterday}`);
  if (heart.body && typeof heart.body === "object") {
    const b = heart.body as Record<string, unknown>;
    heart.step.notes.push(`靜止心率：${typeof b.restingHeartRate === "number" ? "有" : "沒有"}；心率的時間序列：${Array.isArray(b.heartRateValues) ? `${b.heartRateValues.length} 筆` : "沒有"}`);
  }
  const hrv = await get("HRV（最近 7 天）", `/hrv-service/hrv/daily/${week}/${today}`);
  void hrv;

  // CORS：列活動的預檢
  const listStep = steps.find((s) => s.name === "列最近的活動");
  if (listStep) {
    const pre = await corsOf(f, `${base}/activitylist-service/activities/search/activities?limit=1`, "GET", origin);
    listStep.cors = { ...pre, responseAllowOrigin: listStep.cors?.responseAllowOrigin ?? null };
  }
  return result;
}

function corsVerdict(c: CorsInfo | undefined, origin: string): string {
  if (!c) return "沒有測";
  // 沒有做預檢的（只看實際回應的標頭）
  if (c.preflightStatus === null && !c.allowOrigin) return `實際回應的 Allow-Origin：${c.responseAllowOrigin ?? "—"}`;
  const allowsOrigin = (v: string | null) => v === "*" || v === origin;
  const pre = c.preflightStatus === null ? "預檢連不上" : `預檢 ${c.preflightStatus}`;
  const headersOk = !!c.allowHeaders && /authorization|\*/i.test(c.allowHeaders);
  const verdict =
    allowsOrigin(c.allowOrigin) && headersOk ? "瀏覽器應該可以直接呼叫（還要用 --serve 的網頁確認）" : c.allowOrigin || c.responseAllowOrigin ? "有 CORS 標頭，但不允許這個來源或 Authorization 標頭" : "沒有 CORS 標頭：瀏覽器應該會擋下";
  return `${pre}；Allow-Origin：${c.allowOrigin ?? "—"}；Allow-Methods：${c.allowMethods ?? "—"}；Allow-Headers：${c.allowHeaders ?? "—"}；實際回應的 Allow-Origin：${c.responseAllowOrigin ?? "—"} → ${verdict}`;
}

/** FIT 欄位的摘要：只有名稱與筆數 */
function fitLines(fit: FitMessageSummary[]): string[] {
  const lines: string[] = [];
  for (const m of fit) {
    lines.push(`- ${m.name}（#${m.global}）${m.count} 筆${m.developerFields ? `；開發者欄位 ${m.developerFields} 次` : ""}`);
    const fields = m.fields.map((x) => `${x.name ?? `#${x.num}`} ${x.withValue}/${m.count}`);
    if (fields.length) lines.push(`  ${fields.join("、")}`);
  }
  const record = fit.find((m) => m.global === 20);
  const has = (n: number) => (record?.fields.find((x) => x.num === n)?.withValue ?? 0) > 0;
  if (record) {
    lines.push(
      `- 每秒的紀錄有：${[
        [3, "心率"], [0, "GPS"], [5, "距離"], [6, "速度"], [73, "速度（enhanced）"], [4, "步頻"], [7, "功率"], [2, "高度"], [78, "高度（enhanced）"], [39, "垂直振幅"], [41, "觸地時間"], [85, "步幅"],
      ]
        .filter(([n]) => has(n as number))
        .map(([, label]) => label)
        .join("、") || "（都沒有）"}`,
    );
  }
  return lines;
}

export function reportText(result: ProbeResult, origin = "http://localhost:8790"): string {
  const lines = [`# Garmin 個人 API 的可行性測試（${result.when}）`, "", "這份報告不含任何數值、日期、id、名稱或位置；只有狀態、筆數與欄位名稱。", "", TERMS, "", "## 每一步", ""];
  for (const s of result.steps) {
    lines.push(`### ${s.ok ? "✓" : "✗"} ${s.name}`, "", `- 請求：\`${s.request}\``, `- 狀態：${s.status ?? "—"}`);
    for (const n of s.notes) lines.push(`- ${n}`);
    if (s.cors && (s.cors.preflightStatus !== null || s.cors.responseAllowOrigin)) lines.push(`- CORS：${corsVerdict(s.cors, origin)}`);
    if (s.shape?.length) lines.push("- 欄位：", "", "```", ...s.shape.slice(0, 120), ...(s.shape.length > 120 ? [`…另有 ${s.shape.length - 120} 個`] : []), "```");
    lines.push("");
  }
  lines.push("## 資料端點的驗證方式", "", result.auth ? `成功：${result.auth}` : "沒有成功（見上面每一步的狀態）", "");
  lines.push("## FIT 檔的欄位", "", ...(result.fit ? fitLines(result.fit) : ["沒有下載到可以讀的 FIT 檔"]), "");
  lines.push(
    "## 結論（協調 session 看）",
    "",
    `- 換 token：${result.steps[0]?.ok ? "可以" : "不行"}`,
    `- 讀活動：${result.steps.find((s) => s.name === "列最近的活動")?.ok ? "可以" : "不行"}`,
    `- FIT：${result.fit ? "下載得到、讀得懂" : "沒有"}`,
    `- 健康資料：${result.steps.filter((s) => /睡眠|每日摘要|心率|HRV/.test(s.name) && s.ok).map((s) => s.name).join("、") || "都不行"}`,
    `- CORS（伺服器的回應標頭）：換 token ${corsVerdict(result.steps[0]?.cors, origin).split("→ ").pop()}；列活動 ${corsVerdict(result.steps.find((s) => s.name === "列最近的活動")?.cors, origin).split("→ ").pop()}`,
    "- 瀏覽器實際的結果：用 `--serve` 開的網頁測（結果另外貼）",
    "",
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// --serve：本機的 CORS 測試網頁
// ---------------------------------------------------------------------------

export function servePage(port: number, defaults: { tokenUrl: string; apiBase: string }): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(join(here, "garmin-cors-test.html"), "utf8")
    .replace("__TOKEN_URL__", defaults.tokenUrl)
    .replace("__API_BASE__", defaults.apiBase);
  createServer((req, res) => {
    if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(html);
    } else {
      res.writeHead(404).end();
    }
  }).listen(port, "127.0.0.1", () => {
    console.log(`CORS 測試網頁：http://localhost:${port}/ （用 Chrome 或 Safari 打開；按 Ctrl+C 結束）`);
  });
}

async function main() {
  const { values: args } = parseArgs({ options: { days: { type: "string", default: "30" }, serve: { type: "boolean", default: false }, port: { type: "string", default: "8790" } } });
  if (!process.env.GARMIN_PERSONAL_API_KEY && existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
  const tokenUrl = process.env.GARMIN_TOKEN_URL?.trim() || TOKEN_URL;
  const apiBase = process.env.GARMIN_API_BASE?.trim() || API_BASE;
  const port = Number(args.port) || 8790;
  const origin = `http://localhost:${port}`;
  const apiKey = process.env.GARMIN_PERSONAL_API_KEY?.trim();
  console.log(TERMS, "\n");
  if (!apiKey) {
    console.error("找不到 GARMIN_PERSONAL_API_KEY：在 repo 根目錄的 .env 加一行 GARMIN_PERSONAL_API_KEY=你的 key（不要貼到對話）。");
    if (!args.serve) process.exit(1);
  } else {
    const today = new Date().toLocaleDateString("sv-SE");
    const result = await probe({ apiKey, tokenUrl, apiBase, today, days: Math.min(365, Math.max(1, Number(args.days) || 30)), origin });
    const text = reportText(result, origin);
    console.log(text);
    const dir = "data/garmin-personal-api";
    mkdirSync(dir, { recursive: true });
    const file = `${dir}/report-${result.when}.md`;
    writeFileSync(file, text);
    console.log(`\n已寫到 ${file}（不含你的資料；貼給協調 session 前請看過一次）`);
  }
  if (args.serve) servePage(port, { tokenUrl, apiBase });
}

if (process.argv[1] && /garmin-personal-api\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}
