/**
 * API key 與 Intervals.icu 的連線跟著加密的同步（規格 12.47「使用者要保管的東西」第一段）.
 *
 * 同步的 sk:<名稱> 紀錄（llm：AI 的 API key；intervals：Intervals.icu 的連線）裡放用同步金鑰（HKDF 分出的另一把）再加密一次的內容：
 * - 同步服務本來就只看到整筆紀錄的密文；
 * - 這台的資料庫沒有加密，key 只以密文存在裡面，要有同步金鑰（設定裡，密碼鎖開著時加密）才解得開；
 * - 同步換了金鑰（移除某台）之後，舊的紀錄用新的金鑰解不開；換金鑰的那台用新的金鑰重新加密.
 * 附加資料（AAD）綁定名稱：把 llm 的內容搬到 intervals 下解不開.
 * sk:share 不是秘密（只有 on／off）：這個同步空間要不要帶 key（每台都照它）.
 */
import { fromBase64url, toBase64url, type Key } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("running-coach-sync-v1");
const FORMAT = "s1";

async function boxKey(root: Uint8Array): Promise<Key> {
  if (root.length !== 32) throw new Error("同步金鑰的長度不對");
  const base = await crypto.subtle.importKey("raw", root as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("synced-secret") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (name: string) => encoder.encode(`${FORMAT}\n${name}`);

/** 把內容（JSON 字串）加密成紀錄裡的 box（每次換新的 IV） */
export async function sealSyncedSecret(root: Uint8Array, name: string, plain: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(name) }, await boxKey(root), encoder.encode(plain)));
  return `${FORMAT}.${toBase64url(iv)}.${toBase64url(data)}`;
}

/** 解開 box；不是用這組同步金鑰加密的（例如換金鑰之前的）、被改過、或名稱對不上時是 null */
export async function openSyncedSecret(root: Uint8Array, name: string, box: string): Promise<string | null> {
  const [format, iv, data] = box.split(".");
  if (format !== FORMAT || !iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) as Uint8Array<ArrayBuffer>, additionalData: aad(name) },
      await boxKey(root),
      fromBase64url(data) as Uint8Array<ArrayBuffer>,
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
