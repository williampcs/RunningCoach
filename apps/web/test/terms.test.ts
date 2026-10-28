import { readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it } from "vitest";

import { TERMS_SHORT, TERMS_UPDATED, TERMS_VERSION } from "@running-coach/core";

import { renderPrivacyPage } from "../privacy/render";
import { defaultSettings, llmProblem, needsTermsConfirm, termsAccepted, type AppSettings } from "../src/settings";
import { renderTermsPage } from "../terms/render";

class MemoryStorage {
  private items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, value);
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
}

const page = renderTermsPage({ staging: false });

describe("使用須知頁（規格 12.32）", () => {
  it("不用 JavaScript；精簡版、版本、更新日期、聯絡方式；範本的標記都換掉了", () => {
    expect(page).not.toMatch(/<script/i);
    expect(page).not.toMatch(/\son[a-z]+=/i);
    expect(page).not.toMatch(/\sstyle=/i);
    expect(page).toContain(TERMS_SHORT);
    expect(page).toContain(`最後更新：${TERMS_UPDATED}（第 ${TERMS_VERSION} 版）`);
    expect(page).toContain("mailto:privacy@zone2mate.com");
    expect(page).not.toMatch(/<!--[A-Z_]+-->/);
  });

  it("完整版的 16 節都在（內容照使用者同意的草稿）", () => {
    const headings = [...page.matchAll(/<h2 id="[a-z-]+">(\d+)\. /g)].map((m) => Number(m[1]));
    expect(headings).toEqual(Array.from({ length: 16 }, (_, i) => i + 1));
    expect(page).toContain("緊急狀況請撥 119");
    expect(page).toContain("Zone2Mate 的作者不負賠償責任");
  });

  it("和隱私說明頁互相連結", () => {
    expect(page).toContain('href="/privacy"');
    expect(renderPrivacyPage({ staging: false, syncUrl: "" })).toContain('href="/terms"');
  });

  it("staging 的版本有標示且不收錄；正式版沒有", () => {
    const staging = renderTermsPage({ staging: true });
    expect(staging).toContain("staging-banner");
    expect(staging).toContain('name="robots" content="noindex"');
    expect(page).not.toContain("staging-banner");
    expect(page).not.toContain("noindex");
  });

  it("草稿檔標明已上線、以頁面為準", () => {
    const draft = readFileSync(join(__dirname, "../../../doc/disclaimer-draft.md"), "utf8");
    expect(draft).toContain("apps/web/terms/page.html");
  });
});

describe("使用須知的確認（規格 12.32）", () => {
  beforeEach(() => {
    (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  });

  const ready = (patch: Partial<AppSettings> = {}): AppSettings => ({
    ...defaultSettings(),
    apiKey: "k",
    consents: ["byok:anthropic"],
    ...patch,
  });

  it("資料流向與使用須知都確認了才能對話", () => {
    expect(llmProblem(ready())).toBe("尚未確認使用須知");
    expect(llmProblem(ready({ consents: [], terms: { version: TERMS_VERSION, date: "2026-10-28" } }))).toBe("尚未確認資料流向");
    expect(llmProblem(ready({ terms: { version: TERMS_VERSION, date: "2026-10-28" } }))).toBeNull();
  });

  it("用過的人（確認過資料流向）沒確認過、或確認的是舊版時，打開時請他確認；第一次用的人不另外問", () => {
    expect(needsTermsConfirm(defaultSettings())).toBe(false);
    expect(needsTermsConfirm(ready())).toBe(true);
    expect(needsTermsConfirm(ready({ terms: { version: TERMS_VERSION - 1, date: "2026-01-01" } }))).toBe(true);
    expect(needsTermsConfirm(ready({ terms: { version: TERMS_VERSION, date: "2026-10-28" } }))).toBe(false);
    expect(termsAccepted(ready({ terms: { version: TERMS_VERSION, date: "2026-10-28" } }))).toBe(true);
  });
});
