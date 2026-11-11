/** 報告：一頁 HTML（各模型的回覆並排）與一份只有統計的 markdown 摘要. */
import type { EvalResult, ModelConfig, Scenario } from "./types";

export interface ReportInput {
  createdAt: string;
  /** 模擬上游時標示（回覆是假的） */
  mock: boolean;
  features: string[];
  scenarios: Scenario[];
  models: ModelConfig[];
  results: EvalResult[];
  /** 同一個情境×模型跑幾次（--repeat）；舊的結果沒有這一欄 */
  repeat?: number;
  /** 情境裡的「今天」（固定在星期二，evalNow）；舊的結果沒有這一欄 */
  today?: string;
}

export interface ModelSummary {
  model: ModelConfig;
  /** 送出成功的次數（不含送出失敗） */
  runs: number;
  checksPassed: number;
  checksTotal: number;
  /** 全部檢查都過的次數 */
  scenariosPassed: number;
  /** 忙碌或超過速率、重試後還是送不出去的次數（不算模型沒過） */
  sendFailed: number;
  /** 情境的選手資料建不起來的次數（情境的問題，不算模型沒過） */
  setupFailed: number;
  /** 有錯誤（API 失敗等）的次數 */
  errors: number;
  totalUsd: number | null;
  avgUsd: number | null;
  avgSeconds: number;
}

export function summarize(input: Pick<ReportInput, "models" | "results">): ModelSummary[] {
  return input.models.map((model) => {
    const all = input.results.filter((r) => r.model === model.id);
    const runs = all.filter(counted);
    const costs = runs.map((r) => r.costUsd);
    const totalUsd = costs.some((c) => c === null) ? null : costs.reduce<number>((s, c) => s + (c ?? 0), 0);
    return {
      model,
      runs: runs.length,
      checksPassed: runs.reduce((s, r) => s + r.checks.filter((c) => c.pass).length, 0),
      checksTotal: runs.reduce((s, r) => s + r.checks.length, 0),
      scenariosPassed: runs.filter((r) => r.checks.every((c) => c.pass)).length,
      sendFailed: all.filter((r) => r.finish === "send-failed").length,
      setupFailed: all.filter((r) => r.finish === "setup-failed").length,
      errors: runs.filter((r) => r.finish === "error").length,
      totalUsd,
      avgUsd: totalUsd === null || !runs.length ? null : totalUsd / runs.length,
      avgSeconds: runs.length ? runs.reduce((s, r) => s + r.seconds, 0) / runs.length : 0,
    };
  });
}

const usd = (v: number | null, digits = 4) => (v === null ? "—" : `$${v.toFixed(digits)}`);

/** 送出失敗與情境準備失敗：不是模型的問題，不算進檢查數 */
export const NOT_COUNTED = new Set(["send-failed", "setup-failed"]);
const counted = (r: EvalResult) => !NOT_COUNTED.has(r.finish);

/** 一格（情境×模型）的所有次數 */
function runsOf(input: Pick<ReportInput, "results">, scenario: string, model: string): EvalResult[] {
  return input.results.filter((r) => r.scenario === scenario && r.model === model).sort((a, b) => a.repeat - b.repeat);
}

/** 摘要裡的一格：只跑一次時「通過／檢查數」，跑好幾次時「全過的次數／次數」；後面是沒過的檢查（跑好幾次時附次數） */
export function cellSummary(runs: EvalResult[]): string {
  if (!runs.length) return "—";
  const sent = runs.filter(counted);
  const sendFailed = runs.filter((r) => r.finish === "send-failed").length;
  const setupFailed = runs.filter((r) => r.finish === "setup-failed").length;
  const failedNote = [sendFailed ? `送出失敗 ${sendFailed}` : "", setupFailed ? `情境準備失敗 ${setupFailed}` : ""].filter(Boolean).join("；");
  if (!sent.length) return failedNote;
  const counts = new Map<string, number>();
  for (const r of sent) for (const c of r.checks) if (!c.pass) counts.set(c.id, (counts.get(c.id) ?? 0) + 1);
  const failed = [...counts.entries()].map(([id, n]) => (sent.length > 1 ? `${id}×${n}` : id));
  const head =
    runs.length === 1
      ? `${sent[0]!.checks.filter((c) => c.pass).length}/${sent[0]!.checks.length}`
      : `${sent.filter((r) => r.checks.every((c) => c.pass)).length}/${sent.length} 全過`;
  return [head + (failed.length ? ` ✗ ${failed.join(", ")}` : ""), failedNote].filter(Boolean).join("；");
}

/** 給使用者貼回來的摘要：只有統計，沒有回覆的內容 */
export function summaryMarkdown(input: ReportInput): string {
  const repeat = input.repeat ?? 1;
  const lines = [
    `# 模型對照 ${input.createdAt}${input.mock ? "（模擬上游，回覆是假的）" : ""}`,
    "",
    `情境 ${input.scenarios.length} 個 × 模型 ${input.models.length} 種${repeat > 1 ? ` × 每格 ${repeat} 次` : ""}；功能開關：${input.features.length ? input.features.join("、") : "全關"}${input.today ? `；情境裡的今天：${input.today}` : ""}`,
    "",
    "| 模型 | 檢查通過 | 全過的次數 | 錯誤 | 送出失敗 | 情境準備失敗 | 平均每則 | 平均秒數 | 合計 |",
    "|---|---|---|---|---|---|---|---|---|",
    ...summarize(input).map(
      (s) =>
        `| ${s.model.label} | ${s.checksPassed}/${s.checksTotal} | ${s.scenariosPassed}/${s.runs} | ${s.errors} | ${s.sendFailed} | ${s.setupFailed} | ${usd(s.avgUsd)} | ${s.avgSeconds.toFixed(1)} | ${usd(s.totalUsd, 3)} |`,
    ),
    "",
    repeat > 1 ? "## 每個情境（全過的次數／次數；✗ 後面是沒過的檢查×次數）" : "## 每個情境（通過／檢查數；✗ 後面是沒過的檢查）",
    "",
    `| 情境 | ${input.models.map((m) => m.id).join(" | ")} |`,
    `|---|${input.models.map(() => "---").join("|")}|`,
  ];
  for (const s of input.scenarios) lines.push(`| ${s.id} | ${input.models.map((m) => cellSummary(runsOf(input, s.id, m.id))).join(" | ")} |`);
  lines.push("", "標「需人工看」的規則比較粗：不過時請看報告裡的回覆。送出失敗（忙碌或超過速率）與情境準備失敗（情境的問題）不算模型沒過、不算進檢查數。", "");
  return lines.join("\n");
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function json(value: unknown, max = 4000): string {
  const text = JSON.stringify(value, null, 2) ?? "";
  return text.length > max ? `${text.slice(0, max)}\n…（共 ${text.length} 字）` : text;
}

/** 一次的結果：檢查、回覆、工具呼叫、存了什麼 */
function runBlock(r: EvalResult): string {
  if (r.finish === "setup-failed") return `<p class="review">情境準備失敗（情境的選手資料建不起來，是情境的問題，不算模型沒過）：${escapeHtml(r.error ?? "")}</p>`;
  if (r.finish === "send-failed") return `<p class="review">送出失敗（忙碌或超過速率，重試後還是失敗；不算模型沒過）：${escapeHtml(r.error ?? "")}</p>`;
  const failed = r.checks.filter((c) => !c.pass).length;
  const checks = r.checks
    .map(
      (c) =>
        `<li class="${c.pass ? "pass" : c.review ? "review" : "fail"}">${c.pass ? "過" : "不過"}　${escapeHtml(c.label)}${c.review && !c.pass ? "（需人工看）" : ""}${
          c.detail && !c.pass ? `<span class="muted">：${escapeHtml(c.detail)}</span>` : ""
        }</li>`,
    )
    .join("");
  const tools = r.toolCalls.length
    ? r.toolCalls
        .map(
          (t) =>
            `<div class="tool"><b>${escapeHtml(t.name)}</b>${t.failed ? " <span class=\"bad\">執行失敗</span>" : ""}<pre>${escapeHtml(json(t.input))}</pre><pre class="result">${escapeHtml(t.result.slice(0, 1500))}${t.result.length > 1500 ? "…" : ""}</pre></div>`,
        )
        .join("")
    : `<p class="muted">沒有呼叫工具</p>`;
  const saved = r.saved;
  const savedText = [
    saved.newSessions.length ? `新的課：${saved.newSessions.map((s) => `${s.date ?? ""} ${s.kind}「${s.title}」約 ${s.km} km`).join("；")}` : "",
    saved.editedSessions.length ? `改過的課：${saved.editedSessions.map((s) => `${s.date ?? ""} ${s.kind}「${s.title}」`).join("；")}` : "",
    saved.acceptedWarnings ? "用 accept_warnings 保留了檢查器的問題" : "",
    saved.checkerBlocked ? `檢查器擋下 ${saved.checkerBlocked} 次` : "",
    saved.injuries.length ? `傷病：${saved.injuries.map((i) => `${i.area}（${i.status}，${i.scores.join("、")}）`).join("；")}` : "",
    saved.memories.length ? `記住的事：${saved.memories.join("；")}` : "",
  ].filter(Boolean);
  return `<div class="meta"><span class="${failed ? "bad" : "good"}">${r.checks.length - failed}/${r.checks.length}</span> · ${usd(r.costUsd)} · ${r.seconds} 秒 · 輸入 ${r.usage.input + r.usage.cacheRead + r.usage.cacheWrite}（快取讀 ${r.usage.cacheRead}）／輸出 ${r.usage.output} · ${r.usage.apiCalls} 次呼叫</div>
<ul class="checks">${checks}</ul>
${r.error ? `<p class="bad">${escapeHtml(r.error)}</p>` : ""}
<div class="reply">${escapeHtml(r.reply)}</div>
<details><summary>工具呼叫（${r.toolCalls.length}）</summary>${tools}</details>
<details><summary>存了什麼</summary>${savedText.length ? `<ul>${savedText.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ul>` : `<p class="muted">沒有寫入</p>`}</details>`;
}

/** 一格（情境×模型）：跑好幾次時上面是全過的次數，第一次展開、其他收起；最下面是使用者的備註 */
function cell(scenario: string, model: string, runs: EvalResult[]): string {
  const note = `<label class="note">備註<textarea data-note="${escapeHtml(`${scenario} × ${model}`)}" rows="2" placeholder="這一格的看法（存在這個瀏覽器）"></textarea></label>`;
  if (!runs.length) return `<td class="run"><p class="muted">沒有跑</p>${note}</td>`;
  if (runs.length === 1) return `<td class="run">${runBlock(runs[0]!)}${note}</td>`;
  const blocks = runs
    .map((r, i) => {
      const passed = r.finish === "send-failed" ? "送出失敗" : r.finish === "setup-failed" ? "情境準備失敗" : `${r.checks.filter((c) => c.pass).length}/${r.checks.length}`;
      return `<details class="attempt"${i === 0 ? " open" : ""}><summary>第 ${r.repeat} 次：${passed}</summary>${runBlock(r)}</details>`;
    })
    .join("");
  return `<td class="run"><div class="meta">${escapeHtml(cellSummary(runs))}</div>${blocks}${note}</td>`;
}

/** 備註：存在瀏覽器（每份報告各自一份）；「複製全部備註」把有寫的整理成文字 */
function notesScript(createdAt: string): string {
  return `<script>
(() => {
  const KEY = ${JSON.stringify(`model-eval-notes:${createdAt}`)};
  let notes = {};
  try { notes = JSON.parse(localStorage.getItem(KEY) || "{}") || {}; } catch { notes = {}; }
  const boxes = [...document.querySelectorAll("textarea[data-note]")];
  for (const box of boxes) {
    box.value = notes[box.dataset.note] || "";
    box.addEventListener("input", () => {
      notes[box.dataset.note] = box.value;
      try { localStorage.setItem(KEY, JSON.stringify(notes)); } catch {}
    });
  }
  const out = document.getElementById("notes-out");
  document.getElementById("copy-notes").addEventListener("click", async () => {
    const lines = boxes.filter((b) => b.value.trim()).map((b) => "- " + b.dataset.note + "：" + b.value.trim().replace(/\\n+/g, " "));
    const text = lines.length ? "# 備註（模型對照 " + ${JSON.stringify(createdAt)} + "）\\n" + lines.join("\\n") : "（還沒有備註）";
    out.value = text;
    out.hidden = false;
    out.select();
    try { await navigator.clipboard.writeText(text); document.getElementById("copy-state").textContent = "已複製"; }
    catch { document.getElementById("copy-state").textContent = "請手動複製下面的文字"; }
  });
})();
</script>`;
}

export function reportHtml(input: ReportInput): string {
  const summary = summarize(input)
    .map(
      (s) =>
        `<tr><th>${escapeHtml(s.model.label)}</th><td>${s.checksPassed}/${s.checksTotal}</td><td>${s.scenariosPassed}/${s.runs}</td><td>${s.errors}</td><td>${s.sendFailed}</td><td>${s.setupFailed}</td><td>${usd(s.avgUsd)}</td><td>${s.avgSeconds.toFixed(1)}</td><td>${usd(s.totalUsd, 3)}</td></tr>`,
    )
    .join("");
  const rows = input.scenarios
    .map((s) => {
      const cells = input.models.map((m) => cell(s.id, m.id, runsOf(input, s.id, m.id))).join("");
      const messages = s.messages.map((m) => `<p class="ask">${escapeHtml(m)}</p>`).join("");
      return `<tr><th class="scenario"><span class="tag">${s.group}</span><b>${escapeHtml(s.title)}</b><code>${s.id}</code>${messages}</th>${cells}</tr>`;
    })
    .join("");
  return `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>模型對照 ${escapeHtml(input.createdAt)}</title>
<style>
:root { --bg: #fafaf9; --card: #fff; --text: #1c1917; --muted: #78716c; --line: #e7e5e4; --good: #15803d; --bad: #b91c1c; --review: #b45309; }
@media (prefers-color-scheme: dark) { :root { --bg: #1c1917; --card: #292524; --text: #f5f5f4; --muted: #a8a29e; --line: #44403c; --good: #4ade80; --bad: #f87171; --review: #fbbf24; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--text); font: 14px/1.6 system-ui, "Noto Sans TC", sans-serif; }
h1 { font-size: 20px; margin: 0 0 4px; }
.muted { color: var(--muted); }
.good { color: var(--good); font-weight: 600; }
.bad { color: var(--bad); font-weight: 600; }
table { border-collapse: collapse; background: var(--card); }
th, td { border: 1px solid var(--line); padding: 8px; vertical-align: top; text-align: left; }
.summary { margin: 12px 0 24px; }
.wrap { overflow-x: auto; }
.grid th.scenario { width: 220px; min-width: 200px; position: sticky; left: 0; background: var(--card); z-index: 1; }
.grid td.run { width: 420px; min-width: 360px; }
.tag { display: inline-block; font-size: 12px; color: var(--muted); margin-right: 6px; }
code { display: block; color: var(--muted); font-size: 12px; }
.ask { background: var(--bg); border-radius: 8px; padding: 6px 8px; margin: 8px 0 0; font-weight: normal; }
.meta { font-size: 12px; color: var(--muted); margin-bottom: 4px; }
.checks { margin: 0 0 8px; padding-left: 18px; font-size: 12px; }
.checks .pass { color: var(--good); }
.checks .fail { color: var(--bad); }
.checks .review { color: var(--review); }
.reply { white-space: pre-wrap; border-top: 1px solid var(--line); padding-top: 8px; }
details { margin-top: 8px; font-size: 12px; }
pre { white-space: pre-wrap; word-break: break-word; background: var(--bg); padding: 6px; border-radius: 6px; margin: 4px 0; }
pre.result { color: var(--muted); }
.tool { margin-top: 6px; }
.note { display: block; margin-top: 10px; font-size: 12px; color: var(--muted); }
textarea { width: 100%; font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--line); border-radius: 6px; padding: 6px; }
.notes-bar { margin: 0 0 8px; }
button { font: inherit; padding: 6px 12px; border-radius: 6px; border: 1px solid var(--line); background: var(--card); color: var(--text); cursor: pointer; }
#notes-out { margin-bottom: 12px; max-width: 720px; }
details.attempt { border-top: 1px solid var(--line); padding-top: 4px; }
.review { color: var(--review); }
@media (max-width: 600px) { .grid th.scenario { width: 140px; min-width: 140px; } .grid td.run { min-width: 280px; } }
</style>
</head>
<body>
<h1>模型對照 ${escapeHtml(input.createdAt)}</h1>
<p class="muted">${input.mock ? "<b class=\"bad\">模擬上游：回覆是假的，只驗流程。</b> " : ""}情境 ${input.scenarios.length} 個 × 模型 ${input.models.length} 種${(input.repeat ?? 1) > 1 ? ` × 每格 ${input.repeat} 次` : ""} · 功能開關：${input.features.length ? escapeHtml(input.features.join("、")) : "全關"}${input.today ? ` · 情境裡的今天：${input.today}` : ""} · 選手資料都是假的 · 自動檢查只是底線，品質請看回覆。</p>
<div class="wrap"><table class="summary"><tr><th>模型</th><th>檢查通過</th><th>全過的次數</th><th>錯誤</th><th>送出失敗</th><th>情境準備失敗</th><th>平均每則</th><th>平均秒數</th><th>合計</th></tr>${summary}</table></div>
<p class="notes-bar"><button id="copy-notes" type="button">複製全部備註</button> <span id="copy-state" class="muted">每一格下面可以寫備註（存在這個瀏覽器），寫完按這裡複製、貼回來。</span></p>
<textarea id="notes-out" rows="6" hidden readonly></textarea>
<div class="wrap"><table class="grid"><tr><th class="scenario">情境</th>${input.models.map((m) => `<th>${escapeHtml(m.label)}</th>`).join("")}</tr>${rows}</table></div>
${notesScript(input.createdAt)}
</body>
</html>
`;
}
