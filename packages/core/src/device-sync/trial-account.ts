/**
 * 免費試用的帳號掛進加密的同步（規格 12.44 第 1 步）.
 *
 * 同步的 ta:<帳號> 紀錄裡放代理的網址與帳號的復原密鑰；新的裝置解開同步之後，拿它向代理換一個自己的憑證.
 * 復原密鑰在紀錄裡再用同步金鑰（HKDF 分出的另一把）加密一次：
 * - 同步服務本來就只看到整筆紀錄的密文；
 * - 這台的資料庫沒有加密，復原密鑰只以密文存在裡面，要有同步金鑰（設定裡，密碼鎖開著時加密）才解得開；
 * - 同步換了金鑰（移除某台）之後，舊的紀錄用新的金鑰解不開；留下的那台換一把新的復原密鑰（代理那邊舊的作廢）.
 * 附加資料（AAD）綁定代理的網址與帳號：把紀錄搬到別的帳號或網址下解不開.
 */
import { fromBase64url, toBase64url, type Key } from "./crypto";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SALT = encoder.encode("running-coach-sync-v1");
const FORMAT = "t1";

async function boxKey(root: Uint8Array): Promise<Key> {
  if (root.length !== 32) throw new Error("同步金鑰的長度不對");
  const base = await crypto.subtle.importKey("raw", root as Uint8Array<ArrayBuffer>, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: SALT, info: encoder.encode("trial-account") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

const aad = (url: string, account: string) => encoder.encode(`${FORMAT}\n${url}\n${account}`);

/** 代理的網址：去掉結尾的斜線，比對時一致 */
export const normalizeProxyUrl = (url: string) => url.trim().replace(/\/+$/, "");

/** 把復原密鑰加密成紀錄裡的 box（每次換新的 IV） */
export async function sealTrialSecret(root: Uint8Array, url: string, account: string, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(normalizeProxyUrl(url), account) }, await boxKey(root), encoder.encode(secret)),
  );
  return `${FORMAT}.${toBase64url(iv)}.${toBase64url(data)}`;
}

/** 解開 box；不是用這組同步金鑰加密的（例如換金鑰之前的）、被改過、或帳號與網址對不上時是 null */
export async function openTrialSecret(root: Uint8Array, url: string, account: string, box: string): Promise<string | null> {
  const [format, iv, data] = box.split(".");
  if (format !== FORMAT || !iv || !data) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromBase64url(iv) as Uint8Array<ArrayBuffer>, additionalData: aad(normalizeProxyUrl(url), account) },
      await boxKey(root),
      fromBase64url(data) as Uint8Array<ArrayBuffer>,
    );
    return decoder.decode(plain);
  } catch {
    return null;
  }
}
