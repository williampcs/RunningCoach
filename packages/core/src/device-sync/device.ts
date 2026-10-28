/**
 * 每台裝置自己的身分（規格 12.27）. 同步金鑰是所有裝置共用的，伺服器分不出是哪一台；
 * 每台另外有兩組只屬於自己的 P-256 金鑰：
 * - 簽章（ECDSA）：每個請求都簽，伺服器以登記的公開金鑰驗證，移除某台＝伺服器不再接受它的簽章
 * - 收件（ECDH）：換金鑰時，新的同步金鑰各加密一份給每台留下的裝置，留下的裝置不用重新配對
 * 私鑰產生時就設成不可匯出（網頁版存在 IndexedDB）.
 *
 * 伺服器不受信任，所以下面三樣都要混進只有持有同步金鑰的裝置才知道的值，伺服器假造不出來：
 * - 裝置紀錄（名稱、平台）以同步金鑰加密，附加資料綁定這台的兩把公開金鑰：伺服器塞進自己的金鑰會被發現，
 *   換金鑰時也不會把新的同步金鑰加密給它
 * - 給每台的新同步金鑰：加密的金鑰由 ECDH 的結果加上舊的同步金鑰導出
 * - 「已被移除」的證明：舊的同步金鑰導出的 HMAC；沒有證明就不清掉這台的資料
 */
import { fromBase64url, toBase64url, type Key, type SyncKeys } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** 裝置 id：16 bytes 的亂數，base64url */
export const DEVICE_ID = /^[A-Za-z0-9_-]{22}$/;

export interface DeviceIdentity {
  id: string;
  /** 簽章的私鑰（ECDSA P-256，不可匯出） */
  signKey: Key;
  /** 簽章的公開金鑰（未壓縮的點，base64url） */
  signPub: string;
  /** 收件的私鑰（ECDH P-256，不可匯出） */
  boxKey: Key;
  boxPub: string;
}

async function exportRaw(key: Key): Promise<string> {
  // Cloudflare Workers 的型別定義中 exportKey 也可能回傳 JWK；raw 一定是 ArrayBuffer
  return toBase64url(new Uint8Array((await crypto.subtle.exportKey("raw", key)) as ArrayBuffer));
}

export async function newDeviceIdentity(): Promise<DeviceIdentity> {
  const sign = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])) as { privateKey: Key; publicKey: Key };
  const box = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as { privateKey: Key; publicKey: Key };
  return {
    id: toBase64url(crypto.getRandomValues(new Uint8Array(16))),
    signKey: sign.privateKey,
    signPub: await exportRaw(sign.publicKey),
    boxKey: box.privateKey,
    boxPub: await exportRaw(box.publicKey),
  };
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

// ---------------------------------------------------------------------------
// 請求的簽章：方法、路徑（含查詢）、裝置、時間、一次性的亂數、內容的雜湊.
// 伺服器檢查時間在前後 5 分鐘內、亂數沒用過：被錄下來的請求不能再送一次
// ---------------------------------------------------------------------------

export const SIGNATURE_WINDOW_MS = 5 * 60_000;

export interface SignedParts {
  method: string;
  /** 從 /v1/ 開始的路徑與查詢字串 */
  path: string;
  device: string;
  time: number;
  nonce: string;
  /** 內容（原始文字）的 SHA-256，base64url；沒有內容時是空字串的雜湊 */
  bodyHash: string;
}

export const bodyHash = async (body: string) => toBase64url(await sha256(encoder.encode(body)));

export const signedMessage = (p: SignedParts) =>
  ["zone2mate-sync-device-v1", p.method.toUpperCase(), p.path, p.device, String(p.time), p.nonce, p.bodyHash].join("\n");

/** 簽好的請求標頭 */
export async function signRequest(identity: DeviceIdentity, method: string, path: string, body: string, time: number): Promise<Record<string, string>> {
  const nonce = toBase64url(crypto.getRandomValues(new Uint8Array(16)));
  const message = signedMessage({ method, path, device: identity.id, time, nonce, bodyHash: await bodyHash(body) });
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.signKey, encoder.encode(message)));
  return { "x-device": identity.id, "x-time": String(time), "x-nonce": nonce, "x-signature": toBase64url(signature) };
}

export async function verifySignature(signPub: string, message: string, signature: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(signPub) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      fromBase64url(signature) as Uint8Array<ArrayBuffer>,
      encoder.encode(message),
    );
  } catch {
    return false;
  }
}

/** 公開金鑰的格式：未壓縮的 P-256 點（65 bytes） */
export function isP256Point(text: unknown): text is string {
  if (typeof text !== "string" || !/^[A-Za-z0-9_-]{87}$/.test(text)) return false;
  const bytes = fromBase64url(text);
  return bytes.length === 65 && bytes[0] === 4;
}

// ---------------------------------------------------------------------------
// 裝置紀錄：名稱與平台以同步金鑰加密，附加資料綁定空間、裝置 id 與兩把公開金鑰
// ---------------------------------------------------------------------------

export interface DeviceLabel {
  /** 例：「Mac · Edge」，使用者可以改 */
  name: string;
  /** 例：「macOS」「iOS」 */
  platform: string;
}

interface DeviceKeysOf {
  id: string;
  signPub: string;
  boxPub: string;
}

const labelAad = (space: string, d: DeviceKeysOf) => encoder.encode(`device-label|${space}|${d.id}|${d.signPub}|${d.boxPub}`);

/** 名稱最多 40 個字 */
export const LABEL_MAX = 40;

export async function sealLabel(keys: SyncKeys, device: DeviceKeysOf, label: DeviceLabel): Promise<string> {
  const value = { name: label.name.trim().slice(0, LABEL_MAX), platform: label.platform.trim().slice(0, LABEL_MAX) };
  // 補齊到固定長度：伺服器從長度看不出名稱
  const json = encoder.encode(JSON.stringify(value));
  const frame = new Uint8Array(512);
  if (json.length + 2 > frame.length) throw new Error("裝置名稱太長");
  new DataView(frame.buffer).setUint16(0, json.length);
  frame.set(json, 2);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: labelAad(keys.space, device) }, keys.label, frame));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv);
  out.set(cipher, 12);
  return toBase64url(out);
}

/** 解不開（伺服器改過金鑰或內容、或不是用這組同步金鑰寫的）時回傳 null */
export async function openLabel(keys: SyncKeys, device: DeviceKeysOf, sealed: string): Promise<DeviceLabel | null> {
  try {
    const bytes = fromBase64url(sealed);
    const frame = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: bytes.subarray(0, 12) as Uint8Array<ArrayBuffer>, additionalData: labelAad(keys.space, device) },
        keys.label,
        bytes.subarray(12) as Uint8Array<ArrayBuffer>,
      ),
    );
    const length = new DataView(frame.buffer).getUint16(0);
    const value = JSON.parse(decoder.decode(frame.subarray(2, 2 + length))) as Partial<DeviceLabel>;
    if (typeof value.name !== "string" || typeof value.platform !== "string") return null;
    return { name: value.name, platform: value.platform };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 換金鑰：新的同步金鑰各加密一份給每台留下的裝置（ECDH，臨時金鑰對每台各一組）.
// 加密用的金鑰由 ECDH 的結果加上舊同步金鑰導出的值一起導出：伺服器知道每台的公開金鑰，
// 但不知道舊的同步金鑰，假造不出一份能解開的
// ---------------------------------------------------------------------------

async function boxKey(oldKeys: SyncKeys, shared: ArrayBuffer, salt: string): Promise<Key> {
  const ikm = new Uint8Array(32 + oldKeys.rekey.length);
  ikm.set(new Uint8Array(shared));
  ikm.set(oldKeys.rekey, 32);
  const base = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode(salt), info: encoder.encode("rekey-box") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function ecdh(priv: Key, peerPub: string): Promise<ArrayBuffer> {
  const peer = await crypto.subtle.importKey("raw", fromBase64url(peerPub) as Uint8Array<ArrayBuffer>, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Cloudflare Workers 的型別定義把 public 寫成 $public；以標準的參數為準
  const params = { name: "ECDH", public: peer } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  return crypto.subtle.deriveBits(params, priv, 256);
}

const boxSalt = (oldSpace: string, newSpace: string, deviceId: string, ephemeral: string) => `rekey|${oldSpace}|${newSpace}|${deviceId}|${ephemeral}`;

export async function sealRekeyBox(oldKeys: SyncKeys, newRoot: Uint8Array, newSpace: string, device: { id: string; boxPub: string }): Promise<string> {
  const eph = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as { privateKey: Key; publicKey: Key };
  const ephPub = await exportRaw(eph.publicKey);
  const key = await boxKey(oldKeys, await ecdh(eph.privateKey, device.boxPub), boxSalt(oldKeys.space, newSpace, device.id, ephPub));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, newRoot as Uint8Array<ArrayBuffer>));
  return `${ephPub}.${toBase64url(iv)}.${toBase64url(cipher)}`;
}

/** 解不開時丟出錯誤；呼叫的一方還要確認新的同步金鑰導出的空間 id 就是 newSpace */
export async function openRekeyBox(oldKeys: SyncKeys, identity: DeviceIdentity, newSpace: string, box: string): Promise<Uint8Array> {
  const [ephPub = "", iv = "", cipher = ""] = box.split(".");
  if (!isP256Point(ephPub)) throw new Error("新的同步金鑰格式不對");
  const key = await boxKey(oldKeys, await ecdh(identity.boxKey, ephPub), boxSalt(oldKeys.space, newSpace, identity.id, ephPub));
  const root = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) as Uint8Array<ArrayBuffer> }, key, fromBase64url(cipher) as Uint8Array<ArrayBuffer>),
  );
  if (root.length !== 32) throw new Error("新的同步金鑰長度不對");
  return root;
}

// ---------------------------------------------------------------------------
// 「已被移除」的證明
// ---------------------------------------------------------------------------

const removalMessage = (space: string, deviceId: string) => encoder.encode(`removed|${space}|${deviceId}`);

export async function removalProof(keys: SyncKeys, deviceId: string): Promise<string> {
  return toBase64url(new Uint8Array(await crypto.subtle.sign("HMAC", keys.remove, removalMessage(keys.space, deviceId))));
}

export async function verifyRemovalProof(keys: SyncKeys, deviceId: string, proof: unknown): Promise<boolean> {
  if (typeof proof !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(proof)) return false;
  return crypto.subtle.verify("HMAC", keys.remove, fromBase64url(proof) as Uint8Array<ArrayBuffer>, removalMessage(keys.space, deviceId));
}

// ---------------------------------------------------------------------------
// 換金鑰的聲明：換金鑰的那台用自己的簽章金鑰簽「舊空間、新空間、留下與移除的裝置、每份新金鑰的雜湊」.
// 收到「已搬家」或「已被移除」的裝置，只接受本機記得（驗證過的）裝置簽的、而且簽的那台沒有被移除.
// 光有舊的同步金鑰（例如外流的復原碼）加上伺服器配合，假造不出來
// ---------------------------------------------------------------------------

export interface RekeyStatement {
  v: 1;
  /** 舊空間 */
  from: string;
  /** 新空間 */
  to: string;
  keep: string[];
  remove: string[];
  /** 給每台留下的裝置的新金鑰（加密的）的 SHA-256 */
  boxes: Record<string, string>;
}

const statementMessage = (statement: string) => encoder.encode(`zone2mate-rekey-v1\n${statement}`);

export const boxHash = async (box: string) => toBase64url(await sha256(encoder.encode(box)));

export async function signStatement(identity: DeviceIdentity, statement: RekeyStatement): Promise<{ statement: string; signature: string }> {
  const text = JSON.stringify(statement);
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, identity.signKey, statementMessage(text)));
  return { statement: text, signature: toBase64url(signature) };
}

/** 簽章對得上這把公開金鑰時回傳聲明的內容，否則是 null */
export async function verifyStatement(signPub: string, statement: unknown, signature: unknown): Promise<RekeyStatement | null> {
  if (typeof statement !== "string" || typeof signature !== "string" || statement.length > 20_000) return null;
  try {
    const key = await crypto.subtle.importKey("raw", fromBase64url(signPub) as Uint8Array<ArrayBuffer>, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const ok = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, fromBase64url(signature) as Uint8Array<ArrayBuffer>, statementMessage(statement));
    if (!ok) return null;
    const value = JSON.parse(statement) as RekeyStatement;
    if (value.v !== 1 || typeof value.from !== "string" || typeof value.to !== "string") return null;
    if (!Array.isArray(value.keep) || !Array.isArray(value.remove) || !value.boxes || typeof value.boxes !== "object") return null;
    return value;
  } catch {
    return null;
  }
}
