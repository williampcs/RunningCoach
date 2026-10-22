/**
 * 多裝置同步的加密（規格 12.10）. 只用 Web Crypto，瀏覽器與 Node 都能跑.
 *
 * - 同步金鑰（root）是 32 位元組的亂數，只存在使用者的裝置上；不從密碼導出
 * - 以 HKDF 分出：同步空間的 id、向伺服器證明身分的憑證、加密金鑰、紀錄 id 的金鑰。
 *   伺服器拿到 id 與憑證也導不出加密金鑰
 * - 每筆紀錄以 AES-GCM 加密，附加資料（AAD）綁定空間與紀錄 id：伺服器調換紀錄時解密會失敗
 * - 紀錄 id 是內容名稱（例如「p:pref_intensity」）的 HMAC，伺服器看不出是哪一種資料
 * - 加密前補齊到固定的大小級距，伺服器從長度看不出內容
 */
/** Web Crypto 的金鑰；從 crypto.subtle 推得型別，瀏覽器與 Node 的型別定義都適用 */
export type Key = Awaited<ReturnType<typeof crypto.subtle.importKey>>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("running-coach-sync-v1");
const FORMAT = 1;

export function toBase64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export interface SyncKeys {
  /** 同步空間的 id（32 個十六進位字元） */
  space: string;
  /** 向伺服器證明身分的憑證；伺服器只存雜湊 */
  token: string;
  encrypt: Key;
  ids: Key;
}

export function newRootKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function deriveKeys(root: Uint8Array): Promise<SyncKeys> {
  if (root.length !== 32) throw new Error("同步金鑰的長度不對");
  const base = await crypto.subtle.importKey("raw", root as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveBits"]);
  const bits = async (info: string, bytes: number) =>
    new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode(info) }, base, bytes * 8));
  const [space, token, encryptBits, idBits] = await Promise.all([bits("space", 16), bits("auth", 32), bits("encrypt", 32), bits("ids", 32)]);
  return {
    space: hex(space),
    token: toBase64url(token),
    encrypt: await crypto.subtle.importKey("raw", encryptBits as Uint8Array<ArrayBuffer>, "AES-GCM", false, ["encrypt", "decrypt"]),
    ids: await crypto.subtle.importKey("raw", idBits as Uint8Array<ArrayBuffer>, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
  };
}

/** 紀錄的名稱 → 伺服器上的 id（看不出名稱） */
export async function recordId(keys: SyncKeys, name: string): Promise<string> {
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", keys.ids, encoder.encode(name)));
  return toBase64url(mac.subarray(0, 24));
}

/** 補齊後的大小：256 位元組起每級加倍到 64 KB，之後是 64 KB 的倍數 */
export function paddedSize(length: number): number {
  let size = 256;
  while (size < length && size < 65_536) size *= 2;
  return size >= length ? size : Math.ceil(length / 65_536) * 65_536;
}

const aad = (keys: SyncKeys, id: string) => encoder.encode(`${keys.space}|${id}|${FORMAT}`);

export async function seal(keys: SyncKeys, id: string, value: unknown): Promise<string> {
  const json = encoder.encode(JSON.stringify(value));
  const frame = new Uint8Array(paddedSize(json.length + 4));
  new DataView(frame.buffer).setUint32(0, json.length);
  frame.set(json, 4);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(keys, id) }, keys.encrypt, frame));
  const out = new Uint8Array(1 + iv.length + cipher.length);
  out[0] = FORMAT;
  out.set(iv, 1);
  out.set(cipher, 1 + iv.length);
  return toBase64url(out);
}

export async function open(keys: SyncKeys, id: string, blob: string): Promise<unknown> {
  const bytes = fromBase64url(blob);
  if (bytes[0] !== FORMAT) throw new Error("不認得的同步資料格式");
  const frame = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.subarray(1, 13) as Uint8Array<ArrayBuffer>, additionalData: aad(keys, id) },
      keys.encrypt,
      bytes.subarray(13) as Uint8Array<ArrayBuffer>,
    ),
  );
  const length = new DataView(frame.buffer).getUint32(0);
  return JSON.parse(decoder.decode(frame.subarray(4, 4 + length)));
}

// ---------------------------------------------------------------------------
// 復原碼：同步金鑰加上一個檢查用的位元組，以 Crockford base32 寫成 4 個一組
// ---------------------------------------------------------------------------

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

async function checkByte(root: Uint8Array): Promise<number> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", root as Uint8Array<ArrayBuffer>))[0]!;
}

export async function recoveryCode(root: Uint8Array): Promise<string> {
  const bytes = [...root, await checkByte(root)];
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out.match(/.{1,4}/g)!.join("-");
}

/** 讀復原碼；容許小寫、空白與常見的看錯（O→0、I/L→1）。格式不對或檢查碼不符時回傳 null */
export async function parseRecoveryCode(code: string): Promise<Uint8Array | null> {
  const clean = code
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]+$/.test(clean)) return null;
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of clean) {
    value = (value << 5) | ALPHABET.indexOf(c);
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  if (bytes.length !== 33) return null;
  const root = Uint8Array.from(bytes.slice(0, 32));
  return (await checkByte(root)) === bytes[32] ? root : null;
}
