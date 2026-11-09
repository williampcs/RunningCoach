/**
 * 讀 zip（含 zip64 與壓縮檔裡的壓縮檔）：隨機讀取，不把整個大檔讀進記憶體（帳號資料匯出可能好幾 GB）.
 * 解壓縮用標準的 DecompressionStream（瀏覽器與 Node 18 以上都有）.
 */

/** 可以隨機讀取的資料：瀏覽器的 File／Blob（slice），或記憶體裡的內容 */
export interface RandomAccess {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export function bytesSource(bytes: Uint8Array): RandomAccess {
  return { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) };
}

/** Blob（瀏覽器的 File 也是 Blob） */
export function blobSource(blob: Blob): RandomAccess {
  return {
    size: blob.size,
    read: async (offset, length) => new Uint8Array(await blob.slice(offset, offset + length).arrayBuffer()),
  };
}

export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

const u16 = (b: Uint8Array, at: number) => b[at]! | (b[at + 1]! << 8);
const u32 = (b: Uint8Array, at: number) => (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16)) + b[at + 3]! * 0x1000000;
const u64 = (b: Uint8Array, at: number) => u32(b, at) + u32(b, at + 4) * 0x100000000;

export const isZip = (head: Uint8Array) => head.length >= 4 && u32(head, 0) === 0x04034b50;

/** zip 的目錄 */
export async function zipEntries(src: RandomAccess): Promise<ZipEntry[]> {
  // 中央目錄的結尾在最後 64 KB 內（註解最長 65535 位元組）
  const tailSize = Math.min(src.size, 65_557);
  const tail = await src.read(src.size - tailSize, tailSize);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError("不是 zip 檔，或檔案不完整（下載中斷？）");
  let count = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  if (cdOffset === 0xffffffff || count === 0xffff || cdSize === 0xffffffff) {
    if (eocd < 20 || u32(tail, eocd - 20) !== 0x07064b50) throw new ZipError("zip64 的格式無法辨識");
    const rec = await src.read(u64(tail, eocd - 20 + 8), 56);
    count = u64(rec, 32);
    cdSize = u64(rec, 40);
    cdOffset = u64(rec, 48);
  }
  if (cdOffset + cdSize > src.size) throw new ZipError("zip 檔不完整（下載中斷？）");
  const cd = await src.read(cdOffset, cdSize);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count && p + 46 <= cd.length; i++) {
    if (u32(cd, p) !== 0x02014b50) break;
    const nameLen = u16(cd, p + 28);
    const extraLen = u16(cd, p + 30);
    const commentLen = u16(cd, p + 32);
    const entry: ZipEntry = {
      method: u16(cd, p + 10),
      compressedSize: u32(cd, p + 20),
      size: u32(cd, p + 24),
      localOffset: u32(cd, p + 42),
      name: decoder.decode(cd.subarray(p + 46, p + 46 + nameLen)),
    };
    // zip64 的大小與位置放在額外欄位，順序固定，只有 0xffffffff 的那幾個才有
    let e = p + 46 + nameLen;
    const extraEnd = e + extraLen;
    while (e + 4 <= extraEnd) {
      const id = u16(cd, e);
      const len = u16(cd, e + 2);
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

/** 資料在 zip 裡的位置（跳過本地的檔頭） */
async function dataOffset(src: RandomAccess, entry: ZipEntry): Promise<number> {
  const local = await src.read(entry.localOffset, 30);
  if (local.length < 30 || u32(local, 0) !== 0x04034b50) throw new ZipError("zip 的內容壞了");
  return entry.localOffset + 30 + u16(local, 26) + u16(local, 28);
}

/** 解壓縮 deflate（raw） */
export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data] as unknown as ConstructorParameters<typeof Blob>[0]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 讀出一個檔（解壓縮後的內容）；不支援的壓縮方式丟 ZipError */
export async function zipRead(src: RandomAccess, entry: ZipEntry): Promise<Uint8Array> {
  const start = await dataOffset(src, entry);
  const data = await src.read(start, entry.compressedSize);
  if (entry.method === 0) return data;
  if (entry.method === 8) {
    try {
      return await inflateRaw(data);
    } catch {
      throw new ZipError("zip 裡的檔案解壓縮失敗（檔案壞了？）");
    }
  }
  throw new ZipError("不支援的壓縮方式");
}

/**
 * 壓縮檔裡的壓縮檔（Garmin 帳號資料匯出的 UploadedFiles_*.zip）：沒有壓縮的直接切一段來讀（不複製），
 * 有壓縮的解開成 Blob（瀏覽器可以放到磁碟上，不一定佔記憶體）
 */
export async function zipOpenNested(src: RandomAccess, entry: ZipEntry): Promise<RandomAccess> {
  const start = await dataOffset(src, entry);
  if (entry.method === 0) {
    return { size: entry.compressedSize, read: (offset, length) => src.read(start + offset, Math.min(length, entry.compressedSize - offset)) };
  }
  if (entry.method !== 8) throw new ZipError("不支援的壓縮方式");
  // 分段讀進來、一邊解壓縮，不一次讀整段
  const CHUNK = 4 * 1024 * 1024;
  let offset = 0;
  const input = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (offset >= entry.compressedSize) {
        controller.close();
        return;
      }
      const length = Math.min(CHUNK, entry.compressedSize - offset);
      controller.enqueue(await src.read(start + offset, length));
      offset += length;
    },
  });
  const blob = await new Response(input.pipeThrough(new DecompressionStream("deflate-raw") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)).blob();
  return blobSource(blob);
}
