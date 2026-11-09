/**
 * 讀 FIT 活動檔（規格 12.40「讀 FIT 檔」）：只用標準的 JavaScript（Uint8Array、DataView），瀏覽器與 Node 都能跑.
 *
 * 讀的訊息（FIT SDK 的 Profile）：file_id（類型、製造商、產品）、device_info（建立檔案的裝置）、
 * session（每一段運動的摘要）、lap（分圈）、record（每秒的心率，只用來算心率區間的時間，不存）、activity（當地時間）.
 * 不認得的訊息與欄位略過；開發者欄位（例如 Stryd）略過.
 */
import type { ParsedActivity, ParsedLap } from "./types";

/** FIT 的時間從 1989-12-31 00:00 UTC 起算 */
const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;

export class FitError extends Error {}

/** 是不是 FIT 檔（看檔頭的 .FIT） */
export function isFit(buf: Uint8Array): boolean {
  return buf.length >= 12 && buf[8] === 0x2e && buf[9] === 0x46 && buf[10] === 0x49 && buf[11] === 0x54;
}

interface FieldDef {
  num: number;
  size: number;
  base: number;
}
interface MessageDef {
  global: number;
  big: boolean;
  fields: FieldDef[];
  devSize: number;
}

type Value = number | string | null;

/** 各基本型別的寬度（位元組）；陣列的欄位寬度是它的倍數 */
const WIDTH: Record<number, number> = { 0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x88: 4, 0x89: 8, 0x0a: 1, 0x8b: 2, 0x8c: 4, 0x0d: 1, 0x8e: 8, 0x8f: 8, 0x90: 8 };

/** 讀一個欄位；FIT 的「無效值」、陣列與 64 位元的整數是 null（用不到） */
function readValue(view: DataView, bytes: Uint8Array, at: number, f: FieldDef, big: boolean): Value {
  if (at + f.size > bytes.length) return null;
  const le = !big;
  if (f.base === 0x07) {
    let end = at;
    while (end < at + f.size && bytes[end] !== 0) end++;
    if (end === at) return null;
    try {
      return new TextDecoder().decode(bytes.subarray(at, end));
    } catch {
      return null;
    }
  }
  if (WIDTH[f.base] !== f.size) return null;
  switch (f.base) {
    case 0x00:
    case 0x02:
    case 0x0d: {
      const v = bytes[at]!;
      return v === 0xff ? null : v;
    }
    case 0x0a: {
      const v = bytes[at]!;
      return v === 0 ? null : v;
    }
    case 0x01: {
      const v = view.getInt8(at);
      return v === 0x7f ? null : v;
    }
    case 0x83: {
      const v = view.getInt16(at, le);
      return v === 0x7fff ? null : v;
    }
    case 0x84: {
      const v = view.getUint16(at, le);
      return v === 0xffff ? null : v;
    }
    case 0x8b: {
      const v = view.getUint16(at, le);
      return v === 0 ? null : v;
    }
    case 0x85: {
      const v = view.getInt32(at, le);
      return v === 0x7fffffff ? null : v;
    }
    case 0x86: {
      const v = view.getUint32(at, le);
      return v === 0xffffffff ? null : v;
    }
    case 0x8c: {
      const v = view.getUint32(at, le);
      return v === 0 ? null : v;
    }
    case 0x88: {
      const v = view.getFloat32(at, le);
      return Number.isFinite(v) ? v : null;
    }
    case 0x89: {
      const v = view.getFloat64(at, le);
      return Number.isFinite(v) ? v : null;
    }
    default:
      return null;
  }
}

type Fields = Map<number, Value>;
const n = (f: Fields, num: number): number | null => {
  const v = f.get(num);
  return typeof v === "number" ? v : null;
};
const s = (f: Fields, num: number): string | null => {
  const v = f.get(num);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};

/** 讀出來的訊息（只留用得到的） */
export interface FitMessages {
  fileId: Fields | null;
  devices: Fields[];
  sessions: Fields[];
  laps: Fields[];
  /** 每秒的時間（FIT 的秒）與心率 */
  hr: { t: number; bpm: number }[];
  /** 每秒的時間（FIT 的秒），算移動與分段用 */
  recordTimes: number[];
  activity: Fields | null;
}

const KEEP = new Set([0, 18, 19, 20, 23, 34]);

/** 逐筆讀 FIT 的訊息；檔頭不對或讀到一半斷掉時丟 FitError（讀到斷掉之前的仍然保留） */
export function readFitMessages(buf: Uint8Array): FitMessages {
  if (!isFit(buf)) throw new FitError("不是 FIT 檔");
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const headerSize = buf[0]!;
  if (headerSize < 12 || headerSize > buf.length) throw new FitError("FIT 的檔頭壞了");
  const dataSize = view.getUint32(4, true);
  const end = Math.min(buf.length, headerSize + dataSize);
  const defs = new Map<number, MessageDef>();
  const out: FitMessages = { fileId: null, devices: [], sessions: [], laps: [], hr: [], recordTimes: [], activity: null };
  let lastTs: number | null = null;
  let p = headerSize;
  let truncated = false;
  while (p < end) {
    const h = buf[p++]!;
    if (!(h & 0x80) && h & 0x40) {
      if (p + 5 > end) {
        truncated = true;
        break;
      }
      const big = buf[p + 1] === 1;
      const global = big ? view.getUint16(p + 2, false) : view.getUint16(p + 2, true);
      const count = buf[p + 4]!;
      const fields: FieldDef[] = [];
      let q = p + 5;
      for (let i = 0; i < count; i++, q += 3) fields.push({ num: buf[q]!, size: buf[q + 1]!, base: buf[q + 2]! });
      let devSize = 0;
      if (h & 0x20) {
        const devCount = buf[q++]!;
        for (let i = 0; i < devCount; i++, q += 3) devSize += buf[q + 1] ?? 0;
      }
      if (q > end) {
        truncated = true;
        break;
      }
      defs.set(h & 0x0f, { global, big, fields, devSize });
      p = q;
      continue;
    }
    const compressed = (h & 0x80) !== 0;
    const def = defs.get(compressed ? (h >> 5) & 0x03 : h & 0x0f);
    if (!def) throw new FitError("FIT 的內容壞了（找不到訊息的定義）");
    const size = def.fields.reduce((sum, f) => sum + f.size, 0) + def.devSize;
    if (p + size > end) {
      truncated = true;
      break;
    }
    if (compressed && lastTs !== null) {
      // 壓縮的時間戳記：只帶最低 5 位元的秒數
      const offset = h & 0x1f;
      let ts: number = (lastTs & ~0x1f) + offset;
      if (offset < (lastTs & 0x1f)) ts += 0x20;
      lastTs = ts;
    }
    if (KEEP.has(def.global)) {
      const fields: Fields = new Map();
      let q = p;
      for (const f of def.fields) {
        fields.set(f.num, readValue(view, buf, q, f, def.big));
        q += f.size;
      }
      const ts = n(fields, 253);
      if (ts !== null) lastTs = ts;
      else if (compressed && lastTs !== null) fields.set(253, lastTs);
      switch (def.global) {
        case 0:
          out.fileId ??= fields;
          break;
        case 18:
          out.sessions.push(fields);
          break;
        case 19:
          out.laps.push(fields);
          break;
        case 20: {
          const t = n(fields, 253);
          if (t !== null) {
            out.recordTimes.push(t);
            const bpm = n(fields, 3);
            if (bpm !== null && bpm > 0) out.hr.push({ t, bpm });
          }
          break;
        }
        case 23:
          out.devices.push(fields);
          break;
        case 34:
          out.activity ??= fields;
          break;
      }
    } else {
      // 其他訊息只看時間戳記（壓縮時間戳記要接得上）
      let q = p;
      for (const f of def.fields) {
        if (f.num === 253) {
          const v = readValue(view, buf, q, f, def.big);
          if (typeof v === "number") lastTs = v;
        }
        q += f.size;
      }
    }
    p += size;
  }
  if (truncated && !out.sessions.length && !out.recordTimes.length) throw new FitError("FIT 檔不完整（下載中斷？）");
  return out;
}

/** FIT 的製造商（FIT SDK 的 manufacturer，只列確定的；其他的沒有型號名稱時不寫） */
const MANUFACTURERS: Record<number, string> = {
  1: "Garmin",
  23: "Suunto",
  32: "Wahoo",
  123: "Polar",
  260: "Zwift",
  294: "COROS",
};

/** 製造商與型號：建立這個檔的裝置（device_info 的第 0 台，沒有時看 file_id） */
export function deviceOf(m: FitMessages): { manufacturer: number | null; name: string | null } {
  const creator = m.devices.find((d) => n(d, 0) === 0) ?? null;
  const manufacturer = n(creator ?? new Map(), 2) ?? n(m.fileId ?? new Map(), 1);
  const productName = s(creator ?? new Map(), 27) ?? s(m.fileId ?? new Map(), 8);
  const brand = manufacturer !== null ? (MANUFACTURERS[manufacturer] ?? null) : null;
  if (brand === "Garmin") {
    // Garmin 的型號只用檔案裡寫的名字；產品編號的對照表沒有可靠的來源，不猜（只標「Garmin」，品牌規範允許）
    if (productName) return { manufacturer, name: /^garmin(\s|$)/i.test(productName) ? `Garmin${productName.slice(6)}` : `Garmin ${productName}` };
    return { manufacturer, name: "Garmin" };
  }
  if (productName) return { manufacturer, name: brand && !productName.toLowerCase().startsWith(brand.toLowerCase()) ? `${brand} ${productName}` : productName };
  return { manufacturer, name: brand || null };
}

/** FIT 的 sport／sub_sport → 和 Intervals.icu 一樣的活動類型（sports.ts 的 sportOfType 認得） */
export function typeOfFitSport(sport: number | null, subSport: number | null): string {
  switch (sport) {
    case 1:
      if (subSport === 3) return "TrailRun";
      if (subSport === 58) return "VirtualRun";
      return "Run";
    case 2:
      if (subSport === 6 || subSport === 58) return "VirtualRide";
      if (subSport === 8) return "MountainBikeRide";
      if (subSport === 46) return "GravelRide";
      if (subSport === 13) return "TrackRide";
      return "Ride";
    case 5:
      return subSport === 18 ? "OpenWaterSwim" : "Swim";
    case 10:
    case 4:
      return subSport === 20 ? "WeightTraining" : "Workout";
    case 11:
      return "Walk";
    case 17:
      return "Hike";
    case 15:
      return "Rowing";
    case 12:
      return "NordicSki";
    case 21:
      return "Elliptical"; // 不常見；sportOfType 當成其他
    default:
      return "Other";
  }
}

const iso = (fitSeconds: number) => new Date((fitSeconds + FIT_EPOCH) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");

/** UTC 的 ISO 加上時差（分鐘）→ 當地時間的字串（不帶時區，例：2026-10-19T07:12:00） */
export function localText(utcMs: number, offsetMin: number): string {
  return new Date(utcMs + offsetMin * 60_000).toISOString().slice(0, 19);
}

/** 沒有記當地時間的檔：用這台的時區（瀏覽器的設定）換算 */
export const deviceOffsetMinutes = (utcMs: number) => -new Date(utcMs).getTimezoneOffset();

export interface ParseOptions {
  /** 檔案沒有當地時間時，UTC → 當地的時差（分鐘）；預設用這台的時區 */
  offsetMinutes?: (utcMs: number) => number;
}

/** 一個 FIT 檔 → 活動（一般一個；多項運動的檔〔鐵人三項〕每一段一個）. 不是活動的檔（每日健康資料等）回傳空的 */
export function parseFit(buf: Uint8Array, options: ParseOptions = {}): ParsedActivity[] {
  const m = readFitMessages(buf);
  if (!m.fileId && !m.sessions.length && !m.recordTimes.length) throw new FitError("FIT 檔是空的或壞了");
  const fileType = m.fileId ? n(m.fileId, 0) : null;
  // 4 = 活動；沒有 file_id 但有 session 的也當成活動
  if (fileType !== null && fileType !== 4) return [];
  if (fileType === null && !m.sessions.length) return [];
  const device = deviceOf(m);
  // 時差：activity 的 local_timestamp − timestamp
  const actTs = m.activity ? n(m.activity, 253) : null;
  const actLocal = m.activity ? n(m.activity, 5) : null;
  const fileOffset = actTs !== null && actLocal !== null && Math.abs(actLocal - actTs) <= 15 * 3600 ? Math.round((actLocal - actTs) / 60) : null;
  const offsetOf = (utcMs: number) => fileOffset ?? (options.offsetMinutes ?? deviceOffsetMinutes)(utcMs);

  let sessions = m.sessions.filter((x) => n(x, 5) !== 3); // 3 = 轉換區
  if (!sessions.length) {
    // 沒有 session（少數裝置或斷掉的檔）：用每秒的紀錄湊一個
    if (!m.recordTimes.length) return [];
    const t0 = m.recordTimes[0]!;
    const t1 = m.recordTimes[m.recordTimes.length - 1]!;
    const synthetic: Fields = new Map<number, Value>([
      [2, t0],
      [7, (t1 - t0) * 1000],
      [8, (t1 - t0) * 1000],
    ]);
    sessions = [synthetic];
  }
  const out: ParsedActivity[] = [];
  for (const session of sessions) {
    const start = n(session, 2) ?? n(m.fileId ?? new Map(), 4);
    if (start === null) continue;
    const elapsed = (n(session, 7) ?? 0) / 1000;
    const timer = (n(session, 8) ?? 0) / 1000;
    const end = start + Math.max(elapsed, timer, 1);
    const type = typeOfFitSport(n(session, 5), n(session, 6));
    const inSession = <T extends { t: number }>(list: T[]) => list.filter((x) => x.t >= start && x.t <= end);
    const hr = inSession(m.hr);
    const avgHr = n(session, 16) ?? (hr.length ? Math.round(hr.reduce((a, x) => a + x.bpm, 0) / hr.length) : null);
    const maxHr = n(session, 17) ?? (hr.length ? Math.max(...hr.map((x) => x.bpm)) : null);
    const distance = n(session, 9);
    const laps: ParsedLap[] = m.laps
      .filter((l) => {
        const ls = n(l, 2);
        return ls !== null && ls >= start && ls < end;
      })
      .map((l) => ({
        distance_m: n(l, 9) !== null ? Math.round(n(l, 9)! / 100) : null,
        time_s: n(l, 8) !== null ? Math.round(n(l, 8)! / 1000) : n(l, 7) !== null ? Math.round(n(l, 7)! / 1000) : null,
        avg_hr: n(l, 15),
        max_hr: n(l, 16),
      }));
    const utcMs = (start + FIT_EPOCH) * 1000;
    const avgPowerRaw = n(session, 20);
    const ascent = n(session, 22);
    const cadence = n(session, 18);
    out.push({
      format: "fit",
      type,
      startUtc: iso(start),
      startLocal: localText(utcMs, offsetOf(utcMs)),
      elapsedSec: elapsed > 0 ? Math.round(elapsed) : timer > 0 ? Math.round(timer) : null,
      movingSec: timer > 0 ? Math.round(timer) : elapsed > 0 ? Math.round(elapsed) : null,
      distanceM: distance !== null && distance > 0 ? distance / 100 : null,
      avgHr: avgHr && avgHr > 0 ? avgHr : null,
      maxHr: maxHr && maxHr > 0 ? maxHr : null,
      elevationGainM: ascent !== null && ascent > 0 ? ascent : null,
      calories: n(session, 11),
      avgCadence: cadence !== null && cadence > 0 ? cadence : null,
      avgPower: avgPowerRaw !== null && avgPowerRaw > 0 ? avgPowerRaw : null,
      device: device.name,
      garmin: device.manufacturer === 1,
      laps,
      hrSamples: hr.map((x) => ({ t: (x.t + FIT_EPOCH) * 1000, bpm: x.bpm })),
    });
  }
  return out;
}
