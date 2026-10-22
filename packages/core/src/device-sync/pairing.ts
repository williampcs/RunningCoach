/**
 * 把同步金鑰帶到新裝置（規格 12.10）：兩台各產生一組臨時的 ECDH 金鑰，經伺服器交換公開金鑰，
 * 舊裝置把同步金鑰用協商出的金鑰加密後送過去. 伺服器只看到公開金鑰與加密後的內容.
 *
 * 兩台都顯示一組由協商結果算出的六位數字，使用者確認相同才送出、才採用：
 * 伺服器或猜到配對碼的人換掉公開金鑰時，兩邊的數字會不一樣.
 *
 * 數字只有六位，所以不能讓中間人「先看到一邊的數字、再一直換金鑰試出另一邊一樣的數字」：
 * 新裝置建立配對碼時先送出一個亂數的雜湊（承諾），收到舊裝置的公開金鑰之後才公開這個亂數，
 * 數字由兩把公開金鑰與這個亂數一起決定. 換金鑰的人在換之前不知道亂數，只有百萬分之一的機會猜中.
 * QR code 另外帶著新裝置公開金鑰與承諾的指紋，掃描的舊裝置可以直接確認拿到的是對的.
 */
import { fromBase64url, toBase64url, type Key } from "./crypto";

const encoder = new TextEncoder();

export interface PairKey {
  priv: Key;
  /** 公開金鑰（未壓縮的 P-256 點，base64url） */
  pub: string;
}

export async function newPairKey(): Promise<PairKey> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as { privateKey: Key; publicKey: Key };
  // Cloudflare Workers 的型別定義中 exportKey 也可能回傳 JWK；raw 一定是 ArrayBuffer
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  return { priv: pair.privateKey, pub: toBase64url(new Uint8Array(raw)) };
}

async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** 新裝置的亂數（base64url，32 bytes），收到舊裝置的公開金鑰後才公開 */
export function newPairNonce(): string {
  return toBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

/** 對亂數的承諾：先送出這個，之後公開的亂數要對得上 */
export async function pairCommitment(nonce: string): Promise<string> {
  return toBase64url(await sha256(`pair-commit.${nonce}`));
}

/** QR code 裡帶的指紋：新裝置的公開金鑰與承諾（16 bytes） */
export async function pairFingerprint(newPub: string, commitment: string): Promise<string> {
  return toBase64url((await sha256(`pair-fingerprint.${newPub}.${commitment}`)).subarray(0, 16));
}

export interface PairSecrets {
  /** 兩台要顯示的數字，例：「482 913」 */
  confirm: string;
  box: Key;
}

/**
 * 協商：自己的私鑰加上對方的公開金鑰. newPub、oldPub、新裝置的亂數兩台都一樣，
 * 一起放進 HKDF 的 salt，換掉任何一個都會讓結果不同.
 * 舊裝置呼叫前要先用 pairCommitment 確認亂數和一開始的承諾相符
 */
export async function pairSecrets(mine: PairKey, peerPub: string, newPub: string, oldPub: string, nonce: string): Promise<PairSecrets> {
  const peer = await crypto.subtle.importKey("raw", fromBase64url(peerPub) as Uint8Array<ArrayBuffer>, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // Cloudflare Workers 的型別定義把 public 寫成 $public；以標準的參數為準
  const ecdh = { name: "ECDH", public: peer } as unknown as Parameters<typeof crypto.subtle.deriveBits>[0];
  const shared = await crypto.subtle.deriveBits(ecdh, mine.priv, 256);
  const base = await crypto.subtle.importKey("raw", shared, "HKDF", false, ["deriveBits", "deriveKey"]);
  const salt = encoder.encode(`${newPub}.${oldPub}.${nonce}`);
  const confirmBits = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("pair-confirm") }, base, 32),
  );
  const n = new DataView(confirmBits.buffer).getUint32(0) % 1_000_000;
  const digits = String(n).padStart(6, "0");
  const box = await crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt, info: encoder.encode("pair-box") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { confirm: `${digits.slice(0, 3)} ${digits.slice(3)}`, box };
}

export async function sealRoot(secrets: PairSecrets, root: Uint8Array): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, secrets.box, root as Uint8Array<ArrayBuffer>));
  const out = new Uint8Array(12 + cipher.length);
  out.set(iv);
  out.set(cipher, 12);
  return toBase64url(out);
}

export async function openRoot(secrets: PairSecrets, box: string): Promise<Uint8Array> {
  const bytes = fromBase64url(box);
  return new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: bytes.subarray(0, 12) as Uint8Array<ArrayBuffer> }, secrets.box, bytes.subarray(12) as Uint8Array<ArrayBuffer>),
  );
}
