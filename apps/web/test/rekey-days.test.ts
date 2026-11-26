/** 換金鑰跨天時畫面估的「大約再幾天」與移除前的說明門檻（規格 12.10） */
import { describe, expect, it } from "vitest";

import { MANY_RECORDS, rekeyDaysLeft } from "../src/device-sync";

describe("換金鑰大約還要幾天", () => {
  it("剩下的筆數除以今天搬的筆數，無條件進位", () => {
    expect(rekeyDaysLeft({ done: 200, total: 444, today: 200 })).toBe(2);
    expect(rekeyDaysLeft({ done: 1600, total: 4000, today: 1600 })).toBe(2);
    expect(rekeyDaysLeft({ done: 300, total: 1000, today: 100 })).toBe(7);
  });
  it("至少 1 天", () => {
    expect(rekeyDaysLeft({ done: 444, total: 444, today: 400 })).toBe(1);
    expect(rekeyDaysLeft({ done: 400, total: 444, today: 400 })).toBe(1);
  });
  it("今天沒有搬：估不出來", () => {
    expect(rekeyDaysLeft({ done: 0, total: 444, today: 0 })).toBeNull();
    expect(rekeyDaysLeft({ done: 100, total: 444, today: 0 })).toBeNull();
  });
  it("移除前的說明：多於 500 筆才顯示", () => {
    expect(MANY_RECORDS).toBe(500);
  });
});
