/**
 * 讀 GPX 與 TCX（規格 12.40「讀 FIT 檔」的一部分）：用簡單的文字比對，不靠 DOM（Web Worker 與 Node 都能跑）.
 * GPX 沒有距離與摘要：距離用座標算，時間用頭尾；心率在 Garmin 的擴充欄位（gpxtpx:hr）. 沒有心率時照沒有心率的規則.
 */
import { deviceOffsetMinutes, localText, type ParseOptions } from "./fit";
import type { ParsedActivity, ParsedLap } from "./types";

export class XmlActivityError extends Error {}

const tagText = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${tag}>`).exec(xml);
  return m ? m[1]!.replace(/<!\[CDATA\[|\]\]>/g, "").trim() : null;
};
const tagNumber = (xml: string, tag: string): number | null => {
  const t = tagText(xml, tag);
  const v = t !== null ? Number(t) : NaN;
  return Number.isFinite(v) ? v : null;
};
const blocks = (xml: string, tag: string): string[] => {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*?(?:/>|>[\\s\\S]*?</(?:\\w+:)?${tag}>)`, "g");
  return xml.match(re) ?? [];
};
const attr = (el: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`).exec(el);
  return m ? m[1]! : null;
};

/** 運動的寫法（GPX 的 type、TCX 的 Sport）→ 活動類型 */
function typeOfText(text: string | null): string {
  const t = (text ?? "").toLowerCase();
  if (/trail/.test(t) && /run/.test(t)) return "TrailRun";
  if (/run|^9$|^1$/.test(t)) return "Run";
  if (/virtual.*(ride|cycl)/.test(t)) return "VirtualRide";
  if (/bik|cycl|ride|^2$/.test(t)) return "Ride";
  if (/swim/.test(t)) return "Swim";
  if (/walk/.test(t)) return "Walk";
  if (/hik/.test(t)) return "Hike";
  return t ? "Other" : "Run";
}

const toRad = (d: number) => (d * Math.PI) / 180;
function haversine(a: [number, number], b: [number, number]): number {
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** 兩點相差超過這麼久當成暫停（不算移動時間） */
const PAUSE_SEC = 30;

interface Point {
  t: number;
  hr: number | null;
  ele: number | null;
  pos: [number, number] | null;
  dist: number | null;
}

function summarize(points: Point[]) {
  const sorted = points.filter((p) => Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  let moving = 0;
  let gain = 0;
  let distance = 0;
  for (let i = 1; i < sorted.length; i++) {
    const dt = (sorted[i]!.t - sorted[i - 1]!.t) / 1000;
    if (dt > 0 && dt <= PAUSE_SEC) moving += dt;
    const [e0, e1] = [sorted[i - 1]!.ele, sorted[i]!.ele];
    if (e0 !== null && e1 !== null && e1 > e0) gain += e1 - e0;
    const [p0, p1] = [sorted[i - 1]!.pos, sorted[i]!.pos];
    if (p0 && p1) distance += haversine(p0, p1);
  }
  const hr = sorted.filter((p) => p.hr !== null && p.hr > 0).map((p) => ({ t: p.t, bpm: p.hr! }));
  const deviceDistance = [...sorted].reverse().find((p) => p.dist !== null)?.dist ?? null;
  return { sorted, first, last, moving, gain, distance: deviceDistance ?? (distance > 0 ? distance : null), hr };
}

function hrStats(hr: { bpm: number }[]) {
  return hr.length
    ? { avg: Math.round(hr.reduce((s, x) => s + x.bpm, 0) / hr.length), max: Math.max(...hr.map((x) => x.bpm)) }
    : { avg: null, max: null };
}

const offsetOf = (options: ParseOptions) => options.offsetMinutes ?? deviceOffsetMinutes;

/** GPX → 活動（一個檔一趟；有多個 trk 時合成一趟） */
export function parseGpx(xml: string, options: ParseOptions = {}): ParsedActivity[] {
  if (!/<gpx\b/i.test(xml)) throw new XmlActivityError("不是 GPX 檔");
  const points: Point[] = blocks(xml, "trkpt").map((el) => {
    const lat = Number(attr(el, "lat"));
    const lon = Number(attr(el, "lon"));
    const time = tagText(el, "time");
    return {
      t: time ? Date.parse(time) : NaN,
      hr: tagNumber(el, "hr"),
      ele: tagNumber(el, "ele"),
      pos: Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null,
      dist: null,
    };
  });
  const sum = summarize(points);
  if (!sum.first || !sum.last) return [];
  const creator = attr(/<gpx\b[^>]*>/i.exec(xml)?.[0] ?? "", "creator");
  const trk = blocks(xml, "trk")[0] ?? "";
  const { avg, max } = hrStats(sum.hr);
  const garmin = /^garmin/i.test(creator ?? "");
  const device = creator && /^garmin connect/i.test(creator) ? "Garmin" : creator && /^garmin\s/i.test(creator) ? creator.trim() : null;
  const elapsed = Math.round((sum.last.t - sum.first.t) / 1000);
  return [
    {
      format: "gpx",
      type: typeOfText(tagText(trk, "type")),
      startUtc: new Date(sum.first.t).toISOString().replace(/\.\d{3}Z$/, "Z"),
      startLocal: localText(sum.first.t, offsetOf(options)(sum.first.t)),
      elapsedSec: elapsed > 0 ? elapsed : null,
      movingSec: sum.moving > 0 ? Math.round(sum.moving) : elapsed > 0 ? elapsed : null,
      distanceM: sum.distance,
      avgHr: avg,
      maxHr: max,
      elevationGainM: sum.gain > 0 ? Math.round(sum.gain) : null,
      calories: null,
      avgCadence: null,
      avgPower: null,
      device,
      garmin,
      laps: [],
      hrSamples: sum.hr,
    },
  ];
}

/** TCX → 活動（每個 Activity 一趟） */
export function parseTcx(xml: string, options: ParseOptions = {}): ParsedActivity[] {
  if (!/<TrainingCenterDatabase\b/i.test(xml)) throw new XmlActivityError("不是 TCX 檔");
  const out: ParsedActivity[] = [];
  for (const activity of blocks(xml, "Activity")) {
    const sport = attr(activity, "Sport");
    const laps = blocks(activity, "Lap");
    const points: Point[] = blocks(activity, "Trackpoint").map((el) => {
      const time = tagText(el, "Time");
      const hrBlock = tagText(el, "HeartRateBpm");
      const lat = tagNumber(el, "LatitudeDegrees");
      const lon = tagNumber(el, "LongitudeDegrees");
      return {
        t: time ? Date.parse(time) : NaN,
        hr: hrBlock ? tagNumber(hrBlock, "Value") : null,
        ele: tagNumber(el, "AltitudeMeters"),
        pos: lat !== null && lon !== null ? [lat, lon] : null,
        dist: tagNumber(el, "DistanceMeters"),
      };
    });
    const sum = summarize(points);
    const lapStart = laps.length ? Date.parse(attr(laps[0]!, "StartTime") ?? "") : NaN;
    const start = Number.isFinite(lapStart) ? lapStart : sum.first?.t;
    if (start === undefined || !Number.isFinite(start)) continue;
    const parsedLaps: ParsedLap[] = laps.map((lap) => {
      const avgBlock = tagText(lap, "AverageHeartRateBpm");
      const maxBlock = tagText(lap, "MaximumHeartRateBpm");
      const time = tagNumber(lap, "TotalTimeSeconds");
      const distance = tagNumber(lap.replace(/<Track\b[\s\S]*<\/Track>/, ""), "DistanceMeters");
      return {
        distance_m: distance !== null ? Math.round(distance) : null,
        time_s: time !== null ? Math.round(time) : null,
        avg_hr: avgBlock ? tagNumber(avgBlock, "Value") : null,
        max_hr: maxBlock ? tagNumber(maxBlock, "Value") : null,
      };
    });
    const lapTime = parsedLaps.reduce((s, l) => s + (l.time_s ?? 0), 0);
    const lapDistance = parsedLaps.reduce((s, l) => s + (l.distance_m ?? 0), 0);
    const calories = laps.reduce((s, lap) => s + (tagNumber(lap.replace(/<Track\b[\s\S]*<\/Track>/, ""), "Calories") ?? 0), 0);
    const elapsed = sum.last ? Math.round((sum.last.t - start) / 1000) : lapTime;
    const { avg, max } = hrStats(sum.hr);
    const lapMax = Math.max(0, ...parsedLaps.map((l) => l.max_hr ?? 0));
    const creatorName = tagText(tagText(activity, "Creator") ?? "", "Name");
    const author = tagText(tagText(xml, "Author") ?? "", "Name");
    const garmin = /^garmin/i.test(creatorName ?? "") || /garmin|connect api/i.test(author ?? "");
    const device = creatorName ? (garmin && !/^garmin/i.test(creatorName) ? `Garmin ${creatorName}` : creatorName) : garmin ? "Garmin" : null;
    out.push({
      format: "tcx",
      type: typeOfText(sport),
      startUtc: new Date(start).toISOString().replace(/\.\d{3}Z$/, "Z"),
      startLocal: localText(start, offsetOf(options)(start)),
      elapsedSec: Math.max(elapsed, lapTime) || null,
      movingSec: lapTime || (sum.moving > 0 ? Math.round(sum.moving) : null),
      distanceM: lapDistance || sum.distance,
      avgHr: avg ?? (parsedLaps.some((l) => l.avg_hr) ? Math.round(parsedLaps.reduce((s, l) => s + (l.avg_hr ?? 0) * (l.time_s ?? 0), 0) / (lapTime || 1)) : null),
      maxHr: max ?? (lapMax || null),
      elevationGainM: sum.gain > 0 ? Math.round(sum.gain) : null,
      calories: calories || null,
      avgCadence: null,
      avgPower: null,
      device,
      garmin,
      laps: parsedLaps.length > 1 ? parsedLaps : [],
      hrSamples: sum.hr,
    });
  }
  return out;
}
