/**
 * 從 Garmin 的「匯出全部資料」找出活動檔，列出各個壓縮檔涵蓋的日期，並把指定日期範圍的活動檔
 * 挑出來，方便自己上傳到 Intervals.icu（規格 12.9：Import all Garmin data 只匯入了一部分時用）.
 *
 * 只讀你電腦上的檔案，不連網、不上傳：
 *   npx tsx tools/garmin-export-fit.ts <匯出檔或資料夾>                       列出日期範圍
 *   npx tsx tools/garmin-export-fit.ts <匯出檔或資料夾> --before 2023-06-01 --out ~/garmin-upload --zip
 * <匯出檔或資料夾> 可以是 Garmin 寄來的整個壓縮檔、解壓後的資料夾，或其中的 UploadedFiles_…_PartN.zip；
 * 可以給好幾個。整個壓縮檔很大時，建議先用系統的解壓縮解開，再給資料夾（比較快，也比較省記憶體）。
 * 選項：
 *   --after 2022-01-01    只挑這天（含）以後的
 *   --before 2023-06-01   只挑這天以前的（不含）
 *   --runs-only           只挑跑步
 *   --out <資料夾>        把挑出來的檔案複製到這裡，檔名改成日期（例：2022-07-03_0630_1.fit）
 *   --zip                 改成每 --batch 個打包成一個 zip（預設 200），可以一次拖進 Intervals.icu
 *
 * 輸出不含個人資訊：原本的檔名（可能含 email）不印也不沿用，只印壓縮檔的檔名、日期與筆數。
 * 活動的日期依檔案裡記錄的當地時間；沒有時用這台電腦的時區。
 */
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { deflateRawSync, inflateRawSync } from "node:zlib";

// ---------------------------------------------------------------------------
// 讀 zip（含 zip64 與壓縮檔裡的壓縮檔），不把整個大檔讀進記憶體
// ---------------------------------------------------------------------------

/** 可以隨機讀取的資料：磁碟上的檔案，或記憶體中的內容（壓縮檔裡的壓縮檔） */
interface Source {
  size: number;
  read(offset: number, length: number): Buffer;
}

function fileSource(path: string): Source & { close(): void } {
  const fd = openSync(path, "r");
  return {
    size: statSync(path).size,
    read(offset, length) {
      const buf = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const n = readSync(fd, buf, done, length - done, offset + done);
        if (n === 0) break;
        done += n;
      }
      return buf.subarray(0, done);
    },
    close: () => closeSync(fd),
  };
}

function bufferSource(buf: Buffer): Source {
  return { size: buf.length, read: (offset, length) => buf.subarray(offset, offset + length) };
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const u64 = (buf: Buffer, at: number) => Number(buf.readBigUInt64LE(at));

function zipEntries(src: Source): ZipEntry[] {
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

function zipRead(src: Source, entry: ZipEntry): Buffer | null {
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

interface ActivityInfo {
  /** 當地時間，例：2022-07-03T06:30 */
  local: string;
  run: boolean | null;
}

const localOf = (utcSeconds: number) => {
  const d = new Date(utcSeconds * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/**
 * 讀 FIT：file_id（類型、建立時間）、activity 的 local_timestamp（當地時間）、session 的 sport.
 * 不是活動（例如每日的健康資料）時回傳 null
 */
function fitInfo(buf: Buffer): ActivityInfo | null {
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

/** TCX、GPX：取第一個時間；TCX 的 Sport 屬性看得出是不是跑步 */
function xmlInfo(text: string, ext: string): ActivityInfo | null {
  const time = text.match(ext === ".tcx" ? /<(?:Id|Time)>([^<]+)</ : /<time>([^<]+)</)?.[1];
  const ms = time ? Date.parse(time) : NaN;
  if (Number.isNaN(ms)) return null;
  const sport = ext === ".tcx" ? text.match(/<Activity\s+Sport="([^"]+)"/)?.[1] : text.match(/<type>([^<]+)</)?.[1];
  return { local: localOf(ms / 1000), run: sport ? /run/i.test(sport) : null };
}

// ---------------------------------------------------------------------------
// 走過匯出檔
// ---------------------------------------------------------------------------

interface Found {
  /** 在哪個壓縮檔（或資料夾）裡 */
  container: string;
  ext: string;
  info: ActivityInfo;
  data: Buffer;
}

const ACTIVITY_EXT = new Set([".fit", ".tcx", ".gpx"]);
const stats = { files: 0, skipped: 0, unreadable: 0 };

function inspect(name: string, data: Buffer, container: string, found: Found[]): void {
  const ext = extname(name).toLowerCase();
  if (ext === ".zip") {
    // 一個壞掉的壓縮檔不影響其他的
    try {
      walkZip(bufferSource(data), basename(name), found);
    } catch (e) {
      stats.unreadable++;
      console.error(`${basename(name)} 讀不了：${e instanceof Error ? e.message : String(e)}`);
    }
    return;
  }
  if (!ACTIVITY_EXT.has(ext)) return;
  stats.files++;
  let info: ActivityInfo | null = null;
  try {
    info = ext === ".fit" ? fitInfo(data) : xmlInfo(data.toString("utf8"), ext);
  } catch {
    stats.unreadable++;
    return;
  }
  if (!info) {
    stats.skipped++;
    return;
  }
  found.push({ container, ext, info, data });
}

function walkZip(src: Source, container: string, found: Found[]): void {
  for (const entry of zipEntries(src)) {
    if (entry.name.endsWith("/")) continue;
    const ext = extname(entry.name).toLowerCase();
    if (ext !== ".zip" && !ACTIVITY_EXT.has(ext)) continue;
    const data = zipRead(src, entry);
    if (!data) {
      stats.unreadable++;
      continue;
    }
    inspect(entry.name, data, container, found);
  }
}

function walk(path: string, found: Found[]): void {
  const st = statSync(path);
  if (st.isDirectory()) {
    for (const child of readdirSync(path).sort()) walk(join(path, child), found);
    return;
  }
  const ext = extname(path).toLowerCase();
  if (ext === ".zip") {
    process.stderr.write(`讀取 ${basename(path)}…\n`);
    const src = fileSource(path);
    try {
      walkZip(src, basename(path), found);
    } catch (e) {
      // 一個壞掉的壓縮檔不影響其他的
      stats.unreadable++;
      console.error(`${basename(path)} 讀不了：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      src.close();
    }
  } else if (ACTIVITY_EXT.has(ext)) {
    inspect(path, readFileSync(path), "（資料夾）", found);
  }
}

// ---------------------------------------------------------------------------
// 寫 zip（只用來把挑出來的檔案打包）
// ---------------------------------------------------------------------------

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

/** zip 的日期與時間（DOS 格式），由檔名開頭的當地時間 YYYY-MM-DD_HHMM 取得 */
function dosTime(name: string): [time: number, date: number] {
  const m = name.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})(\d{2})/);
  if (!m) return [0, 0x21];
  const [y, mo, d, h, mi] = m.slice(1).map(Number) as [number, number, number, number, number];
  return [(h << 11) | (mi << 5), ((Math.max(1980, y) - 1980) << 9) | (mo << 5) | d];
}

function writeZip(path: string, files: { name: string; data: Buffer }[]): void {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name);
    const body = deflateRawSync(f.data);
    const crc = crc32(f.data);
    const [time, date] = dosTime(f.name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 檔名是 UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(8, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(f.data.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt32LE(offset, 42);
    parts.push(local, name, body);
    central.push(cd, name);
    offset += local.length + name.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  writeFileSync(path, Buffer.concat([...parts, cdBuf, end]));
}

// ---------------------------------------------------------------------------
// 主程式
// ---------------------------------------------------------------------------

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    after: { type: "string" },
    before: { type: "string" },
    "runs-only": { type: "boolean", default: false },
    out: { type: "string" },
    zip: { type: "boolean", default: false },
    batch: { type: "string", default: "200" },
  },
});
const DAY = /^\d{4}-\d{2}-\d{2}$/;
for (const key of ["after", "before"] as const) {
  if (args[key] && !DAY.test(args[key]!)) {
    console.error(`--${key} 要寫成 YYYY-MM-DD，例：2023-06-01`);
    process.exit(1);
  }
}
if (!positionals.length) {
  console.error("請給 Garmin 匯出檔（zip）或解壓後的資料夾，例：npx tsx tools/garmin-export-fit.ts ~/Downloads/garmin-export.zip");
  process.exit(1);
}

const found: Found[] = [];
for (const input of positionals) {
  const path = resolve(input.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  if (!existsSync(path)) {
    console.error(`找不到 ${input}`);
    process.exit(1);
  }
  try {
    walk(path, found);
  } catch (e) {
    console.error(`${basename(path)} 讀不了：${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
found.sort((a, b) => a.info.local.localeCompare(b.info.local));

const month = (f: Found) => f.info.local.slice(0, 7);
const isRun = (f: Found) => f.info.run === true;

console.log(`# Garmin 匯出檔裡的活動`);
console.log();
console.log(
  `找到 ${found.length} 個活動檔（跑步 ${found.filter(isRun).length}）` +
    (stats.skipped ? `；另有 ${stats.skipped} 個不是活動的檔案（例如每日的健康資料）略過` : "") +
    (stats.unreadable ? `；${stats.unreadable} 個讀不了` : "") +
    "。",
);
if (!found.length) {
  console.log("沒有找到活動檔：請確認給的是 Garmin 寄來的匯出檔，活動檔在 DI_CONNECT/DI-Connect-Uploaded-Files 裡的 zip。");
  process.exit(0);
}
console.log();

console.log("## 各個壓縮檔");
console.log();
console.log("| 壓縮檔 | 活動 | 跑步 | 最早 | 最晚 |");
console.log("|---|---|---|---|---|");
for (const container of [...new Set(found.map((f) => f.container))]) {
  const of = found.filter((f) => f.container === container);
  console.log(`| ${container} | ${of.length} | ${of.filter(isRun).length} | ${of[0]!.info.local.slice(0, 10)} | ${of.at(-1)!.info.local.slice(0, 10)} |`);
}
console.log();

console.log("## 每個月（可以和 tools/intervals-sources.ts 的結果對照）");
console.log();
console.log("| 月份 | 跑步 | 全部 |");
console.log("|---|---|---|");
const nextMonth = (m: string) => {
  const [y, mm] = m.split("-").map(Number) as [number, number];
  return mm === 12 ? `${y + 1}-01` : `${y}-${String(mm + 1).padStart(2, "0")}`;
};
for (let m = month(found[0]!); m <= month(found.at(-1)!); m = nextMonth(m)) {
  const of = found.filter((f) => month(f) === m);
  console.log(`| ${m} | ${of.filter(isRun).length || "—"} | ${of.length || "—"} |`);
}

const picked = found.filter(
  (f) =>
    (!args.after || f.info.local.slice(0, 10) >= args.after) &&
    (!args.before || f.info.local.slice(0, 10) < args.before) &&
    (!args["runs-only"] || isRun(f)),
);
console.log();
const range = [args.after && `${args.after} 起`, args.before && `${args.before} 以前`, args["runs-only"] && "只有跑步"].filter(Boolean).join("、");
console.log(`符合條件（${range || "全部"}）的有 ${picked.length} 個。`);

if (args.out && picked.length) {
  const dir = resolve(args.out.replace(/^~(?=$|\/)/, process.env.HOME ?? "~"));
  mkdirSync(dir, { recursive: true });
  // 檔名用日期與時間，同一分鐘有好幾個時加序號；不沿用原本的檔名（可能含 email）
  const used = new Map<string, number>();
  const files = picked.map((f) => {
    const stem = f.info.local.replace("T", "_").replace(":", "");
    const n = (used.get(stem) ?? 0) + 1;
    used.set(stem, n);
    return { name: `${stem}_${n}${f.ext}`, data: f.data };
  });
  if (args.zip) {
    const size = Math.max(1, Number(args.batch) || 200);
    const batches = Math.ceil(files.length / size);
    for (let i = 0; i < batches; i++) {
      const batch = files.slice(i * size, (i + 1) * size);
      const first = batch[0]!.name.slice(0, 10);
      const last = batch.at(-1)!.name.slice(0, 10);
      writeZip(join(dir, `garmin-${String(i + 1).padStart(2, "0")}_${first}_${last}.zip`), batch);
    }
    console.log(`已打包成 ${batches} 個 zip（每個最多 ${size} 個），放在 ${dir}。`);
  } else {
    for (const f of files) writeFileSync(join(dir, f.name), f.data);
    console.log(`已複製到 ${dir}。`);
  }
  console.log("到 Intervals.icu 的活動頁按上傳（向上的箭頭），把檔案或 zip 拖進去。");
  console.log("依 Intervals.icu 論壇的說明，已經有的活動會被略過；我們沒有實測，先上傳一個小的 zip 看看結果。");
}
