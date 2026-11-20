/** 雲端的備份不見了：這台 12 個月內同步過的不是過期（伺服器那時記下了連線），是在另一台刪除的（規格 12.10） */
import { describe, expect, it } from "vitest";

import { EXPIRY_TEXT, expiredSince } from "../src/device-sync";

describe("雲端的備份過期", () => {
  const now = Date.parse("2027-11-20T00:00:00Z");
  it("最後一次同步超過 12 個月、或沒有紀錄：過期", () => {
    expect(expiredSince(null, now)).toBe(true);
    expect(expiredSince("2026-11-19T00:00:00Z", now)).toBe(true);
  });
  it("12 個月內同步過：不是過期", () => {
    expect(expiredSince("2027-01-01T00:00:00Z", now)).toBe(false);
  });
  it("說明寫期限與這台的資料不受影響", () => {
    expect(EXPIRY_TEXT).toContain("12 個月");
    expect(EXPIRY_TEXT).toContain("這台的資料不受影響");
  });
});
