/**
 * verify-import.cjs 用的活動檔（數值是編的，不是任何人的資料；tools/lib/fit-fixture.ts 產生）.
 * 用法：npx tsx tools/e2e/make-activity-files.ts <輸出的資料夾>
 * 「今天」是台北時間（和模擬上游一樣）.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { fakeFit, zipMany, zipOne } from "../lib/fit-fixture";

const out = process.argv[2];
if (!out) throw new Error("用法：make-activity-files.ts <資料夾>");
mkdirSync(out, { recursive: true });

const DAY = 86_400;
/** 台北時間 N 天前的 hh:mm → UTC 秒 */
function taipei(daysAgo: number, hh: number, mm: number): number {
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  return Date.parse(`${today}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00+08:00`) / 1000 - daysAgo * DAY;
}

// 1. 單一的 FIT：2 天前 07:00 的跑步，40 分、Garmin Forerunner 965、分 4 圈
writeFileSync(join(out, "run.fit"), fakeFit({ start: taipei(2, 7, 0), records: 2400, metersPerSec: 3.75, productName: "Forerunner 965", laps: 4, hrBase: 145 }));

// 2. Garmin Connect 單趟下載的 zip：今天 06:30 的跑步（和模擬的 Intervals.icu 今天那趟是同一趟），沒有型號
writeFileSync(join(out, "garmin-single.zip"), zipOne("90000000001_ACTIVITY.fit", fakeFit({ start: taipei(0, 6, 30), records: 3306, metersPerSec: 3.03 })));

// 3. 帳號資料匯出：壓縮檔裡的壓縮檔；5 天前的跑步（COROS PACE 3）、6 天前的騎車（Garmin Edge 840）、走路、每日健康資料、壞檔、400 天前的跑步
const part1 = zipMany([
  ["user_1_100.fit", fakeFit({ start: taipei(5, 18, 0), records: 1800, metersPerSec: 3.2, manufacturer: 294, productName: "PACE 3", hrBase: 150 })],
  ["user_1_101.fit", fakeFit({ start: taipei(6, 9, 0), records: 3600, metersPerSec: 8, sport: 2, productName: "Edge 840", hrBase: 125 })],
  ["user_1_102.fit", fakeFit({ start: taipei(5, 12, 0), records: 900, metersPerSec: 1.3, sport: 11 })],
  ["user_1_wellness.fit", fakeFit({ fileType: 32 })],
  ["user_1_broken.fit", Buffer.from([14, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0])],
]);
const part2 = zipOne("user_1_050.fit", fakeFit({ start: taipei(400, 7, 0), records: 1800 }));
writeFileSync(
  join(out, "garmin-export.zip"),
  zipMany([
    ["DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", part1, true],
    ["DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip", part2],
    ["DI_CONNECT/DI-Connect-Fitness/user_summarizedActivities.json", Buffer.from("[]")],
  ]),
);
console.log(out);
