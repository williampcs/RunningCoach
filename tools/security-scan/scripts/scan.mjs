#!/usr/bin/env node
// 安全掃描代理用的命令列工具（規格 12.45、9.4 工作單）。在 repo 的根目錄跑：
//   node tools/security-scan/scripts/scan.mjs <指令> [選項]
// 狀態檔放在 memory store 掛載的目錄（預設 /mnt/memory/security-scan-state，可用 --dir 或 SECURITY_SCAN_DIR 改）：
//   state.json、findings.json、config.json（使用者放的：repo、email_to）。
// 秘密只從環境變數讀（GITHUB_TOKEN、RESEND_API_KEY）；在 Managed Agents 的沙盒裡它們是 vault 的佔位字串，
// 送出去時才換成真的值。這個腳本不印出它們，也不印出 secret scanning 找到的秘密。

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  alertKeys,
  applyAlertStates,
  countBySeverity,
  encodeSarif,
  formatNotification,
  loadSlices,
  locateSnippet,
  mergeFindings,
  newAlerts,
  openFindings,
  parseRecipients,
  parseFindings,
  parseState,
  pickNextSlice,
  recordRun,
  relocateFindings,
  securityTabUrl,
  sendEmail,
  setStatus,
  sliceFiles,
  sliceHash,
  classifyChanges,
  summarizeAlerts,
  TOOL_NAME,
  toSarif,
} from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SLICES_FILE = resolve(HERE, "../slices.yaml");
const REF = "refs/heads/v2";
const USAGE = `用法：node tools/security-scan/scripts/scan.mjs <指令> [選項]

  slices                          列出片（照輪替的順序）
  files --slice ID                這片包含的檔案
  slice-hash --slice ID           這片目前的內容雜湊
  next-slice                      每週深掃要挑哪一片（看 state.json）
  changes --since SHA [--to REF]  v2 從 SHA 之後改了哪些要審的檔案（含屬於哪幾片）
  alerts [--all]                  GitHub 的 Dependabot、code scanning、secret scanning 警示（預設只列新的）
  sync-alerts                     把使用者在 Security 分頁標的「誤報」「不修」套到 findings.json
  merge --candidates FILE [--slice ID] [--out FILE]
                                  把這次的候選發現（JSON 陣列）去重後併進 findings.json
  refresh                         依目前的程式更新 open 發現的行號；列出找不到的（可能修好了）
  set-status --fingerprint FP --status open|fixed|false_positive|wont_fix --reason TEXT
  sarif [--out FILE]              產生 SARIF（全部 open 的發現）
  upload [--if-changed]           產生 SARIF 並上傳到 code scanning（ref ${REF}）；--if-changed：和上次一樣就不傳
  notify --kind daily|deep [--result FILE] [--slice ID] [--note-file FILE]
                                  寄通知信（Resend；daily 沒有新東西就不寄）
  record-run --kind daily|deep [--commit SHA] [--slice ID --hash H] [--partial --covered-file F...]
             [--result FILE] [--seen-alerts FILE] [--summary TEXT]
                                  記一次 run 到 state.json

共用的選項：--dir DIR（狀態檔的目錄）、--date YYYY-MM-DD（預設今天，Asia/Taipei）`;

// ---------------------------------------------------------------- 參數與檔案

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _multi: {} };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("--")) throw new Error(`看不懂的參數：${a}`);
    const key = a.slice(2);
    const next = rest[i + 1];
    const value = next === undefined || next.startsWith("--") ? true : (i++, next);
    if (key in opts) {
      opts._multi[key] = [...(opts._multi[key] ?? [opts[key]]), value];
    }
    opts[key] = value;
  }
  return { command, opts };
}

function need(opts, key) {
  const v = opts[key];
  if (v === undefined || v === true) throw new Error(`缺少 --${key}`);
  return v;
}

function today() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

function stateDir(opts) {
  return typeof opts.dir === "string" ? opts.dir : (process.env.SECURITY_SCAN_DIR ?? "/mnt/memory/security-scan-state");
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** 先寫暫存檔再改名，寫到一半中斷也不會留下壞掉的 JSON。 */
function writeJson(path, data) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

function loadConfig(dir) {
  const text = readText(join(dir, "config.json"));
  const config = text ? JSON.parse(text) : {};
  if (!config.repo) config.repo = repoFromRemote();
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repo ?? "")) throw new Error("不知道是哪個 repo：在 config.json 寫 repo（owner/name）");
  return config;
}

function repoFromRemote() {
  try {
    const url = git(["remote", "get-url", "origin"]).trim();
    const m = /github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

function slicesConfig() {
  return loadSlices(readFileSync(SLICES_FILE, "utf8"));
}

function getSlice(config, id) {
  const s = config.slices.find((x) => x.id === id);
  if (!s) throw new Error(`沒有這一片：${id}（有 ${config.slices.map((x) => x.id).join("、")}）`);
  return s;
}

function allHashes(config) {
  const ls = git(["ls-files", "-s"]);
  return Object.fromEntries(config.slices.map((s) => [s.id, sliceHash(config, s, ls)]));
}

function print(data) {
  process.stdout.write(`${typeof data === "string" ? data : JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------- GitHub

async function github(path, { method = "GET", body, query } = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error("沒有 GITHUB_TOKEN（vault 的環境變數憑證）");
  const url = new URL(`https://api.github.com${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": TOOL_NAME,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    // 不印回應的全文：只印狀態與 GitHub 的錯誤訊息
    let message = "";
    try {
      message = JSON.parse(text).message ?? "";
    } catch {}
    const err = new Error(`GitHub ${method} ${path}：${res.status} ${message}`.trim());
    err.status = res.status;
    throw err;
  }
  return { data: text ? JSON.parse(text) : null, headers: res.headers };
}

async function githubAll(path, query = {}) {
  const items = [];
  for (let page = 1; page <= 20; page++) {
    const { data } = await github(path, { query: { ...query, per_page: 100, page } });
    if (!Array.isArray(data)) break;
    items.push(...data);
    if (data.length < 100) break;
  }
  return items;
}

/** 功能沒開（404、403）時回空的清單並記下原因，不讓整個 run 失敗。 */
async function optional(name, fn, problems) {
  try {
    return await fn();
  } catch (e) {
    if (e.status === 404 || e.status === 403) {
      problems.push(`${name}：${e.message}`);
      return [];
    }
    throw e;
  }
}

async function fetchAlerts(repo) {
  const problems = [];
  // Dependabot 的清單用游標分頁（page 已不建議用）；這個專案的警示很少，讀一頁 100 個就夠
  const dependabot = await optional("dependabot", async () => (await github(`/repos/${repo}/dependabot/alerts`, { query: { state: "open", per_page: 100 } })).data ?? [], problems);
  const codeScanning = await optional("code_scanning", () => githubAll(`/repos/${repo}/code-scanning/alerts`, { state: "open" }), problems);
  const secretScanning = await optional("secret_scanning", () => githubAll(`/repos/${repo}/secret-scanning/alerts`, { state: "open", hide_secret: true }), problems);
  return { summary: summarizeAlerts({ dependabot, codeScanning, secretScanning }), problems };
}

// ---------------------------------------------------------------- 指令

const commands = {
  slices() {
    const config = slicesConfig();
    print(config.slices.map((s) => ({ id: s.id, name: s.name, focus: s.focus })));
  },

  files(opts) {
    const config = slicesConfig();
    const slice = getSlice(config, need(opts, "slice"));
    print(sliceFiles(config, slice, git(["ls-files"]).split("\n").filter(Boolean)).join("\n"));
  },

  "slice-hash"(opts) {
    const config = slicesConfig();
    const slice = getSlice(config, need(opts, "slice"));
    print(sliceHash(config, slice, git(["ls-files", "-s"])));
  },

  "next-slice"(opts) {
    const config = slicesConfig();
    const state = parseState(readText(join(stateDir(opts), "state.json")));
    const hashes = allHashes(config);
    const pick = pickNextSlice(config, state, hashes);
    const chosen = pick.slice ? config.slices.find((s) => s.id === pick.slice) : null;
    print({
      ...pick,
      hash: pick.slice ? hashes[pick.slice] : null,
      name: chosen?.name ?? null,
      focus: chosen?.focus ?? [],
      covered_files: pick.reason === "partial last time" ? (state.slices[pick.slice]?.covered_files ?? []) : [],
    });
  },

  changes(opts) {
    const config = slicesConfig();
    const since = need(opts, "since");
    const to = typeof opts.to === "string" ? opts.to : "HEAD";
    for (const rev of [since, to]) {
      if (!/^[\w./^~-]+$/.test(rev)) throw new Error(`看不懂的 commit：${rev}`);
    }
    const head = git(["rev-parse", to]).trim();
    const out = git(["diff", "--name-status", "-M", `${since}..${head}`]);
    const commits = git(["log", "--format=%H %s", `${since}..${head}`]).split("\n").filter(Boolean);
    print({ from: since, to: head, commits: commits.length, ...classifyChanges(config, out) });
  },

  async alerts(opts) {
    const dir = stateDir(opts);
    const { repo } = loadConfig(dir);
    const state = parseState(readText(join(dir, "state.json")));
    const { summary, problems } = await fetchAlerts(repo);
    const shown = opts.all ? summary : newAlerts(summary, state.seen_alerts);
    print({ all_keys: alertKeys(summary), ...(opts.all ? { alerts: shown } : { new: shown }), problems });
  },

  async "sync-alerts"(opts) {
    const dir = stateDir(opts);
    const { repo } = loadConfig(dir);
    const path = join(dir, "findings.json");
    const store = parseFindings(readText(path));
    const problems = [];
    // 還沒上傳過（沒有分析）時 GitHub 回 404：當作沒有警示
    const alerts = await optional("code_scanning", () => githubAll(`/repos/${repo}/code-scanning/alerts`, { tool_name: TOOL_NAME, ref: REF }), problems);
    const { store: next, changes } = applyAlertStates(store, alerts, { date: opts.date ?? today() });
    if (changes.length) writeJson(path, next);
    print({ changes, problems });
  },

  merge(opts) {
    const dir = stateDir(opts);
    const path = join(dir, "findings.json");
    const store = parseFindings(readText(path));
    const candidates = JSON.parse(readFileSync(need(opts, "candidates"), "utf8"));
    if (!Array.isArray(candidates)) throw new Error("--candidates 的檔案要是 JSON 陣列");
    // 片段一定要照原樣出現在目前的檔案裡（完整的幾行）：之後才找得到它搬去哪裡。行號用找到的位置。
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    const problems = [];
    candidates.forEach((c, i) => {
      if (typeof c?.file !== "string" || typeof c?.snippet !== "string") return; // 格式錯的交給 mergeFindings 說明
      if (c.file.startsWith("/") || c.file.includes("..")) return;
      const content = readText(join(root, c.file));
      const loc = content === null ? null : locateSnippet(content, c.snippet);
      if (content === null) problems.push(`第 ${i + 1} 個發現：找不到檔案 ${c.file}`);
      else if (!loc) problems.push(`第 ${i + 1} 個發現：snippet 在 ${c.file} 裡找不到（要照原樣複製完整的 1 到 10 行）`);
      else Object.assign(c, loc);
    });
    if (problems.length) throw new Error(`沒有寫入，請修正後再 merge：\n${problems.join("\n")}`);
    const { store: next, result } = mergeFindings(store, candidates, { date: opts.date ?? today(), slice: opts.slice === true ? undefined : opts.slice });
    writeJson(path, next);
    const out = { ...result, open_counts: countBySeverity(openFindings(next)) };
    if (typeof opts.out === "string") writeJson(opts.out, out);
    print(out);
  },

  refresh(opts) {
    const dir = stateDir(opts);
    const path = join(dir, "findings.json");
    const store = parseFindings(readText(path));
    const root = git(["rev-parse", "--show-toplevel"]).trim();
    const { store: next, moved, missing } = relocateFindings(store, (file) => readText(join(root, file)));
    if (moved.length) writeJson(path, next);
    print({ moved, missing });
  },

  "set-status"(opts) {
    const dir = stateDir(opts);
    const path = join(dir, "findings.json");
    const store = parseFindings(readText(path));
    const next = setStatus(store, need(opts, "fingerprint"), need(opts, "status"), { date: opts.date ?? today(), reason: need(opts, "reason") });
    writeJson(path, next);
    print("ok");
  },

  sarif(opts) {
    const store = parseFindings(readText(join(stateDir(opts), "findings.json")));
    const sarif = toSarif(store);
    if (typeof opts.out === "string") writeJson(opts.out, sarif);
    else print(sarif);
  },

  async upload(opts) {
    const dir = stateDir(opts);
    const { repo } = loadConfig(dir);
    const store = parseFindings(readText(join(dir, "findings.json")));
    const commit = git(["rev-parse", "HEAD"]).trim();
    const sarif = toSarif(store);
    const statePath = join(dir, "state.json");
    const state = parseState(readText(statePath));
    const hash = createHash("sha256").update(JSON.stringify(sarif)).digest("hex");
    if (opts["if-changed"] && state.last_upload?.sarif_hash === hash) {
      return print({ skipped: "和上次上傳的一樣", results: sarif.runs[0].results.length });
    }
    const { data } = await github(`/repos/${repo}/code-scanning/sarifs`, {
      method: "POST",
      body: { commit_sha: commit, ref: REF, sarif: encodeSarif(sarif), tool_name: TOOL_NAME, started_at: new Date().toISOString() },
    });
    // 等 GitHub 處理完（最多約 1 分鐘），回報有沒有錯
    let status = null;
    for (let i = 0; i < 12 && data?.id; i++) {
      await new Promise((r) => setTimeout(r, 5000));
      try {
        status = (await github(`/repos/${repo}/code-scanning/sarifs/${data.id}`)).data;
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (status && status.processing_status !== "pending") break;
    }
    if (status?.processing_status !== "failed") {
      writeJson(statePath, { ...state, last_upload: { sarif_hash: hash, date: opts.date ?? today(), commit, sarif_id: data?.id ?? null } });
    }
    print({ commit, results: sarif.runs[0].results.length, sarif_id: data?.id ?? null, processing_status: status?.processing_status ?? "pending", errors: status?.errors ?? null });
  },

  async notify(opts) {
    const dir = stateDir(opts);
    const config = loadConfig(dir);
    const to = parseRecipients(config.email_to);
    const kind = need(opts, "kind");
    const result = typeof opts.result === "string" ? JSON.parse(readFileSync(opts.result, "utf8")) : { new: [], reopened: [] };
    const note = typeof opts["note-file"] === "string" ? readFileSync(opts["note-file"], "utf8").slice(0, 800) : "";
    const store = parseFindings(readText(join(dir, "findings.json")));
    const message = formatNotification({
      kind,
      date: opts.date ?? today(),
      slice: opts.slice === true ? undefined : opts.slice,
      result,
      note,
      openCounts: countBySeverity(openFindings(store)),
      securityUrl: securityTabUrl(config.repo),
    });
    if (message === null) return print("沒有新的東西，不通知");
    const id = await sendEmail({ apiKey: process.env.RESEND_API_KEY, to, subject: message.subject, text: message.text });
    print({ sent: true, id });
  },

  "record-run"(opts) {
    const dir = stateDir(opts);
    const path = join(dir, "state.json");
    const state = parseState(readText(path));
    const result = typeof opts.result === "string" ? JSON.parse(readFileSync(opts.result, "utf8")) : {};
    const seen = typeof opts["seen-alerts"] === "string" ? JSON.parse(readFileSync(opts["seen-alerts"], "utf8")) : undefined;
    const covered = opts._multi["covered-file"] ?? (typeof opts["covered-file"] === "string" ? [opts["covered-file"]] : []);
    const next = recordRun(state, {
      kind: need(opts, "kind"),
      date: opts.date ?? today(),
      commit: typeof opts.commit === "string" ? opts.commit : undefined,
      slice: typeof opts.slice === "string" ? opts.slice : undefined,
      hash: typeof opts.hash === "string" ? opts.hash : undefined,
      partial: opts.partial === true,
      covered_files: covered,
      seen_alerts: Array.isArray(seen) ? seen : Array.isArray(seen?.all_keys) ? seen.all_keys : undefined,
      new: result.new?.length ?? 0,
      reopened: result.reopened?.length ?? 0,
      summary: typeof opts.summary === "string" ? opts.summary : "",
    });
    writeJson(path, next);
    print("ok");
  },
};

async function main() {
  const { command, opts } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || !commands[command]) {
    print(USAGE);
    process.exitCode = command && command !== "help" && command !== "--help" ? 2 : 0;
    return;
  }
  await commands[command](opts);
}

main().catch((e) => {
  process.stderr.write(`錯誤：${e.message}\n`);
  process.exitCode = 1;
});
