import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { allowedOrigins, fillWranglerToml } from "../sync-config";

const TOML = readFileSync(new URL("../../apps/sync/wrangler.toml", import.meta.url), "utf8");
const ID = "00000000-1111-2222-3333-444444444444";

describe("allowedOrigins", () => {
  it("keeps only the origins, without duplicates", () => {
    expect(allowedOrigins("https://app.zone2mate.com/ https://running-coach-bgb.pages.dev,https://app.zone2mate.com")).toEqual([
      "https://app.zone2mate.com",
      "https://running-coach-bgb.pages.dev",
    ]);
  });

  it("ignores an unset extra address", () => {
    // OLD_WEB_URL 沒設定時是空字串
    expect(allowedOrigins("https://app.zone2mate.com ")).toEqual(["https://app.zone2mate.com"]);
  });

  it("refuses to deploy without any address", () => {
    expect(() => allowedOrigins("  ")).toThrow(/沒有任何允許的網頁網址/);
  });

  it("refuses anything that is not https", () => {
    expect(() => allowedOrigins("http://app.zone2mate.com")).toThrow(/https/);
    expect(() => allowedOrigins("app.zone2mate.com")).toThrow(/不是網址/);
  });
});

describe("fillWranglerToml", () => {
  it("fills in production without renaming the worker", () => {
    const out = fillWranglerToml(TOML, { databaseId: ID, webUrls: "https://app.zone2mate.com https://running-coach-bgb.pages.dev" });
    expect(out).toContain('name = "running-coach-sync"\n');
    expect(out).toContain('database_name = "running-coach-sync"\n');
    expect(out).toContain(`database_id = "${ID}"`);
    expect(out).toContain('ALLOWED_ORIGINS = "https://app.zone2mate.com,https://running-coach-bgb.pages.dev"');
  });

  it("fills in staging with its own worker and database", () => {
    const out = fillWranglerToml(TOML, {
      workerName: "running-coach-sync-staging",
      databaseName: "running-coach-sync-staging",
      databaseId: ID,
      webUrls: "https://staging.zone2mate.com",
    });
    expect(out).toContain('name = "running-coach-sync-staging"\n');
    expect(out).toContain('database_name = "running-coach-sync-staging"\n');
    expect(out).toContain('ALLOWED_ORIGINS = "https://staging.zone2mate.com"');
    // 其他設定不變（不保留請求日誌）
    expect(out).toContain("[observability]\nenabled = false");
  });

  it("refuses a malformed database id or name", () => {
    expect(() => fillWranglerToml(TOML, { databaseId: "", webUrls: "https://app.zone2mate.com" })).toThrow(/id/);
    expect(() => fillWranglerToml(TOML, { databaseId: 'x"; evil', webUrls: "https://app.zone2mate.com" })).toThrow(/id/);
    expect(() => fillWranglerToml(TOML, { workerName: "Bad Name", databaseId: ID, webUrls: "https://app.zone2mate.com" })).toThrow(/名稱/);
  });

  it("fails when wrangler.toml was already filled in", () => {
    const once = fillWranglerToml(TOML, { databaseId: ID, webUrls: "https://app.zone2mate.com" });
    expect(() => fillWranglerToml(once, { databaseId: ID, webUrls: "https://app.zone2mate.com" })).toThrow(/剛好一行/);
  });
});
