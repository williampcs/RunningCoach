// 安全掃描的確定性邏輯（規格 12.45、9.4 工作單）：片、fingerprint、去重與狀態、SARIF、通知的文字。
// 只用 Node 內建的模組：代理在 Managed Agents 的沙盒裡直接用 `node` 跑，不用先裝套件。
// 這裡都是純函式，網路與檔案在 scan.mjs；測試在 tools/test/security-scan.test.ts。

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

export const TOOL_NAME = "security-scan-agent";
export const SARIF_CATEGORY = "security-scan-agent/";
export const FINGERPRINT_KEY = "securityScanFingerprint/v1";
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const CONFIDENCES = ["high", "medium", "low"];
/** open：還沒處理；fixed：程式改了、問題不在了；false_positive、wont_fix：使用者在 Security 分頁標的。 */
export const STATUSES = ["open", "fixed", "false_positive", "wont_fix"];
const MAX_RUNS = 30;

// ---------------------------------------------------------------- slices.yaml

/**
 * 讀 slices.yaml。只支援檔案開頭說明的那一小部分 YAML：
 * 最上層的 key 是清單；清單的項目是字串或 map；map 的值是一行的字串或字串的清單。
 */
export function parseSlicesYaml(text) {
  const lines = text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, no: i + 1 }))
    .filter(({ raw }) => raw.trim() !== "" && !raw.trim().startsWith("#"));
  const root = {};
  let topKey = null; // 目前的最上層 key
  let item = null; // 目前清單裡的 map（slices 的一片）
  let itemIndent = -1;
  let listKey = null; // map 裡正在讀的清單（paths、focus…）
  const fail = (no, why) => {
    throw new Error(`slices.yaml 第 ${no} 行：${why}`);
  };
  for (const { raw, no } of lines) {
    if (raw.includes("\t")) fail(no, "不要用 tab 縮排");
    const indent = raw.length - raw.trimStart().length;
    const body = raw.trim();
    if (indent === 0) {
      const m = /^([A-Za-z_][\w-]*):\s*$/.exec(body);
      if (!m) fail(no, "最上層只能是「key:」，下面接清單");
      topKey = m[1];
      root[topKey] = [];
      item = null;
      listKey = null;
      continue;
    }
    if (topKey === null) fail(no, "縮排的內容前面要有最上層的 key");
    if (body.startsWith("- ")) {
      const rest = body.slice(2).trim();
      if (item && listKey && indent > itemIndent) {
        item[listKey].push(scalar(rest, no, fail));
        continue;
      }
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(rest);
      if (kv && !isQuoted(rest)) {
        item = {};
        itemIndent = indent;
        root[topKey].push(item);
        listKey = null;
        setKey(item, kv[1], kv[2], no, fail);
        if (kv[2] === "") listKey = kv[1];
      } else {
        item = null;
        listKey = null;
        root[topKey].push(scalar(rest, no, fail));
      }
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(body);
    if (!kv || !item || indent <= itemIndent) fail(no, "看不懂這一行");
    listKey = null;
    setKey(item, kv[1], kv[2], no, fail);
    if (kv[2] === "") listKey = kv[1];
  }
  return root;
}

function isQuoted(s) {
  return s.startsWith('"') || s.startsWith("'");
}

function setKey(obj, key, value, no, fail) {
  if (key in obj) fail(no, `重複的 key「${key}」`);
  obj[key] = value === "" ? [] : scalar(value, no, fail);
}

function scalar(s, no, fail) {
  if (/^[[{|>&*!]/.test(s)) fail(no, "不支援這種 YAML 寫法（[ ] { } | > & * !）");
  if (s.startsWith('"')) {
    if (!s.endsWith('"') || s.length < 2) fail(no, "引號沒有關");
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  if (s.startsWith("'")) {
    if (!s.endsWith("'") || s.length < 2) fail(no, "引號沒有關");
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s.replace(/\s+#.*$/, "");
}

/** 檢查片的定義，回傳整理過的 { exclude, slices }。 */
export function loadSlices(text) {
  const raw = parseSlicesYaml(text);
  const asList = (v, what) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new Error(`${what} 要是字串的清單`);
    return v;
  };
  const exclude = asList(raw.exclude, "exclude");
  if (!Array.isArray(raw.slices) || raw.slices.length === 0) throw new Error("slices 不能是空的");
  const ids = new Set();
  const slices = raw.slices.map((s, i) => {
    if (typeof s !== "object" || s === null) throw new Error(`slices 的第 ${i + 1} 項要是 map`);
    if (typeof s.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(s.id)) throw new Error(`slices 的第 ${i + 1} 項：id 要是小寫英數與 -`);
    if (ids.has(s.id)) throw new Error(`重複的片：${s.id}`);
    ids.add(s.id);
    const paths = asList(s.paths, `${s.id}.paths`);
    if (paths.length === 0) throw new Error(`${s.id} 沒有 paths`);
    return {
      id: s.id,
      name: typeof s.name === "string" ? s.name : s.id,
      paths,
      exclude: asList(s.exclude, `${s.id}.exclude`),
      focus: asList(s.focus, `${s.id}.focus`),
    };
  });
  return { exclude, slices };
}

// ---------------------------------------------------------------- glob 與檔案

const globCache = new Map();

/** `**` 任何深度（含零層），`*` 一層裡的任意字元，`?` 一個字元。 */
export function globToRegExp(glob) {
  let re = globCache.get(glob);
  if (re) return re;
  let src = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      i++;
      if (glob[i + 1] === "/") {
        i++;
        src += "(?:.*/)?";
      } else {
        src += ".*";
      }
    } else if (c === "*") {
      src += "[^/]*";
    } else if (c === "?") {
      src += "[^/]";
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  re = new RegExp(`^${src}$`);
  globCache.set(glob, re);
  return re;
}

export function matchesAny(file, globs) {
  return globs.some((g) => globToRegExp(g).test(file));
}

/** 這個檔案要不要審：被最上層的 exclude 排除的（文件、測試、v1…）不審。 */
export function isReviewable(config, file) {
  return !matchesAny(file, config.exclude);
}

export function sliceFiles(config, slice, allFiles) {
  return allFiles
    .filter((f) => matchesAny(f, slice.paths) && !matchesAny(f, slice.exclude) && isReviewable(config, f))
    .sort();
}

export function slicesForFile(config, file) {
  if (!isReviewable(config, file)) return [];
  return config.slices.filter((s) => matchesAny(file, s.paths) && !matchesAny(file, s.exclude)).map((s) => s.id);
}

/**
 * 一片的內容雜湊：`git ls-files -s` 的輸出（mode、blob、stage、路徑）只留這片的檔案，排序後算 SHA-256。
 * 檔案的內容、新增、刪除、改名都會讓它變；跟 commit 的時間或別的片無關。
 */
export function sliceHash(config, slice, lsFilesStageOutput) {
  const entries = [];
  for (const line of lsFilesStageOutput.split("\n")) {
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.+)$/.exec(line);
    if (!m) continue;
    entries.push({ path: m[4], blob: m[2] });
  }
  const files = new Set(sliceFiles(config, slice, entries.map((e) => e.path)));
  const lines = entries
    .filter((e) => files.has(e.path))
    .map((e) => `${e.blob} ${e.path}`)
    .sort();
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/**
 * `git diff --name-status -M` 的輸出 → 要審的檔案（含屬於哪幾片）與跳過的檔案。
 * 改名的檔案用新的路徑；刪掉的檔案也列出來（刪掉檢查也可能是問題）。
 */
export function classifyChanges(config, nameStatusOutput) {
  const files = [];
  const skipped = [];
  for (const line of nameStatusOutput.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0];
    const path = parts[parts.length - 1];
    const entry = { path, status: status[0] };
    if (parts.length === 3) entry.from = parts[1];
    if (isReviewable(config, path)) files.push({ ...entry, slices: slicesForFile(config, path) });
    else skipped.push(entry);
  }
  return { files, skipped };
}

// ---------------------------------------------------------------- fingerprint

/** 程式片段的正規化：每行去掉前後空白、連續空白變一個、去掉空行。縮排與行號都不影響。 */
export function normalizeSnippet(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\s+/g, " "))
    .filter((l) => l !== "")
    .join("\n");
}

/** fingerprint ＝ 檔案路徑＋類型（CWE）＋正規化後的程式片段的 SHA-256（前 32 個字）。不含行號。 */
export function fingerprint({ file, cwe, snippet }) {
  const normalized = normalizeSnippet(snippet);
  if (!normalized) throw new Error(`${file}：程式片段是空的，算不出 fingerprint`);
  return createHash("sha256").update(`${file}\n${cwe.toUpperCase()}\n${normalized}`).digest("hex").slice(0, 32);
}

/** 在檔案的內容裡找正規化後一樣的片段，回傳起訖行（從 1 起算）；找不到回 null。 */
export function locateSnippet(content, snippet) {
  const target = normalizeSnippet(snippet).split("\n");
  const lines = content.split(/\r?\n/);
  const norm = lines.map((l) => l.trim().replace(/\s+/g, " "));
  for (let start = 0; start < norm.length; start++) {
    if (norm[start] !== target[0]) continue;
    let t = 1;
    let i = start + 1;
    while (t < target.length && i < norm.length) {
      if (norm[i] === "") {
        i++;
        continue;
      }
      if (norm[i] !== target[t]) break;
      t++;
      i++;
    }
    if (t === target.length) return { start_line: start + 1, end_line: i };
  }
  return null;
}

// ---------------------------------------------------------------- findings.json

export function emptyFindings() {
  return { version: 1, findings: [] };
}

export function parseFindings(text) {
  if (text === undefined || text === null || text.trim() === "") return emptyFindings();
  const data = JSON.parse(text);
  if (data.version !== 1 || !Array.isArray(data.findings)) throw new Error("findings.json 的格式不對（要有 version: 1 與 findings）");
  return data;
}

const REQUIRED = ["file", "cwe", "title", "severity", "confidence", "trigger", "impact", "fix"];

/** 檢查代理給的一個候選發現；回傳整理過的物件，不對就丟錯（訊息寫哪裡不對）。 */
export function validateCandidate(c, index = 0) {
  const where = `第 ${index + 1} 個發現`;
  if (typeof c !== "object" || c === null) throw new Error(`${where}：要是物件`);
  for (const k of REQUIRED) {
    if (typeof c[k] !== "string" || c[k].trim() === "") throw new Error(`${where}：缺少 ${k}`);
  }
  if (c.file.startsWith("/") || c.file.includes("..")) throw new Error(`${where}：file 要是 repo 根目錄起算的相對路徑`);
  const cwe = c.cwe.trim().toUpperCase();
  if (!/^CWE-\d+$/.test(cwe)) throw new Error(`${where}：cwe 要像 CWE-639`);
  const severity = c.severity.trim().toLowerCase();
  if (!SEVERITIES.includes(severity)) throw new Error(`${where}：severity 只能是 ${SEVERITIES.join("／")}`);
  const confidence = c.confidence.trim().toLowerCase();
  if (!CONFIDENCES.includes(confidence)) throw new Error(`${where}：confidence 只能是 ${CONFIDENCES.join("／")}`);
  if (typeof c.snippet !== "string" || normalizeSnippet(c.snippet) === "") throw new Error(`${where}：缺少 snippet（有問題的那幾行程式，照原樣）`);
  return {
    file: c.file.trim(),
    cwe,
    title: c.title.trim(),
    severity,
    confidence,
    trigger: c.trigger.trim(),
    impact: c.impact.trim(),
    fix: c.fix.trim(),
    snippet: c.snippet,
    start_line: Number.isInteger(c.start_line) && c.start_line > 0 ? c.start_line : undefined,
    end_line: Number.isInteger(c.end_line) && c.end_line > 0 ? c.end_line : undefined,
    slice: typeof c.slice === "string" ? c.slice : undefined,
  };
}

/**
 * 把這次 run 的候選發現併進 findings.json（不改傳進來的物件）。
 * - 新的 fingerprint → 新增，status open。
 * - 已經 open → 更新最後看到的日期與行號（同一個問題不重複回報）。
 * - 標成 fixed 的又出現 → 改回 open（reopened）。
 * - 使用者標成 false_positive、wont_fix 的 → 不動、不回報（ignored）。
 */
export function mergeFindings(store, candidates, { date, slice } = {}) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 要是 YYYY-MM-DD");
  const next = structuredClone(store);
  const byFp = new Map(next.findings.map((f) => [f.fingerprint, f]));
  const result = { new: [], reopened: [], seen_again: [], ignored: [] };
  const seenThisRun = new Set();
  candidates.forEach((raw, i) => {
    const c = validateCandidate(raw, i);
    const fp = fingerprint(c);
    if (seenThisRun.has(fp)) return; // 同一次給了兩次
    seenThisRun.add(fp);
    const existing = byFp.get(fp);
    const line = c.start_line ?? existing?.start_line ?? 1;
    const endLine = Math.max(c.end_line ?? existing?.end_line ?? line, line);
    if (!existing) {
      const f = {
        fingerprint: fp,
        slice: c.slice ?? slice ?? null,
        title: c.title,
        cwe: c.cwe,
        severity: c.severity,
        confidence: c.confidence,
        file: c.file,
        start_line: line,
        end_line: endLine,
        snippet: c.snippet,
        trigger: c.trigger,
        impact: c.impact,
        fix: c.fix,
        status: "open",
        first_seen: date,
        last_seen: date,
        history: [{ date, status: "open", reason: "first seen" }],
      };
      next.findings.push(f);
      byFp.set(fp, f);
      result.new.push(summary(f));
      return;
    }
    existing.last_seen = date;
    existing.start_line = line;
    existing.end_line = endLine;
    if (existing.status === "false_positive" || existing.status === "wont_fix") {
      result.ignored.push(summary(existing));
    } else if (existing.status === "fixed") {
      existing.status = "open";
      existing.history.push({ date, status: "open", reason: "seen again after fixed" });
      result.reopened.push(summary(existing));
    } else {
      // 嚴重度與說明用最新一次的判斷
      Object.assign(existing, { severity: c.severity, confidence: c.confidence, title: c.title, trigger: c.trigger, impact: c.impact, fix: c.fix });
      result.seen_again.push(summary(existing));
    }
  });
  return { store: next, result };
}

function summary(f) {
  return { fingerprint: f.fingerprint, severity: f.severity, title: f.title, file: f.file, start_line: f.start_line, slice: f.slice };
}

/** 改一個發現的狀態（例如代理確認已經修好 → fixed）。 */
export function setStatus(store, fp, status, { date, reason }) {
  if (!STATUSES.includes(status)) throw new Error(`status 只能是 ${STATUSES.join("／")}`);
  const next = structuredClone(store);
  const matches = next.findings.filter((f) => f.fingerprint === fp || (fp.length >= 8 && f.fingerprint.startsWith(fp)));
  if (matches.length !== 1) throw new Error(matches.length === 0 ? `找不到 ${fp}` : `${fp} 對到不只一個發現`);
  const f = matches[0];
  if (f.status !== status) {
    f.status = status;
    f.history.push({ date, status, reason: reason ?? "" });
  }
  return next;
}

/**
 * 依目前的程式重新找每個 open 發現的位置（行號會跟著程式移動）。
 * 找不到片段的（檔案刪了或那幾行改了）列在 missing：代理要再讀一次程式，確認修好了才標 fixed。
 */
export function relocateFindings(store, readFile) {
  const next = structuredClone(store);
  const moved = [];
  const missing = [];
  for (const f of next.findings) {
    if (f.status !== "open") continue;
    const content = readFile(f.file);
    const loc = content === null ? null : locateSnippet(content, f.snippet);
    if (!loc) {
      missing.push({ ...summary(f), reason: content === null ? "file not found" : "snippet not found" });
      continue;
    }
    if (loc.start_line !== f.start_line || loc.end_line !== f.end_line) {
      moved.push({ fingerprint: f.fingerprint, from: f.start_line, to: loc.start_line });
      f.start_line = loc.start_line;
      f.end_line = loc.end_line;
    }
  }
  return { store: next, moved, missing };
}

/**
 * 使用者在 Security 分頁標的狀態 → findings.json。
 * alerts 是 code scanning API 的 alert（只取這個工具的）；rule.id 就是 fingerprint。
 * 「誤報」「測試用」→ false_positive，「不修」→ wont_fix。重新打開（state open）的照 open。
 */
export function applyAlertStates(store, alerts, { date }) {
  let next = structuredClone(store);
  const changes = [];
  for (const a of alerts) {
    if (a?.tool?.name && a.tool.name !== TOOL_NAME) continue;
    const fp = a?.rule?.id;
    const f = next.findings.find((x) => x.fingerprint === fp);
    if (!f) continue;
    let status = null;
    if (a.state === "dismissed") {
      status = a.dismissed_reason === "won't fix" ? "wont_fix" : "false_positive";
    } else if (a.state === "open" && (f.status === "false_positive" || f.status === "wont_fix")) {
      status = "open";
    }
    if (status && status !== f.status) {
      const reason = a.state === "dismissed" ? `GitHub: ${a.dismissed_reason ?? "dismissed"}${a.dismissed_comment ? ` — ${a.dismissed_comment}` : ""}` : "GitHub: reopened";
      next = setStatus(next, f.fingerprint, status, { date, reason });
      changes.push({ fingerprint: f.fingerprint, from: f.status, to: status });
    }
  }
  return { store: next, changes };
}

export function openFindings(store) {
  return store.findings.filter((f) => f.status === "open");
}

export function countBySeverity(findings) {
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const f of findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
  return counts;
}

// ---------------------------------------------------------------- SARIF

const LEVEL = { critical: "error", high: "error", medium: "warning", low: "note" };
const SECURITY_SEVERITY = { critical: "9.5", high: "8.0", medium: "5.5", low: "2.5" };

/**
 * 從 findings.json 產生 SARIF 2.1.0。只放 open 的發現：同一個類別（category）每次上傳會取代上一次，
 * 所以每次都是「目前全部還沒關閉的」；不在這次上傳裡的，GitHub 會當作已經修好。
 * 一個發現一條 rule（rule id ＝ fingerprint），說明放在 rule 的 help 裡。
 */
export function toSarif(store, { toolVersion = "1" } = {}) {
  const open = openFindings(store).slice().sort((a, b) => a.fingerprint.localeCompare(b.fingerprint));
  const rules = open.map((f) => ({
    id: f.fingerprint,
    name: f.cwe.replace("-", ""),
    shortDescription: { text: f.title },
    fullDescription: { text: `${f.cwe}: ${f.title}` },
    help: {
      text: helpText(f),
      markdown: helpMarkdown(f),
    },
    defaultConfiguration: { level: LEVEL[f.severity] },
    properties: {
      tags: ["security", `external/cwe/${f.cwe.toLowerCase()}`, `slice/${f.slice ?? "none"}`],
      "security-severity": SECURITY_SEVERITY[f.severity],
      precision: f.confidence === "high" ? "high" : f.confidence === "medium" ? "medium" : "low",
      "problem.severity": LEVEL[f.severity] === "note" ? "recommendation" : LEVEL[f.severity],
    },
  }));
  const results = open.map((f, i) => ({
    ruleId: f.fingerprint,
    ruleIndex: i,
    level: LEVEL[f.severity],
    message: { text: `[${f.severity}] ${f.title}（${f.cwe}，確定程度 ${f.confidence}）` },
    locations: [
      {
        physicalLocation: {
          artifactLocation: { uri: f.file, uriBaseId: "%SRCROOT%" },
          region: { startLine: Math.max(1, f.start_line ?? 1), endLine: Math.max(f.start_line ?? 1, f.end_line ?? f.start_line ?? 1) },
        },
      },
    ],
    partialFingerprints: { [FINGERPRINT_KEY]: f.fingerprint },
    properties: { first_seen: f.first_seen, last_seen: f.last_seen },
  }));
  return {
    $schema: "https://json.schemastore.org/sarif-2.1.0.json",
    version: "2.1.0",
    runs: [
      {
        tool: { driver: { name: TOOL_NAME, version: toolVersion, informationUri: "https://github.com/williampcs/RunningCoach/tree/v2/tools/security-scan", rules } },
        automationDetails: { id: SARIF_CATEGORY },
        results,
      },
    ],
  };
}

function helpText(f) {
  return `怎麼觸發：${f.trigger}\n影響：${f.impact}\n建議的修法：${f.fix}\n確定程度：${f.confidence}\n第一次看到：${f.first_seen}`;
}

function helpMarkdown(f) {
  return [
    `**${f.cwe}** · 嚴重度 ${f.severity} · 確定程度 ${f.confidence} · 片 ${f.slice ?? "-"}`,
    "",
    `**怎麼觸發**：${f.trigger}`,
    "",
    `**影響**：${f.impact}`,
    "",
    `**建議的修法**：${f.fix}`,
    "",
    `第一次看到 ${f.first_seen}，最近一次 ${f.last_seen}。`,
  ].join("\n");
}

/** code scanning 的上傳 API 要 gzip 後再 base64。 */
export function encodeSarif(sarif) {
  return gzipSync(Buffer.from(JSON.stringify(sarif), "utf8")).toString("base64");
}

// ---------------------------------------------------------------- GitHub 的警示

/** 整理 GitHub 的三種警示成小的物件。secret scanning 的秘密本身絕對不留。 */
export function summarizeAlerts({ dependabot = [], codeScanning = [], secretScanning = [] }) {
  return {
    dependabot: dependabot.map((a) => ({
      key: `dependabot:${a.number}`,
      number: a.number,
      state: a.state,
      package: a.dependency?.package?.name ?? a.security_vulnerability?.package?.name ?? null,
      ecosystem: a.dependency?.package?.ecosystem ?? null,
      manifest: a.dependency?.manifest_path ?? null,
      scope: a.dependency?.scope ?? null,
      severity: a.security_advisory?.severity ?? a.security_vulnerability?.severity ?? null,
      ghsa: a.security_advisory?.ghsa_id ?? null,
      cve: a.security_advisory?.cve_id ?? null,
      summary: a.security_advisory?.summary ?? null,
      vulnerable_range: a.security_vulnerability?.vulnerable_version_range ?? null,
      first_patched: a.security_vulnerability?.first_patched_version?.identifier ?? null,
      created_at: a.created_at ?? null,
    })),
    code_scanning: codeScanning
      .filter((a) => a?.tool?.name !== TOOL_NAME)
      .map((a) => ({
        key: `code_scanning:${a.number}`,
        number: a.number,
        state: a.state,
        tool: a.tool?.name ?? null,
        rule: a.rule?.id ?? null,
        rule_description: a.rule?.description ?? null,
        severity: a.rule?.security_severity_level ?? a.rule?.severity ?? null,
        path: a.most_recent_instance?.location?.path ?? null,
        start_line: a.most_recent_instance?.location?.start_line ?? null,
        message: a.most_recent_instance?.message?.text ?? null,
        created_at: a.created_at ?? null,
      })),
    secret_scanning: secretScanning.map((a) => ({
      key: `secret_scanning:${a.number}`,
      number: a.number,
      state: a.state,
      secret_type: a.secret_type_display_name ?? a.secret_type ?? null,
      validity: a.validity ?? null,
      push_protection_bypassed: a.push_protection_bypassed ?? null,
      created_at: a.created_at ?? null,
    })),
  };
}

/** 還沒在 state.seen_alerts 裡的警示（新的）。 */
export function newAlerts(summary, seenKeys = []) {
  const seen = new Set(seenKeys);
  const pick = (list) => list.filter((a) => !seen.has(a.key));
  return {
    dependabot: pick(summary.dependabot),
    code_scanning: pick(summary.code_scanning),
    secret_scanning: pick(summary.secret_scanning),
  };
}

export function alertKeys(summary) {
  return [...summary.dependabot, ...summary.code_scanning, ...summary.secret_scanning].map((a) => a.key);
}

// ---------------------------------------------------------------- state.json

export function emptyState() {
  return { version: 1, last_reviewed_commit: null, rotation_last: null, slices: {}, seen_alerts: [], last_upload: null, runs: [] };
}

export function parseState(text) {
  if (text === undefined || text === null || text.trim() === "") return emptyState();
  const data = JSON.parse(text);
  if (data.version !== 1) throw new Error("state.json 的格式不對（要有 version: 1）");
  return { ...emptyState(), ...data };
}

/**
 * 每週深掃要挑哪一片：從上次深掃的下一片開始照順序找，
 * 第一個「沒深掃過」或「內容雜湊和上次深掃時不同」或「上次沒掃完」的就是它。
 * 全部都沒變 → slice 是 null（代理再看有沒有和某一片有關的新警示，有就掃那片，沒有就結束）。
 */
export function pickNextSlice(config, state, hashes) {
  const ids = config.slices.map((s) => s.id);
  const startAfter = ids.indexOf(state.rotation_last);
  const order = [...ids.slice(startAfter + 1), ...ids.slice(0, startAfter + 1)];
  const candidates = order.map((id) => {
    const prev = state.slices[id];
    const reason = !prev?.last_deep_scan ? "never scanned" : prev.partial ? "partial last time" : prev.content_hash !== hashes[id] ? "changed" : null;
    return { id, reason, last_deep_scan: prev?.last_deep_scan ?? null };
  });
  const pick = candidates.find((c) => c.reason !== null) ?? null;
  return { slice: pick?.id ?? null, reason: pick?.reason ?? "no slice changed", candidates };
}

/** 記一次 run（只留最近 MAX_RUNS 次）。 */
export function recordRun(state, run) {
  const next = structuredClone(state);
  const { kind, date } = run;
  if (kind !== "daily" && kind !== "deep") throw new Error("kind 只能是 daily 或 deep");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("date 要是 YYYY-MM-DD");
  if (kind === "daily") {
    if (!run.commit) throw new Error("daily 要給 commit（這次審到的 v2 的 commit）");
    next.last_reviewed_commit = run.commit;
  }
  if (kind === "deep" && run.slice) {
    next.rotation_last = run.slice;
    next.slices[run.slice] = {
      last_deep_scan: date,
      content_hash: run.hash ?? null,
      partial: Boolean(run.partial),
      covered_files: run.partial ? (run.covered_files ?? []) : undefined,
      commit: run.commit ?? null,
    };
  }
  if (Array.isArray(run.seen_alerts)) {
    next.seen_alerts = [...new Set([...next.seen_alerts, ...run.seen_alerts])].sort();
  }
  next.runs = [
    ...next.runs,
    {
      date,
      kind,
      slice: run.slice ?? null,
      commit: run.commit ?? null,
      new: run.new ?? 0,
      reopened: run.reopened ?? 0,
      summary: (run.summary ?? "").slice(0, 300),
    },
  ].slice(-MAX_RUNS);
  return next;
}

// ---------------------------------------------------------------- Discord

const DISCORD_LIMIT = 1900;

/**
 * 通知的文字。只寫數量、嚴重度、標題與檔案；怎麼觸發、細節在 Security 分頁。
 * daily：沒有新發現、也沒有附註時回 null（不通知）。deep：每次都發（當作「還活著」的訊號）。
 */
export function formatNotification({ kind, slice, result, openCounts, note, securityUrl, date }) {
  const fresh = [...(result?.new ?? []), ...(result?.reopened ?? [])];
  const trimmedNote = (note ?? "").trim();
  if (kind === "daily" && fresh.length === 0 && trimmedNote === "") return null;
  const head =
    kind === "deep"
      ? `🔎 每週深掃 ${date}：${slice ?? "（沒有要掃的片）"}，新發現 ${result?.new?.length ?? 0} 個${result?.reopened?.length ? `、又出現 ${result.reopened.length} 個` : ""}`
      : `🔎 每日掃描 ${date}：新發現 ${result?.new?.length ?? 0} 個${result?.reopened?.length ? `、又出現 ${result.reopened.length} 個` : ""}`;
  const lines = [head];
  const order = (s) => SEVERITIES.indexOf(s);
  for (const f of fresh.slice().sort((a, b) => order(a.severity) - order(b.severity))) {
    lines.push(`• [${f.severity}] ${f.title} — ${f.file}:${f.start_line}`);
  }
  if (openCounts) {
    const parts = SEVERITIES.filter((s) => openCounts[s]).map((s) => `${s} ${openCounts[s]}`);
    lines.push(`還沒處理的：${parts.length ? parts.join("、") : "0"}`);
  }
  if (trimmedNote) lines.push(trimmedNote);
  if (securityUrl) lines.push(securityUrl);
  let text = lines.join("\n");
  if (text.length > DISCORD_LIMIT) text = `${text.slice(0, DISCORD_LIMIT - 20)}\n…（其餘見 Security 分頁）`;
  return text;
}
