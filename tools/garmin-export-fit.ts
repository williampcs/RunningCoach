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
import { deflateRawSync } from "node:zlib";

import { bufferSource, fitInfo, localOf, zipEntries, zipRead, type ActivityInfo, type Source } from "./lib/fit";

// ---------------------------------------------------------------------------
// 讀 zip 與 FIT 的程式在 lib/fit.ts；這裡只有讀磁碟上的檔案
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// TCX、GPX 的日期
// ---------------------------------------------------------------------------

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
