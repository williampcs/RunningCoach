import { describe, expect, it } from "vitest";
import { fakeFit, zipMany, zipOne } from "../../../tools/lib/fit-fixture";
import {
  bytesSource,
  hrZoneTimes,
  importRecordOf,
  parseFit,
  parseGpx,
  parseTcx,
  scanFiles,
  zoneBasisFor,
} from "../src/activity-files";
import { detailsOf } from "../src/activities";

const START = Date.UTC(2026, 9, 9, 22, 30) / 1000; // 當地（+8）2026-10-10 06:30
const input = (name: string, bytes: Uint8Array) => ({ name, source: bytesSource(bytes) });
const utc0 = { offsetMinutes: () => 0 };

describe("parseFit", () => {
  it("跑步：時間、距離、心率、分圈、當地時間（activity 的 local_timestamp）", () => {
    const [a] = parseFit(fakeFit({ start: START, records: 600, laps: 2, metersPerSec: 3 }));
    expect(a).toMatchObject({
      format: "fit",
      type: "Run",
      startUtc: "2026-10-09T22:30:00Z",
      startLocal: "2026-10-10T06:30:00",
      elapsedSec: 600,
      movingSec: 600,
      distanceM: 1800,
      avgHr: 143,
      maxHr: 146,
      elevationGainM: 12,
      device: "Garmin",
      garmin: true,
    });
    expect(a!.laps).toHaveLength(2);
    expect(a!.laps[0]).toMatchObject({ distance_m: 900, time_s: 300, avg_hr: 143 });
    expect(a!.hrSamples).toHaveLength(590);
  });

  it("Garmin 的型號：device_info 有名字時「Garmin〔型號〕」，沒有時只寫 Garmin；其他品牌不算 Garmin", () => {
    expect(parseFit(fakeFit({ productName: "Forerunner 265" }))[0]).toMatchObject({ device: "Garmin Forerunner 265", garmin: true });
    expect(parseFit(fakeFit({ productName: "Garmin Edge 540" }))[0]!.device).toBe("Garmin Edge 540");
    expect(parseFit(fakeFit({ manufacturer: 294, productName: "PACE 3" }))[0]).toMatchObject({ device: "COROS PACE 3", garmin: false });
    expect(parseFit(fakeFit({ manufacturer: 294 }))[0]).toMatchObject({ device: "COROS", garmin: false });
    expect(parseFit(fakeFit({ manufacturer: 9999 }))[0]).toMatchObject({ device: null, garmin: false });
  });

  it("運動類型：騎車、室內騎車、越野跑、游泳、肌力、走路", () => {
    expect(parseFit(fakeFit({ sport: 2 }))[0]!.type).toBe("Ride");
    expect(parseFit(fakeFit({ sport: 2, subSport: 6 }))[0]!.type).toBe("VirtualRide");
    expect(parseFit(fakeFit({ sport: 1, subSport: 3 }))[0]!.type).toBe("TrailRun");
    expect(parseFit(fakeFit({ sport: 5 }))[0]!.type).toBe("Swim");
    expect(parseFit(fakeFit({ sport: 10, subSport: 20 }))[0]!.type).toBe("WeightTraining");
    expect(parseFit(fakeFit({ sport: 11 }))[0]!.type).toBe("Walk");
  });

  it("壓縮的時間戳記、沒有 session（用每秒的紀錄湊）、沒有心率", () => {
    const compressed = parseFit(fakeFit({ start: START, records: 100, compressedTimestamps: true }))[0]!;
    expect(compressed.hrSamples).toHaveLength(90);
    expect(compressed.hrSamples.at(-1)!.t).toBe((START + 99) * 1000);
    const noSession = parseFit(fakeFit({ start: START, records: 120, noSession: true }), utc0)[0]!;
    expect(noSession).toMatchObject({ type: "Other", startUtc: "2026-10-09T22:30:00Z", elapsedSec: 119 });
    const noHr = parseFit(fakeFit({ hrBase: null }))[0]!;
    expect(noHr).toMatchObject({ avgHr: null, maxHr: null });
  });

  it("沒有當地時間時用這台的時區（參數）", () => {
    const [a] = parseFit(fakeFit({ start: START, offsetMinutes: null }), { offsetMinutes: () => 9 * 60 });
    expect(a!.startLocal).toBe("2026-10-10T07:30:00");
  });

  it("不是活動的 FIT（每日的健康資料）：空的", () => {
    expect(parseFit(fakeFit({ fileType: 32 }))).toEqual([]);
  });

  it("壞檔：不是 FIT、檔頭壞了、截斷在定義之前", () => {
    expect(() => parseFit(new TextEncoder().encode("hello world, not a fit"))).toThrow("不是 FIT 檔");
    const fit = fakeFit();
    const bad = Uint8Array.from(fit);
    bad[0] = 2;
    expect(() => parseFit(bad)).toThrow("檔頭");
    expect(() => parseFit(fit.subarray(0, 20))).toThrow();
    // 截在中間（下載中斷）：讀得到的每秒紀錄仍然用
    const half = parseFit(fit.subarray(0, Math.floor(fit.length * 0.6)), utc0);
    expect(half[0]!.startUtc).toBe("2026-10-09T22:30:00Z");
  });
});

describe("GPX 與 TCX", () => {
  const gpx = `<?xml version="1.0"?><gpx creator="Garmin Connect" xmlns:gpxtpx="x"><trk><type>running</type><trkseg>
    ${[0, 1, 2, 3].map((i) => `<trkpt lat="25.0${i}" lon="121.5"><ele>${10 + i}</ele><time>2026-10-09T22:3${i}:00Z</time><extensions><gpxtpx:TrackPointExtension><gpxtpx:hr>${150 + i}</gpxtpx:hr></gpxtpx:TrackPointExtension></extensions></trkpt>`).join("")}
  </trkseg></trk></gpx>`;

  it("GPX：距離用座標算、心率、Garmin Connect 的檔標 Garmin", () => {
    const [a] = parseGpx(gpx, utc0);
    expect(a).toMatchObject({ format: "gpx", type: "Run", startUtc: "2026-10-09T22:30:00Z", elapsedSec: 180, avgHr: 152, maxHr: 153, device: "Garmin", garmin: true, elevationGainM: 3 });
    expect(a!.distanceM).toBeGreaterThan(3300);
    expect(a!.distanceM).toBeLessThan(3400);
    // 兩點相差 60 秒 > 30 秒：當成暫停，不算移動
    expect(a!.movingSec).toBe(180);
  });

  it("GPX 沒有心率、沒有時間", () => {
    const [a] = parseGpx(gpx.replace(/<extensions>[\s\S]*?<\/extensions>/g, ""), utc0);
    expect(a).toMatchObject({ avgHr: null, maxHr: null });
    expect(parseGpx(gpx.replace(/<time>[^<]*<\/time>/g, ""))).toEqual([]);
    expect(() => parseGpx("<html></html>")).toThrow("不是 GPX");
  });

  it("TCX：分圈、時間、距離、心率、裝置", () => {
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase><Activities><Activity Sport="Biking"><Id>2026-10-09T22:30:00Z</Id>
      <Lap StartTime="2026-10-09T22:30:00Z"><TotalTimeSeconds>600</TotalTimeSeconds><DistanceMeters>5000</DistanceMeters><Calories>100</Calories><AverageHeartRateBpm><Value>130</Value></AverageHeartRateBpm><MaximumHeartRateBpm><Value>150</Value></MaximumHeartRateBpm>
        <Track><Trackpoint><Time>2026-10-09T22:30:00Z</Time><DistanceMeters>0</DistanceMeters><HeartRateBpm><Value>120</Value></HeartRateBpm></Trackpoint>
        <Trackpoint><Time>2026-10-09T22:40:00Z</Time><DistanceMeters>5000</DistanceMeters><HeartRateBpm><Value>140</Value></HeartRateBpm></Trackpoint></Track></Lap>
      <Lap StartTime="2026-10-09T22:40:00Z"><TotalTimeSeconds>300</TotalTimeSeconds><DistanceMeters>2000</DistanceMeters><Calories>50</Calories></Lap>
      <Creator><Name>Edge 540</Name></Creator></Activity></Activities><Author><Name>Connect Api</Name></Author></TrainingCenterDatabase>`;
    const [a] = parseTcx(tcx, utc0);
    expect(a).toMatchObject({ format: "tcx", type: "Ride", movingSec: 900, distanceM: 7000, calories: 150, avgHr: 130, maxHr: 140, device: "Garmin Edge 540", garmin: true });
    expect(a!.laps).toHaveLength(2);
    expect(() => parseTcx("<gpx></gpx>")).toThrow("不是 TCX");
  });
});

describe("轉成紀錄", () => {
  it("跑步 → workouts 的格式；raw_json 讀得出開始時間、裝置與 Garmin 的標示", async () => {
    const [a] = parseFit(fakeFit({ start: START, records: 1200, productName: "Forerunner 265" }));
    const rec = await importRecordOf(a!);
    expect(rec.kind).toBe("run");
    if (rec.kind !== "run") return;
    expect(rec.activity).toMatchObject({ source: "file", date: "2026-10-10", distance_km: 3.6, duration_min: 20, avg_hr: 143, avg_pace: "5:33/km", training_load: null });
    const d = detailsOf(rec.activity.raw_json);
    expect(d).toMatchObject({ startLocal: "2026-10-10T06:30:00", elapsedSec: 1200, garmin: "Garmin Forerunner 265", device: "Garmin Forerunner 265", garminConnect: false });
    expect(rec.id).toMatch(/^[0-9a-f]{32}$/);
    // 同一趟：id 一樣（重複匯入、兩台各匯一次）
    expect((await importRecordOf(parseFit(fakeFit({ start: START, records: 1200 }))[0]!)).id).toBe(rec.id);
  });

  it("騎車 → other_activities，id 是 file:<雜湊>；其他品牌不標 Garmin", async () => {
    const rec = await importRecordOf(parseFit(fakeFit({ sport: 2, manufacturer: 32, productName: "ELEMNT BOLT" }))[0]!);
    expect(rec.kind).toBe("other");
    if (rec.kind !== "other") return;
    expect(rec.activity.intervals_id).toMatch(/^file:[0-9a-f]{32}$/);
    expect(rec.activity.type).toBe("Ride");
    expect(detailsOf(rec.activity.raw_json)).toMatchObject({ garmin: null, device: "Wahoo ELEMNT BOLT" });
  });

  it("心率區間的時間：知道區間時算好存進去，Intervals.icu 的同一個格式", async () => {
    expect(hrZoneTimes([{ t: 0, bpm: 120 }, { t: 1000, bpm: 150 }, { t: 2000, bpm: 200 }], [130, 160, 180])).toEqual([1, 1, 1]);
    const basis = zoneBasisFor("Run", null, { lthr: 170, max_hr: 190, hr_zones: [130, 150, 170, 190], threshold_pace: null });
    expect(basis).toEqual({ bounds: [130, 150, 170, 190], lthr: 170, source: "intervals" });
    expect(zoneBasisFor("Run", null, null, { bounds: [120, 140, 160], lthr: null })?.source).toBe("profile");
    expect(zoneBasisFor("Ride", null, null, { bounds: [120, 140, 160], lthr: null })).toBeNull();
    expect(zoneBasisFor("Ride", null, { lthr: 170, max_hr: 190, hr_zones: [130, 150, 170, 190], threshold_pace: null })).toBeNull();
    const result = await scanFiles([input("a.fit", fakeFit({ records: 100 }))], { zonesFor: () => basis });
    const a = result.activities[0]!;
    expect(a.hrSamples).toEqual([]);
    expect(a.hrZones?.times.reduce((s, x) => s + x, 0)).toBe(90);
    const rec = await importRecordOf(a);
    const d = detailsOf(rec.activity.raw_json);
    expect(d.hrZones).toEqual([130, 150, 170, 190]);
    expect(d.lthr).toBe(170);
    expect(d.hrZoneTimes).toEqual([0, 90, 0, 0]);
    expect(JSON.parse(rec.activity.raw_json!).hr_zones_source).toBe("Intervals.icu 的運動設定");
  });
});

describe("scanFiles", () => {
  it("單一 FIT、單趟的 zip、帳號匯出（壓縮檔裡的壓縮檔，含健康資料與走路）", async () => {
    const day = 86_400;
    const single = zipOne("123_ACTIVITY.fit", fakeFit({ start: START - 2 * day }));
    const uploaded = zipMany([
      ["a.fit", fakeFit({ start: START - 3 * day })],
      ["b.fit", fakeFit({ start: START - 4 * day, sport: 2 })],
      ["c.fit", fakeFit({ start: START - 5 * day, sport: 11 })],
      ["wellness.fit", fakeFit({ fileType: 32 })],
      ["notes.txt", Buffer.from("hi")],
    ]);
    const exportZip = zipMany([
      ["DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip", uploaded, true],
      ["DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part2.zip", zipOne("d.fit", fakeFit({ start: START - 400 * day }))],
      ["DI_CONNECT/DI-Connect-Fitness/summary.json", Buffer.from("{}")],
    ]);
    const progress: number[] = [];
    const result = await scanFiles([input("run.fit", fakeFit({ start: START })), input("single.zip", single), input("export.zip", exportZip)], {
      onProgress: (p) => progress.push(p.files),
    });
    expect(result.activities.map((a) => a.type)).toEqual(["Run", "Run", "Run", "Ride", "Run"]);
    expect(result.files).toBe(7);
    expect(result.notActivity).toBe(1);
    expect([...result.unsupported]).toEqual([["Walk", 1]]);
    expect(result.problems).toEqual([]);
    expect(progress.at(-1)).toBe(7);
  });

  it("只匯入最近 N 個月（since）、同一趟只留一個", async () => {
    const day = 86_400;
    const result = await scanFiles(
      [input("new.fit", fakeFit({ start: START })), input("again.fit", fakeFit({ start: START })), input("old.fit", fakeFit({ start: START - 200 * day }))],
      { since: "2026-06-01" },
    );
    expect(result.activities).toHaveLength(1);
    expect(result.older).toBe(1);
  });

  it("壞檔：記下原因，不中斷其他的", async () => {
    const fit = fakeFit({ start: START });
    const result = await scanFiles([
      input("broken.zip", zipOne("x.fit", fit).subarray(0, 40)),
      input("photo.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])),
      input("bad.fit", Uint8Array.from([14, 0x20, 0, 0, 0, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0, 0x01])),
      input("ok.fit", fit),
    ]);
    expect(result.activities).toHaveLength(1);
    expect(result.problems.map((p) => p.name)).toEqual(["broken.zip", "photo.jpg", "bad.fit"]);
    expect(result.problems[0]!.reason).toMatch(/zip/);
    expect(result.problems[1]!.reason).toMatch(/不是 FIT、GPX、TCX 或 zip/);
  });

  it("取消：停下來，回傳取消前找到的", async () => {
    const controller = new AbortController();
    const files = Array.from({ length: 5 }, (_, i) => [`${i}.fit`, fakeFit({ start: START - i * 86_400 })] as [string, Buffer]);
    const result = await scanFiles([input("many.zip", zipMany(files))], {
      signal: controller.signal,
      onProgress: (p) => {
        if (p.files >= 2) controller.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.activities.length).toBeLessThan(5);
  });
});
