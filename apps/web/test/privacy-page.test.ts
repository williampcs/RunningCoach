import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";

import { INTERVALS_BASE_URL, OPEN_METEO_URLS, OPENAI_COMPATIBLE_PRESETS } from "@running-coach/core";

import { renderPrivacyPage } from "../privacy/render";

const SYNC_URL = "https://running-coach-sync.example.workers.dev";
const page = renderPrivacyPage({ staging: false, syncUrl: SYNC_URL });
const host = (url: string) => new URL(url).host;

/** 一個資料夾底下所有 .ts／.tsx 的內容，去掉註解的行 */
function sourceLines(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceLines(path);
    if (!/\.tsx?$/.test(path)) return [];
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line));
  });
}

/** 程式裡出現、但網頁版不會自己去連的網址：使用者點了才打開的連結、輸入框的範例 */
const LINKS_ONLY: Record<string, string> = {
  "github.com": "設定頁的原始碼連結",
  "apps.apple.com": "只用 iPhone 時的 App 連結",
  "open-meteo.com": "天氣的資料來源標示",
  "example.com": "服務網址輸入框的範例",
};

describe("隱私說明頁（規格 12.20）", () => {
  it("網頁版預設會連的外部網址都寫在頁面上", () => {
    const defaults = [
      new Anthropic({ apiKey: "x", dangerouslyAllowBrowser: true }).baseURL,
      OPENAI_COMPATIBLE_PRESETS.openai.baseURL,
      OPENAI_COMPATIBLE_PRESETS.gemini.baseURL,
      INTERVALS_BASE_URL,
      ...Object.values(OPEN_METEO_URLS),
      SYNC_URL,
    ];
    const missing = defaults.map(host).filter((h) => !page.includes(h));
    expect(missing).toEqual([]);
  });

  it("程式裡新增了其他網址時提醒更新這一頁（寫進頁面，或是只是連結時加進 LINKS_ONLY）", () => {
    const root = join(__dirname, "../../..");
    const lines = [...sourceLines(join(root, "apps/web/src")), ...sourceLines(join(root, "packages/core/src"))];
    const hosts = new Set(lines.flatMap((line) => [...line.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1]!)));
    expect(hosts.size).toBeGreaterThan(3);
    const unlisted = [...hosts].filter((h) => !page.includes(h) && !(h in LINKS_ONLY));
    expect(unlisted).toEqual([]);
  });

  it("不用 JavaScript；署名、聯絡方式與更新日期", () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).toContain("Zone2Mate（個人開發的專案）");
    expect(page).toContain("mailto:privacy@zone2mate.com");
    expect(page).toMatch(/最後更新：\d{4}-\d{2}-\d{2}/);
    expect(page).toContain("https://github.com/williampcs/RunningCoach");
    // 範本的標記都換掉了
    expect(page).not.toMatch(/<!--[A-Z_]+-->/);
  });

  it("staging 的版本有標示且不收錄；正式版沒有", () => {
    const staging = renderPrivacyPage({ staging: true, syncUrl: SYNC_URL });
    expect(staging).toContain("staging-banner");
    expect(staging).toContain('name="robots" content="noindex"');
    expect(page).not.toContain("staging-banner");
    expect(page).not.toContain("noindex");
  });

  it("裝置清單（功能開關 devices）開著時才寫伺服器多知道的事", () => {
    const on = renderPrivacyPage({ staging: false, syncUrl: SYNC_URL, devices: true });
    expect(on).toContain("加入與最後同步的時間");
    expect(on).toContain("已經下載的資料我們收不回來");
    expect(on).not.toMatch(/<!--[A-Z_]+-->/);
    expect(page).not.toContain("加入與最後同步的時間");
  });

  it("沒有設定同步服務時照實寫", () => {
    expect(renderPrivacyPage({ staging: false, syncUrl: "" })).toContain("這個版本沒有設定同步服務");
    expect(page).toContain(`<code>${host(SYNC_URL)}</code>`);
  });
});
