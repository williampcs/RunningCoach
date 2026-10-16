/**
 * 量測聯網搜尋對成本的影響（規格 6.6）.
 *
 * 用真實的 Claude API 跑幾個典型問題，比較三種模式的 token 與金額：
 *   off       不提供搜尋（現況）
 *   basic     web_search_20250305：搜尋結果整段放進 context
 *   filtered  web_search_20260318：模型先寫程式過濾搜尋結果（動態過濾），只留相關內容
 * 系統提示與工具定義和教練實際使用的相同；選手資料與賽事是假資料。
 *
 * 需要真實的 API key，會實際計費（預設的 Opus 5.5 全部跑完約 US$1 上下）。在本機執行：
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx tools/measure-web-search.ts
 * 選項：
 *   --model claude-sonnet-5-5   主對話模型（預設 claude-opus-5-5）
 *   --scenarios gear,race       只跑部分情境（control, gear, fuel, race）
 *   --modes off,basic           只跑部分模式（off, basic, filtered）
 *   --max-uses 3                每則訊息最多搜尋幾次（預設 3）
 *   --repeat 2                  每個組合跑幾次（預設 1）
 * 結果（含回覆全文、搜尋字詞與引用來源）寫到 data/measurements/，該目錄不進版控。
 * 設定 ANTHROPIC_BASE_URL 可以指向模擬服務先試跑流程（模擬服務不會真的搜尋）。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { ContextManager } from "../packages/core/src/context";
import { addDays, localDate } from "../packages/core/src/dates";
import { Db } from "../packages/core/src/db";
import { Llm } from "../packages/core/src/llm";
import { turnCostUsd } from "../packages/core/src/llm/pricing";
import { buildTools, createToolExecutor } from "../packages/core/src/tools";
import { DEFAULT_SETTINGS, silentLogger } from "../packages/core/src/types";

/** 每次搜尋 US$0.01（每 1,000 次 10 美元，2026-10-16 查證） */
const SEARCH_FEE_USD = 0.01;

const SCENARIOS = {
  control: "今天輕鬆跑 8 公里，平均心率 145，這樣算有氧區間嗎？",
  gear: "我週跑量大約 40 公里，想買一雙適合半馬比賽的競速鞋，預算台幣 6000 元以內，現在有哪些推薦？",
  fuel: "全馬比賽中能量膠要怎麼補？推薦幾款台灣買得到的。",
  race: "我報名的臺北馬拉松，報到、關門時間和路線有什麼要注意的？",
} as const;
type Scenario = keyof typeof SCENARIOS;

const MODES = ["off", "basic", "filtered"] as const;
type Mode = (typeof MODES)[number];

// 規格 6.6 建議加進系統提示的規則；只在提供搜尋時加入
const SEARCH_RULES =
  "\n\n【網路搜尋】可以搜尋裝備、補給品、賽事等會變動的資訊。回答時註明來源與查詢日期；" +
  "推薦裝備時提醒可能有業配，並列出多個來源。查詢字詞不要包含選手的個人資料。";

interface RunResult {
  scenario: Scenario;
  mode: Mode;
  ok: boolean;
  error?: string;
  calls: number;
  searches: number;
  fetches: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  tokenCost: number | null;
  clientTools: string[];
  queries: string[];
  citations: string[];
  answer: string;
}

function options() {
  const { values } = parseArgs({
    options: {
      model: { type: "string", default: "claude-opus-5-5" },
      scenarios: { type: "string", default: Object.keys(SCENARIOS).join(",") },
      modes: { type: "string", default: MODES.join(",") },
      "max-uses": { type: "string", default: "3" },
      repeat: { type: "string", default: "1" },
    },
  });
  const pick = <T extends string>(list: string, allowed: readonly T[], label: string): T[] =>
    list.split(",").map((s) => {
      const v = s.trim() as T;
      if (!allowed.includes(v)) throw new Error(`未知的${label}：${s}（可用：${allowed.join(", ")}）`);
      return v;
    });
  return {
    model: values.model!,
    scenarios: pick(values.scenarios!, Object.keys(SCENARIOS) as Scenario[], "情境"),
    modes: pick(values.modes!, MODES, "模式"),
    maxUses: Number(values["max-uses"]),
    repeat: Number(values.repeat),
  };
}

/** 與教練相同的系統提示與工具；選手資料、賽事是假資料 */
async function coachSetup() {
  const timeZone = "Asia/Taipei";
  const now = () => new Date();
  const today = () => localDate(now(), timeZone);
  const settings = { ...DEFAULT_SETTINGS, timeZone };
  const db = new Db(openNodeSqlite(":memory:"), { now, today });
  await db.init();
  for (const [key, value] of Object.entries({
    goal_long_term: "全馬破四",
    weekly_km_target: "40",
    pb_10k: "52:30",
    pb_half: "1:58:00",
    birth_year: "1990",
    max_hr: "188",
    pref_long_run_day: "週日",
  })) {
    await db.setProfileKey(key, value);
  }
  await db.addRace({ name: "臺北馬拉松", date: addDays(today(), 60), distance_km: 42.195, target_time: "3:59:00" });

  const context = new ContextManager(db, settings, now);
  const system = await context.buildSystemPrompt();
  const unusedLlm = new Llm(
    {
      provider: {
        effortFor: () => null,
        startChat: () => ({
          next: async () => {
            throw new Error("量測不使用摘要模型");
          },
        }),
      },
      models: { chat: "-", summary: "-", compress: "-" },
      chatEffort: "medium",
      maxResponseTokens: settings.maxResponseTokens,
      toolCallMaxRounds: settings.toolCallMaxRounds,
    },
    silentLogger,
  );
  const executeTool = createToolExecutor({
    db,
    llm: unusedLlm,
    activities: { fetchLatestActivity: async () => null, fetchActivities: async () => [] },
    settings,
    today,
    logger: silentLogger,
  });
  const tools = buildTools(settings).map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
  return { system, tools, executeTool, settings };
}

function searchTool(mode: Mode, maxUses: number): unknown[] {
  const location = { type: "approximate", country: "TW", timezone: "Asia/Taipei" };
  if (mode === "basic") return [{ type: "web_search_20250305", name: "web_search", max_uses: maxUses, user_location: location }];
  if (mode === "filtered") return [{ type: "web_search_20260318", name: "web_search", max_uses: maxUses, user_location: location }];
  return [];
}

// 與 AnthropicProvider 相同：這兩個模型不支援 effort
const supportsEffort = (model: string) => !["claude-sonnet-4-5", "claude-haiku-4-5"].some((p) => model.startsWith(p));

async function runOnce(
  client: Anthropic,
  setup: Awaited<ReturnType<typeof coachSetup>>,
  model: string,
  scenario: Scenario,
  mode: Mode,
  maxUses: number,
): Promise<RunResult> {
  const result: RunResult = {
    scenario,
    mode,
    ok: false,
    calls: 0,
    searches: 0,
    fetches: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    tokenCost: 0,
    clientTools: [],
    queries: [],
    citations: [],
    answer: "",
  };
  const system = mode === "off" ? setup.system : setup.system + SEARCH_RULES;
  const tools = [...setup.tools, ...searchTool(mode, maxUses)];
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: SCENARIOS[scenario] }];

  try {
    // 工具迴圈：客戶端工具交給教練的執行器；pause_turn 原樣送回讓伺服器繼續
    for (let round = 0; round <= setup.settings.toolCallMaxRounds + 3; round++) {
      const response = await client.messages.create({
        model,
        max_tokens: setup.settings.maxResponseTokens,
        system,
        messages,
        tools,
        ...(supportsEffort(model) ? { output_config: { effort: "medium" } } : {}),
      } as unknown as Anthropic.MessageCreateParamsNonStreaming);

      const u = response.usage as Anthropic.Usage & {
        server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null;
      };
      const turn = {
        input: u.input_tokens,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
        output: u.output_tokens,
      };
      result.calls += 1;
      result.input += turn.input;
      result.cacheRead += turn.cacheRead;
      result.cacheWrite += turn.cacheWrite;
      result.output += turn.output;
      result.searches += u.server_tool_use?.web_search_requests ?? 0;
      result.fetches += u.server_tool_use?.web_fetch_requests ?? 0;
      const cost = turnCostUsd(model, turn);
      result.tokenCost = result.tokenCost === null || cost === null ? null : result.tokenCost + cost;

      for (const block of response.content as unknown as Record<string, any>[]) {
        if (block.type === "server_tool_use" && block.name === "web_search" && block.input?.query) {
          result.queries.push(String(block.input.query));
        }
        if (block.type === "text") {
          result.answer += block.text;
          for (const c of block.citations ?? []) {
            if (c.url) result.citations.push(`${c.title ?? ""} ${c.url}`.trim());
          }
        }
      }
      messages.push({ role: "assistant", content: response.content as Anthropic.ContentBlockParam[] });

      if (response.stop_reason === "pause_turn") continue;
      if (response.stop_reason === "tool_use") {
        const results: Anthropic.ToolResultBlockParam[] = [];
        for (const block of response.content) {
          if (block.type !== "tool_use") continue;
          result.clientTools.push(block.name);
          const content = await setup.executeTool(block.name, block.input as Record<string, unknown>).catch(
            (e: unknown) => `工具執行失敗：${e instanceof Error ? e.message : String(e)}`,
          );
          results.push({ type: "tool_result", tool_use_id: block.id, content });
        }
        messages.push({ role: "user", content: results });
        // 中間輪的文字只是過程說明，最後一輪的才是回覆
        result.answer = "";
        continue;
      }
      result.ok = true;
      break;
    }
    if (!result.ok) result.error = "超過工具輪數上限";
  } catch (e) {
    result.error = e instanceof Error ? e.message : String(e);
  }
  result.citations = [...new Set(result.citations)];
  return result;
}

const usd = (n: number | null) => (n === null ? "（未知模型）" : `US$${n.toFixed(4)}`);
const total = (r: RunResult) => (r.tokenCost === null ? null : r.tokenCost + r.searches * SEARCH_FEE_USD);

function report(model: string, maxUses: number, results: RunResult[]): string {
  const lines = [
    `# 聯網搜尋的成本量測`,
    "",
    `- 時間：${new Date().toISOString()}`,
    `- 模型：${model}，思考強度 medium；每則訊息最多搜尋 ${maxUses} 次`,
    `- 金額：token 依 packages/core/src/llm/pricing.ts 的單價，搜尋每次 US$${SEARCH_FEE_USD}`,
    "",
    "| 情境 | 模式 | 呼叫 | 搜尋 | 輸入 | 輸出 | token 金額 | 搜尋費 | 合計 |",
    "|---|---|---|---|---|---|---|---|---|",
  ];
  for (const r of results) {
    const input = r.input + r.cacheRead + r.cacheWrite;
    lines.push(
      r.ok
        ? `| ${r.scenario} | ${r.mode} | ${r.calls} | ${r.searches} | ${input.toLocaleString()} | ${r.output.toLocaleString()} | ${usd(r.tokenCost)} | ${usd(r.searches * SEARCH_FEE_USD)} | ${usd(total(r))} |`
        : `| ${r.scenario} | ${r.mode} | 失敗：${r.error} |||||||`,
    );
  }

  lines.push("", "## 各模式平均", "", "| 模式 | 平均合計 | 平均搜尋次數 | 平均輸入 |", "|---|---|---|---|");
  for (const mode of MODES) {
    const ok = results.filter((r) => r.mode === mode && r.ok);
    if (ok.length === 0) continue;
    const costs = ok.map(total);
    const avgCost = costs.includes(null) ? null : (costs as number[]).reduce((a, b) => a + b, 0) / ok.length;
    const avg = (f: (r: RunResult) => number) => ok.reduce((a, r) => a + f(r), 0) / ok.length;
    lines.push(
      `| ${mode} | ${usd(avgCost)} | ${avg((r) => r.searches).toFixed(1)} | ${Math.round(avg((r) => r.input + r.cacheRead + r.cacheWrite)).toLocaleString()} |`,
    );
  }

  lines.push("", "## 回覆內容");
  for (const r of results) {
    lines.push("", `### ${r.scenario} / ${r.mode}`, "");
    if (!r.ok) {
      lines.push(`失敗：${r.error}`);
      continue;
    }
    if (r.clientTools.length) lines.push(`- 教練工具：${r.clientTools.join("、")}`);
    if (r.queries.length) lines.push(`- 搜尋字詞：${r.queries.join("；")}`);
    if (r.citations.length) lines.push(`- 引用來源：`, ...r.citations.map((c) => `  - ${c}`));
    lines.push("", r.answer.trim());
  }
  return lines.join("\n") + "\n";
}

async function main() {
  const opts = options();
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("請設定 ANTHROPIC_API_KEY");
  const runs = opts.scenarios.length * opts.modes.length * opts.repeat;
  console.log(`模型 ${opts.model}，${runs} 次執行（情境 ${opts.scenarios.join("/")} × 模式 ${opts.modes.join("/")} × ${opts.repeat}）`);
  console.log("會實際計費；預設的 Opus 5.5 全部跑完約 US$1 上下。\n");

  const client = new Anthropic();
  const setup = await coachSetup();
  const results: RunResult[] = [];
  for (let i = 0; i < opts.repeat; i++) {
    for (const scenario of opts.scenarios) {
      for (const mode of opts.modes) {
        const r = await runOnce(client, setup, opts.model, scenario, mode, opts.maxUses);
        results.push(r);
        console.log(
          r.ok
            ? `${scenario.padEnd(8)} ${mode.padEnd(9)} 呼叫 ${r.calls}  搜尋 ${r.searches}  輸入 ${(r.input + r.cacheRead + r.cacheWrite).toLocaleString().padStart(7)}  輸出 ${r.output.toLocaleString().padStart(6)}  合計 ${usd(total(r))}`
            : `${scenario.padEnd(8)} ${mode.padEnd(9)} 失敗：${r.error}`,
        );
      }
    }
  }

  const md = report(opts.model, opts.maxUses, results);
  mkdirSync("data/measurements", { recursive: true });
  const file = `data/measurements/web-search-${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
  writeFileSync(file, md);
  console.log(`\n${md.split("## 回覆內容")[0]}`);
  console.log(`完整結果（含回覆與來源）：${file}`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
