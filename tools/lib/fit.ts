/**
 * 讀 zip 與 FIT 檔的共用程式（tools/garmin-export-fit.ts、tools/garmin-personal-api.ts）.
 * 只用 Node 內建的 zlib，不連網.
 */
import { inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// 讀 zip（含 zip64 與壓縮檔裡的壓縮檔），不把整個大檔讀進記憶體
// ---------------------------------------------------------------------------

/** 可以隨機讀取的資料：磁碟上的檔案，或記憶體中的內容（壓縮檔裡的壓縮檔） */
export interface Source {
  size: number;
  read(offset: number, length: number): Buffer;
}

export function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: (offset, length) => buf.subarray(offset, offset + length) };
}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const u64 = (buf: Buffer, at: number) => Number(buf.readBigUInt64LE(at));

export function zipEntries(src: Source): ZipEntry[] {
  // 中央目錄的結尾在最後 64 KB 內（註解最長 65535 位元組）
  const tailSize = Math.min(src.size, 65_557);
  const tail = src.read(src.size - tailSize, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是 zip 檔，或檔案不完整（下載中斷？）");
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    // zip64：結尾前面還有一段定位資料
    const locator = tail.subarray(eocd - 20, eocd);
    if (locator.readUInt32LE(0) !== 0x07064b50) throw new Error("zip64 的格式無法辨識");
    const rec = src.read(u64(locator, 8), 56);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  const cd = src.read(cdOffset, cdSize);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (cd.readUInt32LE(p) !== 0x02014b50) break;
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    const entry: ZipEntry = {
      method: cd.readUInt16LE(p + 10),
      compressedSize: cd.readUInt32LE(p + 20),
      size: cd.readUInt32LE(p + 24),
      localOffset: cd.readUInt32LE(p + 42),
      name: cd.toString("utf8", p + 46, p + 46 + nameLen),
    };
    // zip64 的大小與位置放在額外欄位，順序固定，只有 0xffffffff 的那幾個才有
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = cd.readUInt16LE(e);
      const len = cd.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (entry.size === 0xffffffff) {
          entry.size = u64(cd, q);
          q += 8;
        }
        if (entry.compressedSize === 0xffffffff) {
          entry.compressedSize = u64(cd, q);
          q += 8;
        }
        if (entry.localOffset === 0xffffffff) entry.localOffset = u64(cd, q);
      }
      e += 4 + len;
    }
    entries.push(entry);
    p = extraEnd + commentLen;
  }
  return entries;
}

export function zipRead(src: Source, entry: ZipEntry): Buffer | null {
  const local = src.read(entry.localOffset, 30);
  if (local.readUInt32LE(0) !== 0x04034b50) return null;
  const start = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = src.read(start, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) return inflateRawSync(data);
  return null;
}

// ---------------------------------------------------------------------------
// 活動檔的日期與運動類型
// ---------------------------------------------------------------------------

/** FIT 的時間從 1989-12-31 00:00 UTC 起算 */
const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;

export interface ActivityInfo {
  /** 當地時間，例：2022-07-03T06:30 */
  local: string;
  run: boolean | null;
}

export const localOf = (utcSeconds: number) => {
  const d = new Date(utcSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 讀 FIT：file_id（類型、建立時間）、activity 的 local_timestamp（當地時間）、session 的 sport.
 * 不是活動（例如每日的健康資料）時回傳 null
 */
export function fitInfo(buf: Buffer): ActivityInfo | null {
  if (buf.length < 12 || buf.toString("ascii", 8, 12) !== ".FIT") return null;
  const headerSize = buf[0]!;
  const end = Math.min(buf.length, headerSize + buf.readUInt32LE(4));
  const defs = new Map<number, { global: number; big: boolean; fields: [number, number][]; devSize: number }>();
  let fileType: number | null = null;
  let created: number | null = null;
  let localTs: number | null = null;
  let sessionStart: number | null = null;
  let sport: number | null = null;
  let p = headerSize;
  while (p < end) {
    const h = buf[p++]!;
    if (h & 0x80) {
      // 壓縮時間戳記的資料訊息
      const def = defs.get((h >> 5) & 0x03);
      if (!def) return null;
      p += def.fields.reduce((s, [, size]) => s + size, 0) + def.devSize;
      continue;
    }
    const localType = h & 0x0f;
    if (h & 0x40) {
      const big = buf[p + 1] === 1;
      const global = big ? buf.readUInt16BE(p + 2) : buf.readUInt16LE(p + 2);
      const n = buf[p + 4]!;
      const fields: [number, number][] = [];
      let q = p + 5;
      for (let i = 0; i < n; i++, q += 3) fields.push([buf[q]!, buf[q + 1]!]);
      let devSize = 0;
      if (h & 0x20) {
        const dn = buf[q++]!;
        for (let i = 0; i < dn; i++, q += 3) devSize += buf[q + 1]!;
      }
      defs.set(localType, { global, big, fields, devSize });
      p = q;
      continue;
    }
    const def = defs.get(localType);
    if (!def) return null;
    let q = p;
    for (const [num, size] of def.fields) {
      const value = (): number | null => {
        if (q + size > buf.length) return null;
        if (size === 1) return buf[q]! === 0xff ? null : buf[q]!;
        if (size === 4) {
          const v = def.big ? buf.readUInt32BE(q) : buf.readUInt32LE(q);
          return v === 0xffffffff ? null : v;
        }
        return null;
      };
      if (def.global === 0 && num === 0) fileType = value();
      else if (def.global === 0 && num === 4) created = value();
      else if (def.global === 34 && num === 5) localTs = value();
      else if (def.global === 18 && num === 2) sessionStart ??= value();
      else if (def.global === 18 && num === 5) sport ??= value();
      q += size;
    }
    p = q + def.devSize;
  }
  // 4 = 活動
  if (fileType !== 4) return null;
  const local = localTs !== null ? new Date((localTs + FIT_EPOCH) * 1000).toISOString().slice(0, 16) : null;
  const utc = sessionStart ?? created;
  if (!local && utc === null) return null;
  // 1 = 跑步（含跑步機、越野等子類型）
  return { local: local ?? localOf(utc! + FIT_EPOCH), run: sport === null ? null : sport === 1 };
}


// ---------------------------------------------------------------------------
// FIT 有哪些欄位（只數筆數，不留數值；Garmin 個人 API 的測試用）
// ---------------------------------------------------------------------------

/** 常見的訊息（FIT SDK 的 Profile）；不在表上的寫成「訊息 #編號」 */
const MESSAGE_NAMES: Record<number, string> = {
  0: "file_id",
  12: "sport",
  18: "session",
  19: "lap",
  20: "record",
  21: "event",
  22: "device_settings",
  23: "device_info",
  34: "activity",
  49: "file_creator",
  78: "hrv",
  101: "length",
  103: "monitoring_info",
  104: "battery",
  206: "field_description",
  207: "developer_data_id",
  216: "time_in_zone",
  285: "jump",
  312: "split",
  313: "split_summary",
};

/** 各訊息裡常見的欄位；253 是所有訊息共用的 timestamp */
const FIELD_NAMES: Record<number, Record<number, string>> = {
  0: { 0: "type", 1: "manufacturer", 2: "product", 3: "serial_number", 4: "time_created" },
  18: {
    0: "event", 2: "start_time", 5: "sport", 6: "sub_sport", 7: "total_elapsed_time", 8: "total_timer_time", 9: "total_distance",
    11: "total_calories", 14: "avg_speed", 16: "avg_heart_rate", 17: "max_heart_rate", 18: "avg_cadence", 20: "avg_power",
    22: "total_ascent", 23: "total_descent", 24: "total_training_effect", 124: "enhanced_avg_speed", 137: "total_anaerobic_training_effect",
  },
  19: { 2: "start_time", 7: "total_elapsed_time", 8: "total_timer_time", 9: "total_distance", 13: "avg_speed", 15: "avg_heart_rate", 16: "max_heart_rate", 17: "avg_cadence", 19: "avg_power", 110: "enhanced_avg_speed" },
  20: {
    0: "position_lat", 1: "position_long", 2: "altitude", 3: "heart_rate", 4: "cadence", 5: "distance", 6: "speed", 7: "power",
    13: "temperature", 39: "vertical_oscillation", 40: "stance_time_percent", 41: "stance_time", 53: "fractional_cadence",
    73: "enhanced_speed", 78: "enhanced_altitude", 83: "vertical_ratio", 84: "stance_time_balance", 85: "step_length",
  },
  23: { 2: "manufacturer", 3: "serial_number", 4: "product", 5: "software_version", 25: "source_type", 27: "product_name" },
  34: { 0: "total_timer_time", 1: "num_sessions", 2: "type", 5: "local_timestamp" },
  78: { 0: "time" },
};

export interface FitFieldCount {
  num: number;
  name: string | null;
  /** 有值的筆數（FIT 的「無效值」不算） */
  withValue: number;
}

export interface FitMessageSummary {
  global: number;
  name: string;
  count: number;
  fields: FitFieldCount[];
  /** 開發者欄位（例如 Stryd 等第三方的資料）出現的次數 */
  developerFields: number;
}

const BASE_SIZE: Record<number, number> = { 0x00: 1, 0x01: 1, 0x02: 1, 0x83: 2, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 1, 0x88: 4, 0x89: 8, 0x0a: 1, 0x8b: 2, 0x8c: 4, 0x0d: 1, 0x8e: 8, 0x8f: 8, 0x90: 8 };

/** FIT 的無效值：全部是 0xFF；有號整數是最大的正數；z 結尾的型別是 0；字串是空的 */
function hasValue(buf: Buffer, at: number, size: number, baseType: number, big: boolean): boolean {
  if (at + size > buf.length || size === 0) return false;
  const bytes = buf.subarray(at, at + size);
  if (baseType === 0x07) return bytes[0] !== 0;
  if (baseType === 0x0a || baseType === 0x8b || baseType === 0x8c || baseType === 0x90) return bytes.some((b) => b !== 0);
  if (bytes.every((b) => b === 0xff)) return false;
  const width = BASE_SIZE[baseType] ?? size;
  if (width !== size) return true; // 陣列：不是全部 0xFF 就算有
  if (baseType === 0x01) return bytes[0] !== 0x7f;
  if (baseType === 0x83) return (big ? bytes.readInt16BE(0) : bytes.readInt16LE(0)) !== 0x7fff;
  if (baseType === 0x85) return (big ? bytes.readInt32BE(0) : bytes.readInt32LE(0)) !== 0x7fffffff;
  return true;
}

/**
 * 列出 FIT 檔裡每一種訊息的筆數，與每個欄位有值的筆數；不回傳任何數值（只有訊息與欄位的名稱、編號、筆數）.
 * 讀不懂（不是 FIT、定義缺漏）時回傳 null
 */
export function fitFieldSummary(buf: Buffer): FitMessageSummary[] | null {
  if (buf.length < 12 || buf.toString("ascii", 8, 12) !== ".FIT") return null;
  const headerSize = buf[0]!;
  const end = Math.min(buf.length, headerSize + buf.readUInt32LE(4));
  const defs = new Map<number, { global: number; big: boolean; fields: [number, number, number][]; devSize: number; devCount: number }>();
  const out = new Map<number, { count: number; fields: Map<number, number>; developerFields: number }>();
  const seen = (global: number) => {
    let m = out.get(global);
    if (!m) out.set(global, (m = { count: 0, fields: new Map(), developerFields: 0 }));
    return m;
  };
  let p = headerSize;
  while (p < end) {
    const h = buf[p++]!;
    const compressed = (h & 0x80) !== 0;
    if (!compressed && h & 0x40) {
      const big = buf[p + 1] === 1;
      const global = big ? buf.readUInt16BE(p + 2) : buf.readUInt16LE(p + 2);
      const n = buf[p + 4]!;
      const fields: [number, number, number][] = [];
      let q = p + 5;
      for (let i = 0; i < n; i++, q += 3) fields.push([buf[q]!, buf[q + 1]!, buf[q + 2]!]);
      let devSize = 0;
      let devCount = 0;
      if (h & 0x20) {
        devCount = buf[q++]!;
        for (let i = 0; i < devCount; i++, q += 3) devSize += buf[q + 1]!;
      }
      defs.set(h & 0x0f, { global, big, fields, devSize, devCount });
      p = q;
      continue;
    }
    const def = defs.get(compressed ? (h >> 5) & 0x03 : h & 0x0f);
    if (!def) return null;
    const m = seen(def.global);
    m.count++;
    m.developerFields += def.devCount;
    let q = p;
    for (const [num, size, baseType] of def.fields) {
      if (hasValue(buf, q, size, baseType, def.big)) m.fields.set(num, (m.fields.get(num) ?? 0) + 1);
      else if (!m.fields.has(num)) m.fields.set(num, 0);
      q += size;
    }
    p = q + def.devSize;
  }
  return [...out]
    .sort(([a], [b]) => a - b)
    .map(([global, m]) => ({
      global,
      name: MESSAGE_NAMES[global] ?? `訊息 #${global}`,
      count: m.count,
      developerFields: m.developerFields,
      fields: [...m.fields]
        .sort(([a], [b]) => a - b)
        .map(([num, withValue]) => ({ num, name: num === 253 ? "timestamp" : (FIELD_NAMES[global]?.[num] ?? null), withValue })),
    }));
}

/** 從 zip（Garmin 下載的原始檔）裡找出第一個 .fit；本身就是 FIT 時直接回傳 */
export function fitFromDownload(data: Buffer): Buffer | null {
  if (data.length >= 12 && data.toString("ascii", 8, 12) === ".FIT") return data;
  if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50) return null;
  const src = bufferSource(data);
  for (const entry of zipEntries(src)) {
    if (!entry.name.toLowerCase().endsWith(".fit")) continue;
    const fit = zipRead(src, entry);
    if (fit) return fit;
  }
  return null;
}
