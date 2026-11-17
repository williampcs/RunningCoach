import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import {
  applyAlertStates,
  buildEmailRequest,
  classifyChanges,
  emptyFindings,
  emptyState,
  encodeSarif,
  fingerprint,
  formatNotification,
  globToRegExp,
  loadSlices,
  locateSnippet,
  mergeFindings,
  newAlerts,
  normalizeSnippet,
  parseRecipients,
  parseSlicesYaml,
  pickNextSlice,
  recordRun,
  relocateFindings,
  securityTabUrl,
  sendEmail,
  setStatus,
  sliceFiles,
  sliceHash,
  slicesForFile,
  summarizeAlerts,
  toSarif,
  TOOL_NAME,
} from "../security-scan/scripts/lib.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const SCAN_DIR = join(ROOT, "tools/security-scan");
const SLICES_TEXT = readFileSync(join(SCAN_DIR, "slices.yaml"), "utf8");
const DATE = "2026-11-16";

function candidate(over: Record<string, unknown> = {}) {
  return {
    file: "apps/proxy/src/handler.ts",
    start_line: 10,
    end_line: 11,
    snippet: "if (code === expected) {\n  return ok();",
    cwe: "CWE-208",
    title: "邀請碼的比對不是時間常數",
    severity: "medium",
    confidence: "medium",
    trigger: "觸發的條件",
    impact: "影響",
    fix: "修法",
    slice: "proxy",
    ...over,
  };
}

describe("slices.yaml", () => {
  const config = loadSlices(SLICES_TEXT);
  const tracked = execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);

  it("has the seven slices in rotation order, proxy and sync first", () => {
    expect(config.slices.map((s) => s.id)).toEqual(["proxy", "sync", "sync-client", "web", "coach", "discord", "deploy"]);
    for (const s of config.slices) {
      expect(s.name).not.toBe("");
      expect(s.focus.length).toBeGreaterThan(0);
    }
  });

  it("every path pattern still matches a tracked file", () => {
    for (const s of config.slices) {
      for (const p of s.paths) {
        expect(tracked.some((f) => globToRegExp(p).test(f)), `${s.id}: ${p}`).toBe(true);
      }
      expect(sliceFiles(config, s, tracked).length, s.id).toBeGreaterThan(0);
    }
  });

  it("leaves out v1, tests and docs", () => {
    const all = config.slices.flatMap((s) => sliceFiles(config, s, tracked));
    expect(all.some((f) => f.startsWith("src/"))).toBe(false);
    expect(all.some((f) => f.includes("/test/") || f.endsWith(".test.ts"))).toBe(false);
    expect(all.some((f) => f.endsWith(".md"))).toBe(false);
  });

  it("puts the sync client files in their own slice, not in web", () => {
    expect(slicesForFile(config, "apps/web/src/device-sync.ts")).toEqual(["sync-client"]);
    expect(slicesForFile(config, "apps/web/src/key-lock.ts")).toEqual(["web"]);
    expect(slicesForFile(config, "packages/core/src/device-sync/crypto.ts")).toEqual(["sync-client"]);
    expect(slicesForFile(config, "doc/running-coach-spec2_0.md")).toEqual([]);
  });
});

describe("parseSlicesYaml", () => {
  it("reads lists, maps and quoted strings", () => {
    const parsed = parseSlicesYaml(`# c\nexclude:\n  - "a/**"\n  - b # trailing\nslices:\n  - id: x\n    name: 名字\n    paths:\n      - "x/**"\n    focus:\n      - 一點：說明\n  - id: y\n    paths:\n      - 'y/*.ts'\n`);
    expect(parsed).toEqual({
      exclude: ["a/**", "b"],
      slices: [
        { id: "x", name: "名字", paths: ["x/**"], focus: ["一點：說明"] },
        { id: "y", paths: ["y/*.ts"] },
      ],
    });
  });

  it("rejects syntax it does not support", () => {
    expect(() => parseSlicesYaml("slices:\n  - id: x\n    paths: [a, b]\n")).toThrow(/不支援/);
    expect(() => parseSlicesYaml("slices:\n\t- id: x\n")).toThrow(/tab/);
    expect(() => parseSlicesYaml("slices:\n  - id: x\n    id: y\n")).toThrow(/重複/);
  });

  it("validates the slices", () => {
    expect(() => loadSlices("slices:\n  - id: x\n    paths:\n      - a\n  - id: x\n    paths:\n      - b\n")).toThrow(/重複的片/);
    expect(() => loadSlices("slices:\n  - id: x\n")).toThrow(/沒有 paths/);
  });
});

describe("globToRegExp", () => {
  it("handles ** and *", () => {
    expect(globToRegExp("apps/proxy/src/**").test("apps/proxy/src/a/b.ts")).toBe(true);
    expect(globToRegExp("**/test/**").test("apps/proxy/test/x.test.ts")).toBe(true);
    expect(globToRegExp("**/*.md").test("README.md")).toBe(true);
    expect(globToRegExp("src/**").test("apps/src/x.ts")).toBe(false);
    expect(globToRegExp("apps/*.ts").test("apps/a/b.ts")).toBe(false);
    expect(globToRegExp("package.json").test("apps/web/package.json")).toBe(false);
  });
});

describe("fingerprint", () => {
  const base = { file: "apps/sync/src/a.ts", cwe: "CWE-639", snippet: "const row = await db.get(id);\nreturn row;" };

  it("does not depend on line numbers, indentation or blank lines", () => {
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, snippet: "    const row  =  await db.get(id);\n\n      return row;\n" })).toBe(fp);
    expect(fingerprint({ ...base, cwe: "cwe-639" })).toBe(fp);
    expect(fp).toMatch(/^[0-9a-f]{32}$/);
  });

  it("changes with the file, the type or the code", () => {
    const fp = fingerprint(base);
    expect(fingerprint({ ...base, file: "apps/sync/src/b.ts" })).not.toBe(fp);
    expect(fingerprint({ ...base, cwe: "CWE-862" })).not.toBe(fp);
    expect(fingerprint({ ...base, snippet: "const row = await db.get(otherId);\nreturn row;" })).not.toBe(fp);
  });

  it("refuses an empty snippet", () => {
    expect(() => fingerprint({ ...base, snippet: " \n " })).toThrow();
  });

  it("normalizes whitespace only", () => {
    expect(normalizeSnippet("  a   b\n\n\tc  ")).toBe("a b\nc");
  });
});

describe("locateSnippet", () => {
  const content = "line1\nfunction f() {\n  if (x) {\n\n    return y;\n  }\n}\n";

  it("finds the snippet wherever it moved", () => {
    expect(locateSnippet(content, "if (x) {\n return y;")).toEqual({ start_line: 3, end_line: 5 });
    expect(locateSnippet(`a\nb\n${content}`, "if (x) {\nreturn y;")).toEqual({ start_line: 5, end_line: 7 });
  });

  it("returns null when the code changed", () => {
    expect(locateSnippet(content, "if (x && z) {")).toBeNull();
  });
});

describe("mergeFindings", () => {
  it("adds new findings as open, with the first-seen date", () => {
    const { store, result } = mergeFindings(emptyFindings(), [candidate()], { date: DATE });
    expect(result.new).toHaveLength(1);
    expect(store.findings[0]).toMatchObject({ status: "open", first_seen: DATE, last_seen: DATE, start_line: 10, slice: "proxy", cwe: "CWE-208" });
  });

  it("does not report the same problem twice, even after it moved", () => {
    const first = mergeFindings(emptyFindings(), [candidate()], { date: DATE });
    const second = mergeFindings(first.store, [candidate({ start_line: 40, end_line: 41, snippet: "  if (code === expected) {\n      return ok();" })], { date: "2026-11-17" });
    expect(second.result.new).toHaveLength(0);
    expect(second.result.seen_again).toHaveLength(1);
    expect(second.store.findings).toHaveLength(1);
    expect(second.store.findings[0]).toMatchObject({ start_line: 40, first_seen: DATE, last_seen: "2026-11-17" });
  });

  it("ignores duplicates within one run", () => {
    const { store, result } = mergeFindings(emptyFindings(), [candidate(), candidate({ start_line: 99 })], { date: DATE });
    expect(result.new).toHaveLength(1);
    expect(store.findings).toHaveLength(1);
  });

  it("reopens a fixed finding that comes back, keeps the user's dismissals", () => {
    let { store } = mergeFindings(emptyFindings(), [candidate(), candidate({ file: "apps/proxy/src/store.ts" })], { date: DATE });
    const [a, b] = store.findings.map((f) => f.fingerprint);
    store = setStatus(store, a, "fixed", { date: DATE, reason: "fixed in abc" });
    store = setStatus(store, b, "false_positive", { date: DATE, reason: "GitHub: false positive" });
    const again = mergeFindings(store, [candidate(), candidate({ file: "apps/proxy/src/store.ts" })], { date: "2026-11-20" });
    expect(again.result.reopened.map((f) => f.fingerprint)).toEqual([a]);
    expect(again.result.ignored.map((f) => f.fingerprint)).toEqual([b]);
    expect(again.result.new).toHaveLength(0);
    expect(again.store.findings.find((f) => f.fingerprint === a)?.status).toBe("open");
    expect(again.store.findings.find((f) => f.fingerprint === b)?.status).toBe("false_positive");
  });

  it("does not change the store it was given", () => {
    const store = emptyFindings();
    mergeFindings(store, [candidate()], { date: DATE });
    expect(store.findings).toHaveLength(0);
  });

  it("rejects incomplete or malformed candidates", () => {
    expect(() => mergeFindings(emptyFindings(), [candidate({ cwe: "639" })], { date: DATE })).toThrow(/cwe/);
    expect(() => mergeFindings(emptyFindings(), [candidate({ severity: "urgent" })], { date: DATE })).toThrow(/severity/);
    expect(() => mergeFindings(emptyFindings(), [candidate({ fix: "" })], { date: DATE })).toThrow(/fix/);
    expect(() => mergeFindings(emptyFindings(), [candidate({ snippet: "" })], { date: DATE })).toThrow(/snippet/);
    expect(() => mergeFindings(emptyFindings(), [candidate({ file: "../etc/passwd" })], { date: DATE })).toThrow(/相對路徑/);
    expect(() => mergeFindings(emptyFindings(), [candidate()], { date: "11/16" })).toThrow(/date/);
  });
});

describe("setStatus", () => {
  it("accepts a fingerprint prefix and records the history", () => {
    const { store } = mergeFindings(emptyFindings(), [candidate()], { date: DATE });
    const fp = store.findings[0].fingerprint;
    const next = setStatus(store, fp.slice(0, 10), "fixed", { date: "2026-11-18", reason: "commit abc" });
    expect(next.findings[0].status).toBe("fixed");
    expect(next.findings[0].history.at(-1)).toEqual({ date: "2026-11-18", status: "fixed", reason: "commit abc" });
    expect(() => setStatus(store, fp, "closed", { date: DATE, reason: "" })).toThrow(/status/);
    expect(() => setStatus(store, "ffffffffff", "fixed", { date: DATE, reason: "" })).toThrow(/找不到/);
  });
});

describe("relocateFindings", () => {
  it("updates moved lines and lists the ones it cannot find", () => {
    let { store } = mergeFindings(emptyFindings(), [candidate(), candidate({ file: "apps/proxy/src/gone.ts" }), candidate({ file: "apps/proxy/src/changed.ts" })], { date: DATE });
    const files: Record<string, string> = {
      "apps/proxy/src/handler.ts": "a\nb\nc\nif (code === expected) {\n  return ok();\n}\n",
      "apps/proxy/src/changed.ts": "if (timingSafeEqual(code, expected)) {\n  return ok();\n}\n",
    };
    const r = relocateFindings(store, (f: string) => files[f] ?? null);
    expect(r.moved).toEqual([{ fingerprint: store.findings[0].fingerprint, from: 10, to: 4 }]);
    expect(r.missing.map((m: { file: string; reason: string }) => [m.file, m.reason])).toEqual([
      ["apps/proxy/src/gone.ts", "file not found"],
      ["apps/proxy/src/changed.ts", "snippet not found"],
    ]);
    store = r.store;
    expect(store.findings[0]).toMatchObject({ start_line: 4, end_line: 5 });
  });
});

describe("applyAlertStates", () => {
  it("copies the user's dismissals from GitHub", () => {
    const { store } = mergeFindings(emptyFindings(), [candidate(), candidate({ file: "b.ts" }), candidate({ file: "c.ts" })], { date: DATE });
    const [a, b, c] = store.findings.map((f) => f.fingerprint);
    const alerts = [
      { tool: { name: TOOL_NAME }, rule: { id: a }, state: "dismissed", dismissed_reason: "false positive", dismissed_comment: "有檢查" },
      { tool: { name: TOOL_NAME }, rule: { id: b }, state: "dismissed", dismissed_reason: "won't fix" },
      { tool: { name: TOOL_NAME }, rule: { id: c }, state: "open" },
      { tool: { name: "CodeQL" }, rule: { id: a }, state: "dismissed", dismissed_reason: "won't fix" },
    ];
    const r = applyAlertStates(store, alerts, { date: DATE });
    expect(r.changes).toEqual([
      { fingerprint: a, from: "open", to: "false_positive" },
      { fingerprint: b, from: "open", to: "wont_fix" },
    ]);
    expect(r.store.findings[0].history.at(-1).reason).toContain("有檢查");
    // 已經是同樣的狀態就不再改
    expect(applyAlertStates(r.store, alerts, { date: DATE }).changes).toEqual([]);
  });
});

describe("toSarif", () => {
  const merged = mergeFindings(
    emptyFindings(),
    [candidate({ severity: "high" }), candidate({ file: "apps/sync/src/x.ts", severity: "low", cwe: "CWE-770" }), candidate({ file: "apps/web/src/y.ts" })],
    { date: DATE },
  ).store;
  const store = setStatus(merged, merged.findings[2].fingerprint, "wont_fix", { date: DATE, reason: "" });
  const sarif = toSarif(store);
  const run = sarif.runs[0];

  it("contains only the open findings, under one fixed category", () => {
    expect(sarif.version).toBe("2.1.0");
    expect(run.automationDetails.id).toBe("security-scan-agent/");
    expect(run.tool.driver.name).toBe(TOOL_NAME);
    expect(run.results).toHaveLength(2);
    expect(run.tool.driver.rules).toHaveLength(2);
  });

  it("uses the fingerprint as the rule id and partial fingerprint", () => {
    for (const [i, r] of run.results.entries()) {
      expect(r.ruleId).toMatch(/^[0-9a-f]{32}$/);
      expect(r.ruleIndex).toBe(i);
      expect(run.tool.driver.rules[i].id).toBe(r.ruleId);
      expect(r.partialFingerprints["securityScanFingerprint/v1"]).toBe(r.ruleId);
      const loc = r.locations[0].physicalLocation;
      expect(loc.artifactLocation.uri).not.toMatch(/^\//);
      expect(loc.region.startLine).toBeGreaterThanOrEqual(1);
      expect(loc.region.endLine).toBeGreaterThanOrEqual(loc.region.startLine);
    }
  });

  it("maps severity to level and security-severity, and tags the CWE", () => {
    const byFile = Object.fromEntries(run.results.map((r) => [r.locations[0].physicalLocation.artifactLocation.uri, r]));
    expect(byFile["apps/proxy/src/handler.ts"].level).toBe("error");
    expect(byFile["apps/sync/src/x.ts"].level).toBe("note");
    const rule = run.tool.driver.rules.find((r) => r.id === byFile["apps/sync/src/x.ts"].ruleId)!;
    expect(rule.properties["security-severity"]).toBe("2.5");
    expect(rule.properties.tags).toContain("external/cwe/cwe-770");
    expect(rule.help.markdown).toContain("建議的修法");
  });

  it("is stable for the same findings", () => {
    expect(JSON.stringify(toSarif(store))).toBe(JSON.stringify(sarif));
  });

  it("encodes as gzip + base64", () => {
    const decoded = JSON.parse(gunzipSync(Buffer.from(encodeSarif(sarif), "base64")).toString("utf8"));
    expect(decoded).toEqual(sarif);
  });

  it("is an empty run when nothing is open (all previous alerts close)", () => {
    expect(toSarif(emptyFindings()).runs[0].results).toEqual([]);
  });
});

describe("GitHub alerts", () => {
  const raw = {
    dependabot: [
      {
        number: 3,
        state: "open",
        dependency: { package: { name: "undici", ecosystem: "npm" }, manifest_path: "package-lock.json", scope: "runtime" },
        security_advisory: { ghsa_id: "GHSA-x", cve_id: "CVE-1", severity: "high", summary: "s" },
        security_vulnerability: { vulnerable_version_range: "< 6.1", first_patched_version: { identifier: "6.1.0" } },
      },
    ],
    codeScanning: [
      { number: 7, state: "open", tool: { name: "CodeQL" }, rule: { id: "js/xss", security_severity_level: "high" }, most_recent_instance: { location: { path: "a.ts", start_line: 3 }, message: { text: "m" } } },
      { number: 8, state: "open", tool: { name: TOOL_NAME }, rule: { id: "abc" } },
    ],
    secretScanning: [{ number: 1, state: "open", secret_type: "github_pat", secret_type_display_name: "GitHub PAT", secret: "ghp_SHOULD_NOT_APPEAR" }],
  };

  it("summarizes the three kinds without the secret and without our own alerts", () => {
    const s = summarizeAlerts(raw);
    expect(s.dependabot[0]).toMatchObject({ key: "dependabot:3", package: "undici", first_patched: "6.1.0", scope: "runtime" });
    expect(s.code_scanning.map((a) => a.key)).toEqual(["code_scanning:7"]);
    expect(s.secret_scanning[0]).toMatchObject({ key: "secret_scanning:1", secret_type: "GitHub PAT" });
    expect(JSON.stringify(s)).not.toContain("ghp_SHOULD_NOT_APPEAR");
  });

  it("lists only the alerts not seen before", () => {
    const n = newAlerts(summarizeAlerts(raw), ["dependabot:3"]);
    expect(n.dependabot).toEqual([]);
    expect(n.code_scanning).toHaveLength(1);
    expect(n.secret_scanning).toHaveLength(1);
  });
});

describe("rotation and state", () => {
  const config = loadSlices(SLICES_TEXT);
  const hashes = Object.fromEntries(config.slices.map((s) => [s.id, `h-${s.id}`]));

  it("starts with proxy, then sync", () => {
    let state = emptyState();
    expect(pickNextSlice(config, state, hashes)).toMatchObject({ slice: "proxy", reason: "never scanned" });
    state = recordRun(state, { kind: "deep", date: DATE, slice: "proxy", hash: hashes.proxy });
    expect(pickNextSlice(config, state, hashes)).toMatchObject({ slice: "sync", reason: "never scanned" });
  });

  it("skips slices that did not change, and wraps around", () => {
    let state = emptyState();
    for (const s of config.slices) state = recordRun(state, { kind: "deep", date: DATE, slice: s.id, hash: hashes[s.id] });
    expect(pickNextSlice(config, state, hashes)).toMatchObject({ slice: null });
    expect(pickNextSlice(config, state, { ...hashes, sync: "new" })).toMatchObject({ slice: "sync", reason: "changed" });
    expect(pickNextSlice(config, state, { ...hashes, sync: "new", deploy: "new" })).toMatchObject({ slice: "sync" });
  });

  it("continues a slice that was not finished", () => {
    let state = emptyState();
    state = recordRun(state, { kind: "deep", date: DATE, slice: "proxy", hash: hashes.proxy, partial: true, covered_files: ["apps/proxy/src/handler.ts"] });
    state = recordRun(state, { kind: "deep", date: DATE, slice: "sync", hash: hashes.sync });
    for (const id of ["sync-client", "web", "coach", "discord", "deploy"]) state = recordRun(state, { kind: "deep", date: DATE, slice: id, hash: hashes[id] });
    expect(pickNextSlice(config, state, hashes)).toMatchObject({ slice: "proxy", reason: "partial last time" });
    expect(state.slices.proxy.covered_files).toEqual(["apps/proxy/src/handler.ts"]);
  });

  it("records the daily commit, the seen alerts and keeps the last runs only", () => {
    let state = emptyState();
    for (let i = 0; i < 40; i++) state = recordRun(state, { kind: "daily", date: DATE, commit: `c${i}`, seen_alerts: [`dependabot:${i % 3}`] });
    expect(state.last_reviewed_commit).toBe("c39");
    expect(state.seen_alerts).toEqual(["dependabot:0", "dependabot:1", "dependabot:2"]);
    expect(state.runs).toHaveLength(30);
    expect(() => recordRun(state, { kind: "daily", date: DATE })).toThrow(/commit/);
    expect(() => recordRun(state, { kind: "weekly", date: DATE })).toThrow(/kind/);
  });

  it("hashes a slice from its blobs only", () => {
    const proxy = config.slices[0];
    const ls = "100644 aaa 0\tapps/proxy/src/a.ts\n100644 bbb 0\tapps/web/src/b.ts\n100644 ccc 0\tapps/proxy/test/a.test.ts\n";
    const h = sliceHash(config, proxy, ls);
    expect(sliceHash(config, proxy, ls.replace("bbb", "zzz"))).toBe(h); // 別片的檔案
    expect(sliceHash(config, proxy, ls.replace("ccc", "zzz"))).toBe(h); // 測試
    expect(sliceHash(config, proxy, ls.replace("aaa", "zzz"))).not.toBe(h);
  });

  it("classifies changed files", () => {
    const out = "M\tapps/proxy/src/handler.ts\nM\tdoc/known-issues.md\nR087\tapps/sync/src/old.ts\tapps/sync/src/new.ts\nD\tapps/proxy/test/x.test.ts\nA\t.github/workflows/new.yml\n";
    const r = classifyChanges(config, out);
    expect(r.files).toEqual([
      { path: "apps/proxy/src/handler.ts", status: "M", slices: ["proxy"] },
      { path: "apps/sync/src/new.ts", status: "R", from: "apps/sync/src/old.ts", slices: ["sync"] },
      { path: ".github/workflows/new.yml", status: "A", slices: ["deploy"] },
    ]);
    expect(r.skipped.map((s) => s.path)).toEqual(["doc/known-issues.md", "apps/proxy/test/x.test.ts"]);
  });
});

describe("formatNotification", () => {
  const f = { fingerprint: "f", severity: "high", title: "標題", file: "apps/proxy/src/a.ts", start_line: 3, slice: "proxy" };

  it("stays quiet on a daily run with nothing new", () => {
    expect(formatNotification({ kind: "daily", date: DATE, result: { new: [], reopened: [] } })).toBeNull();
  });

  it("always sends a mail for a deep run", () => {
    const mail = formatNotification({ kind: "deep", date: DATE, slice: "proxy", result: { new: [], reopened: [] }, openCounts: { critical: 0, high: 0, medium: 0, low: 0 } })!;
    expect(mail.subject).toBe("[Zone2Mate 安全掃描] 每週深掃 proxy：沒有新發現");
    expect(mail.text).toContain("每週深掃");
    expect(mail.text).toContain("proxy");
  });

  it("counts the new findings in the subject", () => {
    const mail = formatNotification({ kind: "daily", date: DATE, result: { new: [f, f], reopened: [] } })!;
    expect(mail.subject).toBe("[Zone2Mate 安全掃描] 每日：新發現 2 個");
  });

  it("lists findings by severity with slice and file, without trigger, impact or fix", () => {
    const low = { ...f, severity: "low", title: "低" };
    const detailed = { ...candidate(), fingerprint: "g", severity: "medium" };
    const mail = formatNotification({ kind: "daily", date: DATE, result: { new: [low, f, detailed], reopened: [] }, openCounts: { critical: 0, high: 1, medium: 1, low: 1 }, note: "代理的附註", securityUrl: "https://example.test/s" })!;
    const { text } = mail;
    expect(text.indexOf("[high]")).toBeLessThan(text.indexOf("[medium]"));
    expect(text.indexOf("[medium]")).toBeLessThan(text.indexOf("[low]"));
    expect(text).toContain("apps/proxy/src/a.ts:3");
    expect(text).toContain("片：proxy");
    expect(text).toContain("high 1、medium 1、low 1");
    expect(text).toContain("代理的附註");
    expect(text).toContain("https://example.test/s");
    for (const secret of ["觸發的條件", "影響", "修法", "if (code === expected)"]) expect(text).not.toContain(secret);
  });

  it("keeps the subject on one line", () => {
    const mail = formatNotification({ kind: "deep", date: DATE, slice: "proxy\r\nBcc: x@example.test", result: { new: [{ ...f, title: "a\nb" }], reopened: [] } })!;
    expect(mail.subject).not.toMatch(/[\r\n]/);
    expect(mail.text).toContain("a b");
  });

  it("stays under the length limit and keeps the link", () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ ...f, title: `很長的標題 ${i}`.repeat(3) }));
    const mail = formatNotification({ kind: "daily", date: DATE, result: { new: many, reopened: [] }, securityUrl: "https://example.test/s" })!;
    expect(mail.text.length).toBeLessThanOrEqual(6000);
    expect(mail.text).toContain("其餘見 Security 分頁");
    expect(mail.text.endsWith("https://example.test/s")).toBe(true);
  });
});

describe("email", () => {
  it("links to the Security tab filtered to this tool on v2", () => {
    const url = new URL(securityTabUrl("owner/repo"));
    expect(url.origin + url.pathname).toBe("https://github.com/owner/repo/security/code-scanning");
    expect(url.searchParams.get("query")).toBe("tool:security-scan-agent branch:v2");
  });

  it("reads the recipients from config.json, with errors people understand", () => {
    expect(parseRecipients("me@example.test")).toEqual(["me@example.test"]);
    expect(parseRecipients(["a@example.test", "b@example.test"])).toEqual(["a@example.test", "b@example.test"]);
    expect(() => parseRecipients(undefined)).toThrow(/config\.json 沒有 email_to/);
    expect(() => parseRecipients([])).toThrow(/config\.json 沒有 email_to/);
    expect(() => parseRecipients("not an email")).toThrow(/email_to 格式不對/);
    expect(() => parseRecipients(["a@example.test", 3])).toThrow(/email_to 格式不對/);
  });

  it("posts to Resend with the bearer header and a plain-text body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ id: "email-id" }), { status: 200 });
    };
    const id = await sendEmail({ fetchImpl, apiKey: "placeholder-key", to: ["me@example.test"], subject: "主旨", text: "內文" });
    expect(id).toBe("email-id");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer placeholder-key");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["Idempotency-Key"]).toMatch(/^security-scan-agent-[0-9a-f]{32}$/);
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      from: "Zone2Mate Security Scan <security-scan@notify.zone2mate.com>",
      to: ["me@example.test"],
      subject: "主旨",
      text: "內文",
    });
  });

  it("uses the same idempotency key for the same mail only", () => {
    const a = buildEmailRequest({ apiKey: "k", to: ["me@example.test"], subject: "s", text: "t" });
    const b = buildEmailRequest({ apiKey: "k", to: ["me@example.test"], subject: "s", text: "t" });
    const c = buildEmailRequest({ apiKey: "k", to: ["me@example.test"], subject: "s", text: "t2" });
    expect(a.init.headers["Idempotency-Key"]).toBe(b.init.headers["Idempotency-Key"]);
    expect(a.init.headers["Idempotency-Key"]).not.toBe(c.init.headers["Idempotency-Key"]);
  });

  it("reports Resend's error without the key", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ statusCode: 403, name: "invalid_from_address", message: "domain not verified" }), { status: 403 });
    await expect(sendEmail({ fetchImpl, apiKey: "placeholder-key", to: ["me@example.test"], subject: "s", text: "t" })).rejects.toThrow(
      /^Resend：403 invalid_from_address domain not verified$/,
    );
    await expect(sendEmail({ fetchImpl, apiKey: "placeholder-key", to: ["me@example.test"], subject: "s", text: "t" })).rejects.not.toThrow(/placeholder-key/);
  });

  it("needs the key", async () => {
    await expect(sendEmail({ fetchImpl: fetch, apiKey: undefined, to: ["me@example.test"], subject: "s", text: "t" })).rejects.toThrow(/RESEND_API_KEY/);
  });
});

describe("scan.mjs (no network)", () => {
  const run = (dir: string, ...args: string[]) =>
    execFileSync(process.execPath, [join(SCAN_DIR, "scripts/scan.mjs"), ...args, "--dir", dir, "--date", DATE], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  // 用 repo 裡真的存在的幾行當片段：merge 會檢查片段在不在檔案裡
  const realFile = "apps/proxy/src/handler.ts";
  const realLines = readFileSync(join(ROOT, realFile), "utf8").split("\n");
  const firstCode = realLines.findIndex((l) => l.trim() !== "" && !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*"));
  const realSnippet = realLines.slice(firstCode, firstCode + 2).join("\n");

  it("refuses a snippet that is not in the file, and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "security-scan-"));
    const cands = join(dir, "candidates.json");
    writeFileSync(cands, JSON.stringify([candidate({ snippet: "this line is not in the file" })]));
    expect(() => run(dir, "merge", "--candidates", cands)).toThrow();
    expect(() => readFileSync(join(dir, "findings.json"))).toThrow();
  });

  it("merges, makes SARIF and records a run in the state directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "security-scan-"));
    const cands = join(dir, "candidates.json");
    writeFileSync(cands, JSON.stringify([candidate({ file: realFile, snippet: realSnippet, start_line: 999 })]));
    const first = JSON.parse(run(dir, "merge", "--candidates", cands, "--out", join(dir, "result.json")));
    expect(first.new).toHaveLength(1);
    expect(first.new[0].start_line).toBe(firstCode + 1); // 用找到的位置，不是代理給的行號
    expect(first.open_counts.medium).toBe(1);
    const second = JSON.parse(run(dir, "merge", "--candidates", cands));
    expect(second.new).toHaveLength(0);
    run(dir, "sarif", "--out", join(dir, "out.sarif"));
    expect(JSON.parse(readFileSync(join(dir, "out.sarif"), "utf8")).runs[0].results).toHaveLength(1);
    run(dir, "record-run", "--kind", "deep", "--slice", "proxy", "--hash", "h", "--partial", "--covered-file", "a.ts", "--covered-file", "b.ts", "--result", join(dir, "result.json"));
    const state = JSON.parse(readFileSync(join(dir, "state.json"), "utf8"));
    expect(state.slices.proxy).toMatchObject({ partial: true, covered_files: ["a.ts", "b.ts"], last_deep_scan: DATE });
    expect(state.runs[0]).toMatchObject({ kind: "deep", new: 1 });
  });

  it("notify explains a missing email_to, and needs the Resend key", () => {
    const dir = mkdtempSync(join(tmpdir(), "security-scan-"));
    const notify = () =>
      execFileSync(process.execPath, [join(SCAN_DIR, "scripts/scan.mjs"), "notify", "--kind", "deep", "--slice", "proxy", "--dir", dir, "--date", DATE], {
        cwd: ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, RESEND_API_KEY: "" },
      });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ repo: "owner/repo" }));
    expect(notify).toThrow(/config\.json 沒有 email_to/);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ repo: "owner/repo", email_to: "me@example.test" }));
    expect(notify).toThrow(/沒有 RESEND_API_KEY/);
  });

  it("lists the files of a slice and picks the first slice", () => {
    const dir = mkdtempSync(join(tmpdir(), "security-scan-"));
    expect(run(dir, "files", "--slice", "proxy")).toContain("apps/proxy/src/");
    expect(JSON.parse(run(dir, "next-slice"))).toMatchObject({ slice: "proxy", reason: "never scanned" });
  });
});

describe("agent and deployment files", () => {
  const read = (p: string) => readFileSync(join(SCAN_DIR, p), "utf8");

  it("turn off the web tools and need no approval", () => {
    for (const name of ["security-daily", "security-deep"]) {
      const md = read(`agents/${name}.md`);
      expect(md).toMatch(/name: web_search\n\s+enabled: false/);
      expect(md).toMatch(/name: web_fetch\n\s+enabled: false/);
      expect(md).toContain("type: always_allow");
    }
  });

  it("run on the agreed schedules and budgets", () => {
    const daily = read("deployments/security-daily.md");
    const deep = read("deployments/security-deep.md");
    expect(daily).toContain('expression: "23 4 * * *"');
    expect(daily).toContain('amount: "100"');
    expect(deep).toContain('expression: "23 5 * * 6"');
    expect(deep).toContain('amount: "500"');
    for (const d of [daily, deep]) {
      expect(d).toContain("timezone: Asia/Taipei");
      expect(d).toContain("name: v2");
      expect(d).not.toMatch(/authorization_token/);
    }
  });

  it("limit the network to GitHub and Resend", () => {
    const env = read("environments/security-scan.yaml");
    expect(env).toContain("type: limited");
    const hosts = [...env.matchAll(/^\s+- (\S+)$/gm)].map((m) => m[1]);
    expect(hosts).toEqual(["github.com", "api.github.com", "api.resend.com"]);
  });
});
