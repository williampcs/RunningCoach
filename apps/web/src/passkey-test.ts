/**
 * passkey（PRF）的測試頁（規格 12.44、9.4 的「帳號管理第 2 步」）：只在 staging 與開發用的建置出現。
 * 只在瀏覽器裡做：不連伺服器，不碰使用者的資料與同步。
 * 畫面與「複製結果」都不出現 credential id 與 PRF 的值；PRF 只顯示 SHA-256 的前 8 個字（指紋），用來比對兩次是不是一樣。
 */

/** 網址的 #passkey-test 打開這一頁 */
export const PASSKEY_TEST_HASH = "#passkey-test";

/** 記下這頁建立的 credential id（只給這頁用，存在這台） */
const STORAGE_KEY = "running-coach.passkey-test.credential";

/** 名稱：密碼管理工具裡看到的（測完可以刪掉這把） */
export const PASSKEY_TEST_NAME = "Zone2Mate 測試";

/** 固定的鹽：同一把 passkey 加同一個鹽，每次算出同一個值 */
export const PRF_TEST_SALT: Uint8Array<ArrayBuffer> = new TextEncoder().encode("Zone2Mate passkey PRF test v1");

const TIMEOUT_MS = 120_000;

export interface PlatformInfo {
  /** 例「iOS 18.5 · Safari 18.5」 */
  label: string;
}

/** 從 User-Agent 粗略看出系統與瀏覽器（只用來讓使用者貼回來時知道是哪台） */
export function describePlatform(ua: string, opts: { maxTouchPoints?: number; platformVersion?: string } = {}): PlatformInfo {
  let os = "其他系統";
  const ios = ua.match(/(?:iPhone|iPad|iPod).*? OS (\d+)[_.](\d+)(?:[_.](\d+))?/);
  const android = ua.match(/Android (\d+(?:\.\d+)?)/);
  if (ios) os = `${/iPad/.test(ua) ? "iPadOS" : "iOS"} ${ios[1]}.${ios[2]}${ios[3] ? `.${ios[3]}` : ""}`;
  else if (android) os = `Android ${android[1]}`;
  else if (/Windows NT/.test(ua)) {
    // User-Agent 分不出 10 與 11；有 userAgentData 的 platformVersion 時，13 以上是 Windows 11
    const major = opts.platformVersion ? Number(opts.platformVersion.split(".")[0]) : NaN;
    os = Number.isFinite(major) ? (major >= 13 ? `Windows 11（${opts.platformVersion}）` : `Windows 10（${opts.platformVersion}）`) : "Windows";
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    // iPad 的 Safari 預設用電腦版的 User-Agent：有觸控就是 iPad
    os = (opts.maxTouchPoints ?? 0) > 1 ? "iPadOS（電腦版網頁）" : "macOS";
  } else if (/CrOS/.test(ua)) os = "ChromeOS";
  else if (/Linux/.test(ua)) os = "Linux";

  const pick = (re: RegExp) => ua.match(re)?.[1];
  let browser = "其他瀏覽器";
  const v = (name: string, version?: string) => (version ? `${name} ${version}` : name);
  if (pick(/EdgiOS\/([\d.]+)/) || pick(/EdgA?\/([\d.]+)/)) browser = v("Edge", (pick(/EdgiOS\/(\d+)/) ?? pick(/EdgA?\/(\d+)/)));
  else if (/SamsungBrowser\//.test(ua)) browser = v("Samsung Internet", pick(/SamsungBrowser\/(\d+(?:\.\d+)?)/));
  else if (/CriOS\//.test(ua)) browser = v("Chrome", pick(/CriOS\/(\d+)/));
  else if (/FxiOS\//.test(ua)) browser = v("Firefox", pick(/FxiOS\/(\d+)/));
  else if (/Firefox\//.test(ua)) browser = v("Firefox", pick(/Firefox\/(\d+)/));
  else if (/OPR\//.test(ua)) browser = v("Opera", pick(/OPR\/(\d+)/));
  else if (/Chrome\//.test(ua)) browser = v("Chrome", pick(/Chrome\/(\d+)/));
  else if (/Safari\//.test(ua)) browser = v("Safari", pick(/Version\/(\d+(?:\.\d+)?)/));
  // iPhone 上的瀏覽器都是 WebKit，和 Safari 用同一套 passkey
  if (ios && !browser.startsWith("Safari")) browser += "（WebKit）";
  return { label: `${os} · ${browser}` };
}

/** 錯誤的名稱與訊息；訊息裡像 id 的長字串遮掉（保險：不讓 credential id 出現在畫面或複製的結果） */
export interface ErrorInfo {
  name: string;
  message: string;
}

export function errorInfo(e: unknown): ErrorInfo {
  const name = e instanceof Error || (typeof e === "object" && e !== null && "name" in e) ? String((e as { name: unknown }).name) : "Error";
  const raw = e instanceof Error ? e.message : typeof e === "object" && e !== null && "message" in e ? String((e as { message: unknown }).message) : String(e);
  return { name, message: redact(raw).slice(0, 300) };
}

/** 遮掉 20 個字以上的 base64url／十六進位的字串 */
export function redact(text: string): string {
  return text.replace(/[A-Za-z0-9_\-+/=]{20,}/g, "…");
}

/** base64url（不補 =） */
export function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** PRF 結果的指紋：SHA-256 的前 8 個十六進位字（只用來比對是不是同一個值，推不回原本的值） */
export async function fingerprint(bytes: BufferSource): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest.slice(0, 4), (b) => b.toString(16).padStart(2, "0")).join("");
}

export function loadCredentialId(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function saveCredentialId(id: string | null): void {
  try {
    if (id) localStorage.setItem(STORAGE_KEY, id);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 無痕模式等存不了：這次的頁面還記得，重新整理後就讓使用者自己選
  }
}

/** 建立時拿到的：PRF 有沒有啟用；用哪一種驗證器（這台、或其他裝置例如手機掃 QR） */
export interface CreateResult {
  ok: true;
  /** true：啟用；false：沒有；null：瀏覽器沒有回報 prf */
  prfEnabled: boolean | null;
  /** 建立時就算出了 PRF（有些瀏覽器會）：只記有沒有 */
  prfResultOnCreate: boolean;
  attachment: string | null;
  /** 不顯示：只存在這台的 localStorage，給「算一次」指定這把 */
  credentialId: string;
}

export interface GetResult {
  ok: true;
  /** 拿到 PRF 的結果時是指紋，沒拿到是 null */
  fingerprint: string | null;
  /** 瀏覽器有沒有回報 prf 這個擴充（有回報但沒有 results 也算拿不到） */
  prfReported: boolean;
  attachment: string | null;
  /** 用的是這頁建立的那把（true）、別把（false，例如同步過來的）、不知道（null：這台沒有記下） */
  sameAsCreated: boolean | null;
  /** 這次有沒有指定這頁建立的那把（沒有就是讓使用者自己選） */
  pickedByUser: boolean;
}

export interface Failure {
  ok: false;
  error: ErrorInfo;
}

const randomBytes = (n: number): Uint8Array<ArrayBuffer> => crypto.getRandomValues(new Uint8Array(n));

/** 建立的選項：同步組好，按鈕按下去的同一個動作裡就呼叫（iOS 的 Safari 不能先 await 別的東西） */
export function createOptions(): CredentialCreationOptions {
  return {
    publicKey: {
      // 不指定 id：RP 是目前的網域
      rp: { name: "Zone2Mate" },
      user: { id: randomBytes(16), name: PASSKEY_TEST_NAME, displayName: PASSKEY_TEST_NAME },
      challenge: randomBytes(32),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      timeout: TIMEOUT_MS,
      attestation: "none",
      extensions: { prf: {} },
    },
  };
}

export function getOptions(credentialId: string | null): CredentialRequestOptions {
  return {
    publicKey: {
      challenge: randomBytes(32),
      allowCredentials: credentialId ? [{ type: "public-key", id: fromBase64Url(credentialId) }] : [],
      userVerification: "required",
      timeout: TIMEOUT_MS,
      extensions: { prf: { eval: { first: PRF_TEST_SALT } } },
    },
  };
}

type Prf = { enabled?: boolean; results?: { first?: BufferSource } };

function prfOf(credential: PublicKeyCredential): Prf | undefined {
  return (credential.getClientExtensionResults() as { prf?: Prf }).prf;
}

/** 建立一把測試用的 passkey。呼叫前不要 await 任何東西 */
export function createPasskey(): Promise<CreateResult | Failure> {
  // 第一個 await 之前就呼叫 create
  let pending: Promise<Credential | null>;
  try {
    pending = navigator.credentials.create(createOptions());
  } catch (e) {
    return Promise.resolve({ ok: false, error: errorInfo(e) });
  }
  return pending.then(
    (credential) => {
      if (!(credential instanceof PublicKeyCredential)) return { ok: false, error: { name: "NoCredential", message: "瀏覽器沒有傳回 passkey" } };
      const prf = prfOf(credential);
      return {
        ok: true,
        prfEnabled: typeof prf?.enabled === "boolean" ? prf.enabled : null,
        prfResultOnCreate: !!prf?.results?.first,
        attachment: credential.authenticatorAttachment ?? null,
        credentialId: toBase64Url(new Uint8Array(credential.rawId)),
      };
    },
    (e: unknown) => ({ ok: false, error: errorInfo(e) }),
  );
}

/** 用 passkey 算一次 PRF；credentialId 為 null 時讓使用者自己選。呼叫前不要 await 任何東西 */
export function evaluatePrf(credentialId: string | null, created: string | null): Promise<GetResult | Failure> {
  let pending: Promise<Credential | null>;
  try {
    pending = navigator.credentials.get(getOptions(credentialId));
  } catch (e) {
    return Promise.resolve({ ok: false, error: errorInfo(e) });
  }
  return pending.then(
    async (credential): Promise<GetResult | Failure> => {
      if (!(credential instanceof PublicKeyCredential)) return { ok: false, error: { name: "NoCredential", message: "瀏覽器沒有傳回 passkey" } };
      const prf = prfOf(credential);
      const first = prf?.results?.first;
      const id = toBase64Url(new Uint8Array(credential.rawId));
      return {
        ok: true,
        fingerprint: first ? await fingerprint(first) : null,
        prfReported: prf !== undefined,
        attachment: credential.authenticatorAttachment ?? null,
        sameAsCreated: created ? id === created : null,
        pickedByUser: credentialId === null,
      };
    },
    (e: unknown) => ({ ok: false, error: errorInfo(e) }),
  );
}

/** 瀏覽器回報的能力（getClientCapabilities）：只列和 PRF、passkey 有關的 */
export const CAPABILITY_KEYS = ["extension:prf", "passkeyPlatformAuthenticator", "userVerifyingPlatformAuthenticator", "hybridTransport"];

export function pickCapabilities(all: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(all).filter(([k]) => CAPABILITY_KEYS.includes(k) || /prf/i.test(k)));
}

export interface Environment {
  platform: string;
  webauthn: boolean;
  /** 內建的驗證器（Face ID、指紋、Windows Hello）；null 是不知道 */
  platformAuthenticator: boolean | null;
  /** null：瀏覽器沒有 getClientCapabilities */
  capabilities: Record<string, boolean> | null;
}

export async function detectEnvironment(): Promise<Environment> {
  const nav = navigator as Navigator & { userAgentData?: { getHighEntropyValues?: (hints: string[]) => Promise<{ platformVersion?: string }> } };
  let platformVersion: string | undefined;
  try {
    platformVersion = (await nav.userAgentData?.getHighEntropyValues?.(["platformVersion"]))?.platformVersion;
  } catch {
    platformVersion = undefined;
  }
  const platform = describePlatform(navigator.userAgent, { maxTouchPoints: navigator.maxTouchPoints, platformVersion }).label;
  const webauthn = typeof PublicKeyCredential !== "undefined" && !!navigator.credentials;
  if (!webauthn) return { platform, webauthn, platformAuthenticator: null, capabilities: null };
  let platformAuthenticator: boolean | null = null;
  try {
    platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    platformAuthenticator = null;
  }
  let capabilities: Record<string, boolean> | null = null;
  const pkc = PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> };
  if (typeof pkc.getClientCapabilities === "function") {
    try {
      capabilities = pickCapabilities(await pkc.getClientCapabilities());
    } catch {
      capabilities = null;
    }
  }
  return { platform, webauthn, platformAuthenticator, capabilities };
}

/** 驗證器的種類（authenticatorAttachment） */
export function attachmentLabel(attachment: string | null): string {
  if (attachment === "platform") return "這台的驗證器";
  if (attachment === "cross-platform") return "其他裝置或安全金鑰（例：手機掃 QR）";
  return "驗證器的種類不明";
}

const yesNo = (v: boolean | null, unknown = "不知道") => (v === null ? unknown : v ? "有" : "沒有");

export function prfEnabledLabel(v: boolean | null): string {
  return v === null ? "瀏覽器沒有回報" : v ? "啟用" : "沒有啟用";
}

export function createLine(r: CreateResult | Failure): string {
  if (!r.ok) return `失敗 · ${r.error.name}：${r.error.message}`;
  return ["成功", `PRF ${prfEnabledLabel(r.prfEnabled)}`, ...(r.prfResultOnCreate ? ["建立時就算出了 PRF"] : []), attachmentLabel(r.attachment)].join(" · ");
}

/** 一次「算一次」的結果；prev 是之前成功拿到的指紋（依序），用來說和第幾次一樣 */
export function getLine(r: GetResult | Failure, prev: (string | null)[]): string {
  if (!r.ok) return `失敗 · ${r.error.name}：${r.error.message}`;
  const parts = ["成功"];
  if (r.fingerprint) {
    const same = prev.findIndex((f) => f === r.fingerprint);
    const earlier = prev.some((f) => f);
    parts.push(`拿到 PRF · 指紋 ${r.fingerprint}${same >= 0 ? `（和第 ${same + 1} 次一樣）` : earlier ? "（和之前不一樣）" : ""}`);
  } else parts.push(r.prfReported ? "拿不到 PRF（瀏覽器有回報，沒有結果）" : "拿不到 PRF（瀏覽器沒有回報）");
  // 用了哪一把：指定的就是這頁建立的；自己選的再說選到哪一把（這台沒有記下時不知道）
  if (!r.pickedByUser) parts.push("這頁建立的那把");
  else parts.push(r.sameAsCreated === null ? "自己選的" : r.sameAsCreated ? "自己選了這頁建立的那把" : "自己選了另一把");
  parts.push(attachmentLabel(r.attachment));
  return parts.join(" · ");
}

export interface ReportInput {
  version: string;
  at: Date;
  env: Environment | null;
  create: (CreateResult | Failure) | null;
  gets: (GetResult | Failure)[];
}

/** 「複製結果」的文字：不含 credential id 與 PRF 的值（只有指紋） */
export function buildReport({ version, at, env, create, gets }: ReportInput): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const lines = [`Zone2Mate passkey 測試（${version} · ${when}）`];
  if (env) {
    lines.push(`裝置：${env.platform}`);
    lines.push(`WebAuthn：${yesNo(env.webauthn)}`);
    lines.push(`內建的驗證器：${yesNo(env.platformAuthenticator)}`);
    lines.push(
      `瀏覽器回報的能力：${
        env.capabilities === null
          ? "瀏覽器沒有 getClientCapabilities"
          : Object.keys(env.capabilities).length === 0
            ? "沒有相關的"
            : Object.entries(env.capabilities)
                .map(([k, v]) => `${k} ${v ? "有" : "沒有"}`)
                .join("、")
      }`,
    );
  }
  lines.push(`建立：${create ? createLine(create) : "沒有試"}`);
  if (gets.length === 0) lines.push("算一次：沒有試");
  else {
    lines.push("算一次：");
    const prev: (string | null)[] = [];
    gets.forEach((g, i) => {
      lines.push(`  第 ${i + 1} 次：${getLine(g, prev)}`);
      prev.push(g.ok ? g.fingerprint : null);
    });
  }
  return lines.join("\n");
}
