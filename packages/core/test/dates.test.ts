import { describe, expect, it } from "vitest";

import { addDays, daysBetween, isoWeekLabel, localDate, weekdayName } from "../src";
import { messageTimeLabel, nowIso, shortDateLabel, utcOffsetLabel } from "../src/dates";

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

  it("訊息旁的時間：今天、昨天、今年更早、不同年，依設定的時區", () => {
    // 台北 2026-10-24 09:00
    const now = new Date("2026-10-24T01:00:00Z");
    const tz = "Asia/Taipei";
    expect(messageTimeLabel("2026-10-24T06:32:00Z", now, tz)).toBe("14:32");
    // UTC 是前一天，台北已是今天
    expect(messageTimeLabel("2026-10-23T16:05:00Z", now, tz)).toBe("00:05");
    expect(messageTimeLabel("2026-10-23T15:59:00Z", now, tz)).toBe("昨天 23:59");
    expect(messageTimeLabel("2026-10-21T06:32:00Z", now, tz)).toBe("10/21 14:32");
    expect(messageTimeLabel("2026-01-05T00:03:00Z", now, tz)).toBe("1/5 08:03");
    expect(messageTimeLabel("2025-10-21T06:32:00Z", now, tz)).toBe("2025/10/21 14:32");
    // 跨年的「昨天」
    expect(messageTimeLabel("2025-12-31T12:00:00Z", new Date("2026-01-01T03:00:00Z"), tz)).toBe("昨天 20:00");
    // 同一刻在另一個時區是昨天
    expect(messageTimeLabel("2026-10-24T06:32:00Z", new Date("2026-10-25T06:00:00Z"), "America/Los_Angeles")).toBe("昨天 23:32");
    // 沒有時間的舊訊息不顯示
    expect(messageTimeLabel("", now, tz)).toBeNull();
    expect(messageTimeLabel(null, now, tz)).toBeNull();
    expect(messageTimeLabel("not a date", now, tz)).toBeNull();
  });

  it("看板上的日期", () => {
    expect(shortDateLabel("2026-10-24")).toBe("10/24（六）");
    expect(shortDateLabel("2026-01-05")).toBe("1/5（一）");
  });
});
