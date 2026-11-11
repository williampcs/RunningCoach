/**
 * 模型對照＋高風險問題的測試（規格 12.43）：同一組情境給幾個模型設定各跑一次，把回覆並排.
 *
 * 要真的 AI，用自己的 Anthropic API key 在本機執行（雲端 session 只用模擬上游）：
 *   npx tsx tools/model-eval.ts                 先印費用估算，不打 API
 *   npx tsx tools/model-eval.ts --yes           真的跑
 * 目前目錄有 .env（ANTHROPIC_API_KEY）時會自動讀取；key 不印出、不寫進報告.
 * 選項：
 *   --models opus,haiku-off      只跑這些模型設定（opus、sonnet、haiku-off、haiku-low、haiku-medium；預設全部）
 *   --scenarios chest-pain,高風險 只跑這些情境（id，或「一般」「高風險」一整組；預設全部）
 *   --features multisport        開這些功能開關（預設全關，和正式版一樣）
 *   --repeat 3                   同一個情境×模型跑幾次（預設 1；回覆有隨機性，看安全穩不穩定）
 *   --concurrency 1              同時送幾個（預設 1、最多 3）
 *   --mock                       改打模擬上游（npm run dev:mock，http://127.0.0.1:8788），不用 key、不花錢
 *   --list                       列出情境與模型設定
 * 設定 ANTHROPIC_BASE_URL 可以指向其他位址.
 *
 * 用自己的 key 直接打 Anthropic，不經免費試用的代理（不算進試用的額度）. 建議在 Anthropic Console 另建一把
 * 這個測試專用的 key，並設每月的花費上限. 忙碌或超過速率（429、529）時等一下再試、最多 3 次，還是不行就記成
 * 「送出失敗」（不算模型沒過）；key 無效或沒有權限（401、403）時整個停下來.
 *
 * 每個情境用假的選手資料（測試模式的假資料產生器＋情境的選手資料、課表、傷病、賽事），用核心的教練跑
 * （工具迴圈、檢查器、安全規則都是真的），不連 Intervals.icu 或天氣. 結果寫到 data/model-eval/〔日期-時間〕/（不進版控）：
 *   report.html  各模型的回覆並排、自動檢查、金額、秒數，可展開工具呼叫與存了什麼
 *   summary.md   只有統計（貼回來給協調 session）
 *   results.json 原始結果
 * 之後改了提示詞、教練方法、工具或換模型時重跑一次.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { AnthropicProvider, localDate, parseFeatures } from "../packages/core/src";

import { runChecks } from "./model-eval/checks";
import { checkModelConfig, ESTIMATE, estimateAll, MODEL_CONFIGS, pickModels, pickScenarios } from "./model-eval/models";
import { reportHtml, summarize, summaryMarkdown } from "./model-eval/report";
import { FatalApiError, runWithRetry } from "./model-eval/retry";
import { evalNow, runScenario } from "./model-eval/run";
import { SCENARIOS } from "./model-eval/scenarios";
import type { EvalResult, ModelConfig, Scenario } from "./model-eval/types";

const MOCK_URL = "http://127.0.0.1:8788";

const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);

/** 同時最多 limit 個；有一個丟出錯誤時不再開始新的，等進行中的做完再丟出 */
async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  let failure: unknown = null;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length && failure === null) {
      const i = next++;
      try {
        out[i] = await work(items[i]!, i);
      } catch (e) {
        failure ??= e;
      }
    }
  });
  await Promise.all(workers);
  if (failure !== null) throw failure;
  return out;
}

/** 同時送幾個：預設 1、最多 3 */
export function concurrencyOf(text: string | undefined): number {
  const n = Math.floor(Number(text ?? "1"));
  return Number.isFinite(n) ? Math.min(3, Math.max(1, n)) : 1;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function printEstimate(scenarios: Scenario[], models: ModelConfig[], repeat = 1): number {
  const estimate = estimateAll(scenarios, models, repeat);
  console.log(`情境 ${scenarios.length} 個 × 模型 ${models.length} 種${repeat > 1 ? ` × ${repeat} 次` : ""} = ${scenarios.length * models.length * repeat} 次對話`);
  console.log(`費用估算（每次呼叫假設輸入約 ${ESTIMATE.promptTokens} token、回覆約 ${ESTIMATE.replyTokens} token加思考；實際可能差到兩倍）：`);
  for (const m of estimate.perModel) console.log(`  ${m.model.label.padEnd(24)} 約 US$${m.usd.toFixed(3)}`);
  console.log(`  合計約 US$${estimate.total.toFixed(2)}`);
  return estimate.total;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      models: { type: "string" },
      scenarios: { type: "string" },
      features: { type: "string" },
      concurrency: { type: "string", default: "1" },
      repeat: { type: "string", default: "1" },
      yes: { type: "boolean", default: false },
      mock: { type: "boolean", default: false },
      list: { type: "boolean", default: false },
    },
  });

  if (values.list) {
    console.log("情境：");
    for (const s of SCENARIOS) console.log(`  ${s.id.padEnd(16)} ${s.group}　${s.title}`);
    console.log("模型設定：");
    for (const m of MODEL_CONFIGS) console.log(`  ${m.id.padEnd(16)} ${m.label}`);
    return;
  }

  const models = pickModels(list(values.models));
  models.forEach(checkModelConfig);
  const scenarios = pickScenarios(SCENARIOS, list(values.scenarios));
  const features = parseFeatures(values.features);
  const repeat = Math.max(1, Math.floor(Number(values.repeat)) || 1);

  if (!values.mock) printEstimate(scenarios, models, repeat);
  if (!values.yes && !values.mock) {
    console.log("\n這是估算，還沒打 API。要真的跑請加 --yes（只跑某幾個：--models、--scenarios）。");
    return;
  }

  let apiKey = "mock-key";
  let baseURL: string | undefined = MOCK_URL;
  if (!values.mock) {
    if (!process.env.ANTHROPIC_API_KEY && existsSync(".env") && typeof process.loadEnvFile === "function") process.loadEnvFile(".env");
    apiKey = process.env.ANTHROPIC_API_KEY?.trim() ?? "";
    if (!apiKey) {
      console.error("找不到 ANTHROPIC_API_KEY：請設定環境變數，或在目前目錄放 .env。");
      process.exitCode = 1;
      return;
    }
    baseURL = process.env.ANTHROPIC_BASE_URL?.trim() || undefined;
  }
  // SDK 不自己重試（maxRetries 0）：忙碌時只照 runWithRetry 的退避，最多再試 3 次
  const makeProvider = (m: ModelConfig) => new AnthropicProvider({ apiKey, baseURL, disableThinking: m.disableThinking, maxRetries: 0 });

  // 固定在最近的星期二：情境的日期（明天、這週、過去幾週）不隨跑的那天變
  const now = evalNow();
  const jobs = scenarios.flatMap((scenario) => models.flatMap((model) => Array.from({ length: repeat }, (_, i) => ({ scenario, model, repeat: i + 1 }))));
  let done = 0;
  let results: EvalResult[];
  try {
    results = await pool(jobs, concurrencyOf(values.concurrency), async ({ scenario, model, repeat: n }) => {
      const label = `${scenario.id} × ${model.id}${repeat > 1 ? ` #${n}` : ""}`;
      const record = await runWithRetry(async () => ({ ...(await runScenario(scenario, model, makeProvider, { now, features })), repeat: n }), {
        baseMs: values.mock ? 10 : undefined,
        onRetry: (attempt, waitMs, r) => console.log(`  ${label}：忙碌（${r.errorStatus ?? r.error}），${Math.round(waitMs / 1000)} 秒後再試（第 ${attempt} 次）`),
      });
      done++;
      if (record.finish === "setup-failed") {
        console.log(`[${done}/${jobs.length}] ${label}：情境準備失敗（${record.error?.slice(0, 160)}），是情境的問題，不算模型沒過`);
        return { ...record, checks: [] };
      }
      if (record.finish === "send-failed") {
        console.log(`[${done}/${jobs.length}] ${label}：送出失敗（${record.error?.slice(0, 120)}），不算模型沒過`);
        return { ...record, checks: [] };
      }
      const checks = runChecks(scenario, record);
      const failed = checks.filter((c) => !c.pass);
      console.log(
        `[${done}/${jobs.length}] ${label}：${checks.length - failed.length}/${checks.length}` +
          `${failed.length ? `（沒過：${failed.map((c) => c.id).join("、")}）` : ""} · ${record.costUsd === null ? "—" : `US$${record.costUsd.toFixed(4)}`} · ${record.seconds} 秒` +
          (record.error ? ` · 錯誤：${record.error.slice(0, 160)}` : ""),
      );
      return { ...record, checks };
    });
  } catch (e) {
    if (e instanceof FatalApiError) {
      console.error(`\n停止：${e.message}\n請確認 ANTHROPIC_API_KEY 是有效的 Anthropic API key、有使用這些模型的權限。`);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  const createdAt = `${stamp(new Date())}${values.mock ? "-mock" : ""}`;
  const dir = join("data", "model-eval", createdAt);
  mkdirSync(dir, { recursive: true });
  const today = localDate(now, "Asia/Taipei");
  const input = { createdAt, mock: values.mock, features, scenarios, models, results, repeat, today };
  writeFileSync(join(dir, "report.html"), reportHtml(input));
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(input));
  writeFileSync(join(dir, "results.json"), `${JSON.stringify({ createdAt, mock: values.mock, features, repeat, today, models, results }, null, 2)}\n`);

  console.log("");
  for (const s of summarize(input)) {
    console.log(
      `${s.model.label.padEnd(24)} 檢查 ${s.checksPassed}/${s.checksTotal}、全過 ${s.scenariosPassed}/${s.runs} 次、錯誤 ${s.errors}、送出失敗 ${s.sendFailed}、情境準備失敗 ${s.setupFailed}、` +
        `平均 ${s.avgUsd === null ? "—" : `US$${s.avgUsd.toFixed(4)}`}／則、${s.avgSeconds.toFixed(1)} 秒`,
    );
  }
  console.log(`\n報告：${join(dir, "report.html")}\n摘要（可以貼回來）：${join(dir, "summary.md")}`);
}

// 測試只載入函式時不執行
if (process.argv[1] && /model-eval\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  });
}
