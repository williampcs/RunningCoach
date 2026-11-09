/**
 * 做一個假的 FIT 活動檔（與裝著它的 zip），給模擬上游與測試用；數值是編的，不是任何人的資料.
 * 內容：file_id、device_info、每秒一筆 record（時間、心率、距離、速度、步頻；前 10 筆沒有心率）、lap、session、activity.
 * 讀 FIT 檔的測試（packages/core/test/activity-files.test.ts）與 E2E 的檔案也用這裡產生.
 */
import { deflateRawSync } from "node:zlib";

const FIT_EPOCH = Date.UTC(1989, 11, 31) / 1000;

type Field = [num: number, size: number, baseType: number, value: number | null];

function definition(local: number, global: number, fields: Field[]): Buffer {
  const b = Buffer.alloc(6 + fields.length * 3);
  b[0] = 0x40 | local;
  b[1] = 0; // 保留
  b[2] = 0; // little endian
  b.writeUInt16LE(global, 3);
  b[5] = fields.length;
  fields.forEach(([num, size, base], i) => {
    b[6 + i * 3] = num;
    b[7 + i * 3] = size;
    b[8 + i * 3] = base;
  });
  return b;
}

function data(local: number, fields: Field[], header = local): Buffer {
  const parts = [Buffer.from([header])];
  for (const [, size, base, value] of fields) {
    const b = Buffer.alloc(size, base === 0x07 ? 0 : 0xff);
    if (value !== null) {
      if (size === 1) b[0] = value;
      else if (size === 2) b.writeUInt16LE(value);
      else b.writeUInt32LE(value);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** 字串欄位（base type 0x07）：定義與資料分開寫 */
function stringData(local: number, fields: Field[], strings: Record<number, string>): Buffer {
  const parts = [Buffer.from([local])];
  for (const [num, size, base, value] of fields) {
    const b = Buffer.alloc(size, base === 0x07 ? 0 : 0xff);
    if (base === 0x07) b.write((strings[num] ?? "").slice(0, size - 1), "utf8");
    else if (value !== null) {
      if (size === 1) b[0] = value;
      else if (size === 2) b.writeUInt16LE(value);
      else b.writeUInt32LE(value);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

function fitFile(content: Buffer): Buffer {
  const header = Buffer.alloc(14);
  header[0] = 14;
  header[1] = 0x20;
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(content.length, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc(2)]);
}

export interface FakeFitOptions {
  /** UTC 開始時間（秒） */
  start?: number;
  /** 每秒的紀錄筆數（也是時間，秒） */
  records?: number;
  /** FIT 的 sport（1 跑步、2 騎車、5 游泳、10 訓練、11 走路）與 sub_sport */
  sport?: number;
  subSport?: number | null;
  /** 每秒前進的距離（公尺） */
  metersPerSec?: number;
  /** 製造商（1 Garmin、294 COROS）與產品編號；productName 有值時寫進 device_info */
  manufacturer?: number;
  product?: number;
  productName?: string | null;
  /** 當地時間比 UTC 快幾分鐘（activity 的 local_timestamp）；null 時不寫 local_timestamp */
  offsetMinutes?: number | null;
  /** 心率：前 10 筆沒有；之後 base + (i % 7) */
  hrBase?: number | null;
  /** 分幾圈（平均分） */
  laps?: number;
  /** 每秒的紀錄用壓縮的時間戳記寫 */
  compressedTimestamps?: boolean;
  /** 不寫 session（只有每秒的紀錄） */
  noSession?: boolean;
  /** file_id 的類型（4 活動；32 是每日的健康資料） */
  fileType?: number;
}

/** 假的 FIT（數值是編的）：file_id、device_info、每秒的 record、lap、session、activity */
export function fakeFit(o: FakeFitOptions = {}): Buffer {
  const start = o.start ?? Date.UTC(2026, 9, 9, 22, 30) / 1000;
  const records = o.records ?? 60;
  const sport = o.sport ?? 1;
  const mps = o.metersPerSec ?? 3;
  const manufacturer = o.manufacturer ?? 1;
  const hrBase = o.hrBase === undefined ? 140 : o.hrBase;
  const t0 = start - FIT_EPOCH;
  const body: Buffer[] = [];
  const fileId: Field[] = [[0, 1, 0x00, o.fileType ?? 4], [1, 2, 0x84, manufacturer], [2, 2, 0x84, o.product ?? 1], [4, 4, 0x86, t0]];
  body.push(definition(0, 0, fileId), data(0, fileId));
  if (o.fileType !== undefined && o.fileType !== 4) return fitFile(Buffer.concat(body));
  const device: Field[] = [[253, 4, 0x86, t0], [0, 1, 0x02, 0], [2, 2, 0x84, manufacturer], [4, 2, 0x84, o.product ?? 1], ...(o.productName ? ([[27, 32, 0x07, null]] as Field[]) : [])];
  body.push(definition(5, 23, device), stringData(5, device, o.productName ? { 27: o.productName } : {}));
  const rec = (i: number, withTs: boolean): Field[] => [
    ...(withTs ? ([[253, 4, 0x86, t0 + i]] as Field[]) : []),
    [3, 1, 0x02, hrBase === null || i < 10 ? null : hrBase + (i % 7)],
    [5, 4, 0x86, Math.round(i * mps * 100)],
    [6, 2, 0x84, Math.round(mps * 1000)],
    [4, 1, 0x02, 85],
  ];
  if (o.compressedTimestamps) {
    // 第一筆帶完整的時間戳記，之後用壓縮的（local 2 的定義沒有 253）
    body.push(definition(1, 20, rec(0, true)), data(1, rec(0, true)));
    body.push(definition(2, 20, rec(1, false)));
    for (let i = 1; i < records; i++) body.push(data(2, rec(i, false), 0x80 | (2 << 5) | ((t0 + i) & 0x1f)));
  } else {
    body.push(definition(1, 20, rec(0, true)));
    for (let i = 0; i < records; i++) body.push(data(1, rec(i, true)));
  }
  const avgHr = hrBase === null ? null : hrBase + 3;
  const lapCount = o.laps ?? 1;
  const lapLen = Math.floor(records / lapCount);
  const lapDef: Field[] = [[253, 4, 0x86, 0], [2, 4, 0x86, 0], [7, 4, 0x86, 0], [8, 4, 0x86, 0], [9, 4, 0x86, 0], [15, 1, 0x02, 0]];
  body.push(definition(3, 19, lapDef));
  for (let l = 0; l < lapCount; l++) {
    const ls = l * lapLen;
    const len = l === lapCount - 1 ? records - ls : lapLen;
    body.push(data(3, [[253, 4, 0x86, t0 + ls + len], [2, 4, 0x86, t0 + ls], [7, 4, 0x86, len * 1000], [8, 4, 0x86, len * 1000], [9, 4, 0x86, Math.round(len * mps * 100)], [15, 1, 0x02, avgHr]]));
  }
  if (!o.noSession) {
    const session: Field[] = [
      [253, 4, 0x86, t0 + records], [2, 4, 0x86, t0], [5, 1, 0x00, sport], [6, 1, 0x00, o.subSport ?? 0],
      [7, 4, 0x86, records * 1000], [8, 4, 0x86, records * 1000], [9, 4, 0x86, Math.round(records * mps * 100)],
      [11, 2, 0x84, Math.round(records / 6)], [16, 1, 0x02, avgHr], [17, 1, 0x02, hrBase === null ? null : hrBase + 6], [22, 2, 0x84, 12],
    ];
    body.push(definition(4, 18, session), data(4, session));
  }
  const offset = o.offsetMinutes === undefined ? 8 * 60 : o.offsetMinutes;
  const activity: Field[] = [[253, 4, 0x86, t0 + records], ...(offset === null ? [] : ([[5, 4, 0x86, t0 + records + offset * 60]] as Field[]))];
  body.push(definition(6, 34, activity), data(6, activity));
  return fitFile(Buffer.concat(body));
}

/** 假的跑步 FIT：records 筆每秒的紀錄 */
export function fakeRunFit(startUtcSeconds = Date.UTC(2026, 9, 9, 22, 30) / 1000, records = 60): Buffer {
  return fakeFit({ start: startUtcSeconds, records });
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 一個檔案的 zip（deflate） */
export function zipOne(name: string, content: Buffer): Buffer {
  return zipMany([[name, content]]);
}

/** 好幾個檔案的 zip；stored 為 true 的不壓縮（Garmin 匯出裡的壓縮檔常是這樣） */
export function zipMany(files: [name: string, content: Buffer, stored?: boolean][]): Buffer {
  const locals: Buffer[] = [];
  const cds: Buffer[] = [];
  let offset = 0;
  for (const [name, content, stored] of files) {
    const body = stored ? content : deflateRawSync(content);
    const fileName = Buffer.from(name);
    const crc = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(fileName.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(stored ? 0 : 8, 10);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(content.length, 24);
    cd.writeUInt16LE(fileName.length, 28);
    cd.writeUInt32LE(offset, 42);
    locals.push(local, fileName, body);
    cds.push(cd, fileName);
    offset += local.length + fileName.length + body.length;
  }
  const cdBuf = Buffer.concat(cds);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cdBuf, end]);
}
