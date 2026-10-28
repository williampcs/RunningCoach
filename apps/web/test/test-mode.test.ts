import { describe, expect, it } from "vitest";

import { parseFeatures } from "@running-coach/core";

import { effectiveTestMode } from "../src/test-mode";

describe("測試模式的功能開關（規格 12.25）", () => {
  const stored = { enabled: true, spec: null, today: "2026-10-01" };

  it("開關開著：照存著的設定", () => {
    expect(effectiveTestMode(stored, true)).toEqual({ enabled: true, spec: null, custom: [], today: "2026-10-01" });
    expect(effectiveTestMode(null, true).enabled).toBe(false);
  });

  it("開關關著（正式版）：之前開過測試模式也回到正式的資料庫", () => {
    expect(effectiveTestMode(stored, false)).toEqual({ enabled: false, spec: null, custom: [], today: null });
  });

  it("staging 全開；正式版預設關著", () => {
    expect(parseFeatures(undefined, { staging: true })).toContain("testmode");
    expect(parseFeatures(undefined)).not.toContain("testmode");
    expect(parseFeatures("multisport")).not.toContain("testmode");
  });
});
