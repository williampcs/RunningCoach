import { describe, expect, it } from "vitest";

import { addDays, daysBetween, isoWeekLabel, localDate, weekdayName } from "../src";
import { nowIso, utcOffsetLabel } from "../src/dates";

describe("dates", () => {
  it("以使用者時區決定今天，不受執行環境時區影響", () => {
    const instant = new Date("2026-10-09T17:30:00Z");
    expect(localDate(instant, "Asia/Taipei")).toBe("2026-10-10");
    expect(localDate(instant, "America/Los_Angeles")).toBe("2026-10-09");
    expect(utcOffsetLabel(instant, "Asia/Taipei")).toBe("UTC+8");
    expect(utcOffsetLabel(instant, "UTC")).toBe("UTC+0");
  });

  it("曆日加減與差距", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-10-10", "2026-11-01")).toBe(22);
    expect(weekdayName("2026-10-10")).toBe("星期六");
    expect(weekdayName("2026-10-12")).toBe("星期一");
  });

  it("ISO 週標籤與 Python 的 %G-W%V 相同", () => {
    expect(isoWeekLabel("2026-10-10")).toBe("2026-W41");
    expect(isoWeekLabel("2026-01-01")).toBe("2026-W01");
    expect(isoWeekLabel("2027-01-01")).toBe("2026-W53");
    expect(isoWeekLabel("2024-12-30")).toBe("2025-W01");
    expect(isoWeekLabel("2021-01-03")).toBe("2020-W53");
  });

  it("時間戳記格式與 v1 相同", () => {
    expect(nowIso(new Date("2026-10-10T03:06:37.123Z"))).toBe("2026-10-10T03:06:37Z");
  });
});
