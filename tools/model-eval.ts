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
 *   --concurrency 3              同時跑幾個（預設 3）
 *   --mock                       改打模擬上游（npm run dev:mock，http://127.0.0.1:8788），不用 key、不花錢
 *   --list                       列出情境與模型設定
 * 設定 ANTHROPIC_BASE_URL 可以指向其他位址.
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

import { AnthropicProvider, parseFeatures } from "../packages/core/src";

import { runChecks } from "./model-eval/checks";
import { checkModelConfig, ESTIMATE, estimateAll, MODEL_CONFIGS, pickModels, pickScenarios } from "./model-eval/models";
import { reportHtml, summarize, summaryMarkdown } from "./model-eval/report";
import { runScenario } from "./model-eval/run";
import { SCENARIOS } from "./model-eval/scenarios";
import type { EvalResult, ModelConfig, Scenario } from "./model-eval/types";

const MOCK_URL = "http://127.0.0.1:8788";

const list = (v: string | undefined) => v?.split(",").map((s) => s.trim()).filter(Boolean);

/** 同時最多 limit 個 */
async function pool<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export function printEstimate(scenarios: Scenario[], models: ModelConfig[]): number {
  const estimate = estimateAll(scenarios, models);
  console.log(`情境 ${scenarios.length} 個 × 模型 ${models.length} 種 = ${scenarios.length * models.length} 次對話`);
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
      concurrency: { type: "string", default: "3" },
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

  if (!values.mock) printEstimate(scenarios, models);
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
  const makeProvider = (m: ModelConfig) => new AnthropicProvider({ apiKey, baseURL, disableThinking: m.disableThinking });

  const now = new Date();
  const jobs = scenarios.flatMap((scenario) => models.map((model) => ({ scenario, model })));
  let done = 0;
  const results: EvalResult[] = await pool(jobs, Math.max(1, Number(values.concurrency) || 3), async ({ scenario, model }) => {
    const record = await runScenario(scenario, model, makeProvider, { now, features });
    const checks = runChecks(scenario, record);
    done++;
    const failed = checks.filter((c) => !c.pass);
    console.log(
      `[${done}/${jobs.length}] ${scenario.id} × ${model.id}：${checks.length - failed.length}/${checks.length}` +
        `${failed.length ? `（沒過：${failed.map((c) => c.id).join("、")}）` : ""} · ${record.costUsd === null ? "—" : `US$${record.costUsd.toFixed(4)}`} · ${record.seconds} 秒` +
        (record.error ? ` · 錯誤：${record.error.slice(0, 160)}` : ""),
    );
    return { ...record, checks };
  });

  const createdAt = `${stamp(now)}${values.mock ? "-mock" : ""}`;
  const dir = join("data", "model-eval", createdAt);
  mkdirSync(dir, { recursive: true });
  const input = { createdAt, mock: values.mock, features, scenarios, models, results };
  writeFileSync(join(dir, "report.html"), reportHtml(input));
  writeFileSync(join(dir, "summary.md"), summaryMarkdown(input));
  writeFileSync(join(dir, "results.json"), `${JSON.stringify({ createdAt, mock: values.mock, features, models, results }, null, 2)}\n`);

  console.log("");
  for (const s of summarize(input)) {
    console.log(
      `${s.model.label.padEnd(24)} 檢查 ${s.checksPassed}/${s.checksTotal}、全過的情境 ${s.scenariosPassed}/${s.runs}、錯誤 ${s.errors}、` +
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
