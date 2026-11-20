/**
 * 部署同步服務與代理的 workflow：先寫來源代碼用的金鑰（RATE_LIMIT_HASH_KEY）再部署；沒有設定時部署失敗（規格 12.10）.
 * 沒有 YAML 的套件，照文字切出每個 job 的步驟.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(new URL(`../../.github/workflows/${name}`, import.meta.url), "utf8");

/** job 的名稱 → 依序的步驟（名稱與內容） */
function jobs(text: string): Map<string, { name: string; body: string }[]> {
  const out = new Map<string, { name: string; body: string }[]>();
  const body = text.slice(text.indexOf("\njobs:\n"));
  for (const job of body.split(/\n(?=  [a-z][a-z-]*:\n)/).slice(1)) {
    const id = job.match(/^ {2}([a-z][a-z-]*):/)![1]!;
    const steps = job
      .split(/\n(?= {6}- )/)
      .slice(1)
      .map((step) => ({ name: step.match(/- name: (.+)/)?.[1]?.trim() ?? "", body: step }));
    out.set(id, steps);
  }
  return out;
}

/** 這個步驟的 run 區塊（照 YAML 的 | 縮排） */
function runScript(step: string): string {
  const lines = step.split("\n");
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  return lines
    .slice(at + 1)
    .filter((l) => l.startsWith("          "))
    .map((l) => l.slice(10))
    .join("\n");
}

const cases: [string, string][] = [
  ["sync.yml", "deploy"],
  ["proxy.yml", "deploy"],
  ["staging.yml", "sync"],
  ["staging.yml", "proxy"],
];

describe("部署前寫入來源代碼用的金鑰", () => {
  for (const [file, job] of cases) {
    it(`${file} 的 ${job}：在 Deploy 之前、沒有金鑰時失敗、不印出金鑰`, () => {
      const steps = jobs(read(file)).get(job)!;
      expect(steps).toBeDefined();
      const key = steps.findIndex((s) => s.name === "Rate limit hash key");
      const deploy = steps.findIndex((s) => s.name === "Deploy");
      expect(key).toBeGreaterThanOrEqual(0);
      expect(key).toBeLessThan(deploy);
      const script = runScript(steps[key]!.body);
      expect(script).toContain("secret put RATE_LIMIT_HASH_KEY > /dev/null");
      expect(script).not.toMatch(/echo[^\n]*\$RATE_LIMIT_HASH_KEY/);
      // 沒有金鑰：失敗（在呼叫 wrangler 之前）
      let status = 0;
      try {
        execFileSync("bash", ["-e", "-c", script], { env: { PATH: process.env.PATH, RATE_LIMIT_HASH_KEY: "" }, stdio: "pipe" });
      } catch (e) {
        status = (e as { status: number }).status;
      }
      expect(status).toBe(1);
    });
  }
});
