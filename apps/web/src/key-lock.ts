/**
 * 密碼鎖：以使用者的密碼加密 API key 等憑證（PBKDF2-SHA256 → AES-GCM，瀏覽器內建的 WebCrypto）.
 *
 * 只處理加解密，不碰 localStorage，方便在 Node 測試。保存與解鎖的流程在 settings.ts。
 */

/** 會被加密的欄位；其餘設定（供應商、模型、時區）維持明文 */
export interface Secrets {
  apiKey: string;
  proxyToken: string;
  intervalsApiKey: string;
}

/** 存進 localStorage 的密文 */
export interface SealedSecrets {
  v: 1;
  iterations: number;
  salt: string;
  iv: string;
  data: string;
}

/** 解鎖後留在記憶體的金鑰；不可匯出，重新加密時不必再問密碼 */
export interface LockSession {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
}

/** OWASP 對 PBKDF2-HMAC-SHA256 的建議值（2023） */
export const PBKDF2_ITERATIONS = 600_000;

export class WrongPasswordError extends Error {
  constructor() {
    super("密碼不正確");
    this.name = "WrongPasswordError";
  }
}

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** 以同一把金鑰重新加密（每次換新的 IV） */
export async function sealSecrets(session: LockSession, secrets: Secrets): Promise<SealedSecrets> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    session.key,
    new TextEncoder().encode(JSON.stringify(secrets)),
  );
  return {
    v: 1,
    iterations: session.iterations,
    salt: toBase64(session.salt),
    iv: toBase64(iv),
    data: toBase64(new Uint8Array(data)),
  };
}

/** 啟用密碼鎖：產生新的 salt 與金鑰，回傳密文與可沿用的 session */
export async function createLock(
  password: string,
  secrets: Secrets,
  iterations = PBKDF2_ITERATIONS,
): Promise<{ sealed: SealedSecrets; session: LockSession }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const session = { key: await deriveKey(password, salt, iterations), salt, iterations };
  return { sealed: await sealSecrets(session, secrets), session };
}

/** 解鎖：密碼錯誤時丟出 WrongPasswordError（AES-GCM 的驗證標籤對不上） */
export async function openLock(
  sealed: SealedSecrets,
  password: string,
): Promise<{ secrets: Secrets; session: LockSession }> {
  const salt = fromBase64(sealed.salt);
  const session = { key: await deriveKey(password, salt, sealed.iterations), salt, iterations: sealed.iterations };
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64(sealed.iv) }, session.key, fromBase64(sealed.data));
  } catch {
    throw new WrongPasswordError();
  }
  return { secrets: JSON.parse(new TextDecoder().decode(plain)) as Secrets, session };
}
