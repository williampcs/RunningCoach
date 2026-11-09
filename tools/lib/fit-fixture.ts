/**
 * 做一個假的 FIT 活動檔（與裝著它的 zip），給模擬上游與測試用；數值是編的，不是任何人的資料.
 * 內容：file_id、每秒一筆 record（時間、心率、距離、速度、步頻；前 10 筆沒有心率）、一筆 lap、session（跑步）、activity.
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

function data(local: number, fields: Field[]): Buffer {
  const parts = [Buffer.from([local])];
  for (const [, size, , value] of fields) {
    const b = Buffer.alloc(size, 0xff);
    if (value !== null) {
      if (size === 1) b[0] = value;
      else if (size === 2) b.writeUInt16LE(value);
      else b.writeUInt32LE(value);
    }
    parts.push(b);
  }
  return Buffer.concat(parts);
}

/** 假的跑步 FIT：records 筆每秒的紀錄 */
export function fakeRunFit(startUtcSeconds = Date.UTC(2026, 9, 9, 22, 30) / 1000, records = 60): Buffer {
  const t0 = startUtcSeconds - FIT_EPOCH;
  const body: Buffer[] = [];
  const fileId: Field[] = [[0, 1, 0x00, 4], [1, 2, 0x84, 1], [4, 4, 0x86, t0]];
  body.push(definition(0, 0, fileId), data(0, fileId));
  const rec = (i: number): Field[] => [
    [253, 4, 0x86, t0 + i],
    [3, 1, 0x02, i < 10 ? null : 140 + (i % 7)],
    [5, 4, 0x86, i * 300],
    [6, 2, 0x84, 3000],
    [4, 1, 0x02, 85],
  ];
  body.push(definition(1, 20, rec(0)));
  for (let i = 0; i < records; i++) body.push(data(1, rec(i)));
  const lap: Field[] = [[253, 4, 0x86, t0 + records], [2, 4, 0x86, t0], [9, 4, 0x86, records * 300], [15, 1, 0x02, 143]];
  body.push(definition(2, 19, lap), data(2, lap));
  const session: Field[] = [[253, 4, 0x86, t0 + records], [2, 4, 0x86, t0], [5, 1, 0x00, 1], [9, 4, 0x86, records * 300], [16, 1, 0x02, 143]];
  body.push(definition(3, 18, session), data(3, session));
  const activity: Field[] = [[253, 4, 0x86, t0 + records], [5, 4, 0x86, t0 + 8 * 3600]];
  body.push(definition(4, 34, activity), data(4, activity));
  const content = Buffer.concat(body);
  const header = Buffer.alloc(14);
  header[0] = 14;
  header[1] = 0x20;
  header.writeUInt16LE(2132, 2);
  header.writeUInt32LE(content.length, 4);
  header.write(".FIT", 8, "ascii");
  return Buffer.concat([header, content, Buffer.alloc(2)]);
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
  const body = deflateRawSync(content);
  const fileName = Buffer.from(name);
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(fileName.length, 26);
  const cd = Buffer.alloc(46);
  cd.writeUInt32LE(0x02014b50, 0);
  cd.writeUInt16LE(20, 4);
  cd.writeUInt16LE(20, 6);
  cd.writeUInt16LE(8, 10);
  cd.writeUInt32LE(crc, 16);
  cd.writeUInt32LE(body.length, 20);
  cd.writeUInt32LE(content.length, 24);
  cd.writeUInt16LE(fileName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(cd.length + fileName.length, 12);
  end.writeUInt32LE(local.length + fileName.length + body.length, 16);
  return Buffer.concat([local, fileName, body, cd, fileName, end]);
}
