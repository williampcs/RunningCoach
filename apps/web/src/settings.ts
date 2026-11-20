/**
 * 使用者設定 — 存在這個瀏覽器的 localStorage. 設定本身不上傳；開著多裝置同步、選了「帶到其他裝置」時，
 * API key 與 Intervals.icu 的連線另外加密後跟著同步（規格 12.47，secret-sync.ts）.
 */
import {
  AnthropicProvider,
  TERMS_VERSION,
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type Effort,
  type LlmProvider,
  type Purpose,
} from "@running-coach/core";

import { createLock, openLock, passwordMatches, sealSecrets, type LockSession, type SealedSecrets, type Secrets } from "./key-lock";
import { SCOPED_KEYS, storageKey } from "./storage-scope";
import { TRIAL_MODEL } from "./trial";

// 測試模式用自己一份（storage-scope.ts）：這個頁面在測試模式時，兩個都是測試的那一份
const STORAGE_KEY = () => storageKey(SCOPED_KEYS.settings);
/** 啟用密碼鎖時，API key 等憑證以密文存在這裡，STORAGE_KEY 裡的對應欄位留空 */
const LOCK_KEY = () => storageKey(SCOPED_KEYS.lock);
/** API key 與 Intervals.icu 的連線在這台最後改的時間（規格 12.47）：只有時間，沒有 key */
const STAMPS_KEY = () => storageKey(SCOPED_KEYS.secretStamps);
const SHARE_OK_KEY = () => storageKey(SCOPED_KEYS.secretShare);

/** 解鎖後的金鑰與憑證只放在記憶體；重新載入頁面就要再輸入一次密碼 */
let lockSession: LockSession | null = null;
let unlockedSecrets: Secrets | null = null;

export type ProviderKind = "anthropic" | "openai" | "gemini" | "openai-compatible";

export interface AppSettings {
  /** byok：自己的 API key，直連供應商；proxy：免費試用（邀請碼），經作者的代理轉發（規格 12.39） */
  llmMode: "byok" | "proxy";
  provider: ProviderKind;
  apiKey: string;
  /** 僅「其他相容服務」需要 */
  baseURL: string;
  models: Record<Purpose, string>;
  chatEffort: Effort;
  /** account：這台的憑證屬於哪個試用帳號（同步裡的復原密鑰記在它下面，規格 12.44）；不是秘密，舊的設定沒有 */
  proxy: { url: string; token: string; account?: string | null };
  /**
   * Intervals.icu：API key（Basic），或用 Intervals.icu 登入拿到的 token（Bearer，規格 12.37）與那個帳號.
   * token 和 API key 一樣存在這台（密碼鎖開著時加密）；同步開著、選了「帶到其他裝置」時另外加密後跟著同步（規格 12.47，secret-sync.ts）
   */
  intervals: { apiKey: string; athleteId: string; accessToken: string; account: { id: string | null; name: string | null } | null };
  /** 多裝置同步（規格 12.10）：服務網址與同步金鑰（base64url；空白表示沒有開啟） */
  sync: { url: string; key: string };
  timeZone: string;
  /**
   * 查天氣用的城市（規格 11 #26），座標已四捨五入到 0.1°. 只用來查天氣：只存在這個瀏覽器，
   * 不進資料庫、不同步，也不給模型看（Coach 只拿到 WeatherSource）
   */
  weather: { label: string; lat: number; lon: number } | null;
  /** 使用者已確認過資料流向的組合，例：byok:anthropic */
  consents: string[];
  /** 使用者確認過的使用須知（規格 12.32）：版本與日期，只存在這個瀏覽器；版本比 TERMS_VERSION 舊時再請他確認一次 */
  terms: { version: number; date: string } | null;
}

export const PROVIDER_LABELS: Record<ProviderKind, string> = {
  anthropic: "Anthropic（Claude）",
  openai: "OpenAI",
  gemini: "Google（Gemini）",
  "openai-compatible": "其他 OpenAI 相容服務",
};

/** 內容實際會送達的對象，用於資料流向說明 */
export const PROVIDER_RECIPIENT: Record<ProviderKind, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Google",
  "openai-compatible": "你填寫的服務網址",
};

const CLAUDE_MODELS: Record<Purpose, string> = {
  chat: "claude-opus-5-5",
  summary: "claude-haiku-5-5",
  compress: "claude-sonnet-5-5",
};

export function defaultSettings(): AppSettings {
  return {
    llmMode: "byok",
    provider: "anthropic",
    apiKey: "",
    baseURL: "",
    models: { ...CLAUDE_MODELS },
    chatEffort: "medium",
    proxy: { url: import.meta.env.VITE_PROXY_URL ?? "", token: "" },
    intervals: { apiKey: "", athleteId: "", accessToken: "", account: null },
    sync: { url: import.meta.env.VITE_SYNC_URL ?? "", key: "" },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
    weather: null,
    consents: [],
    terms: null,
  };
}

function loadPlainSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY()) ?? "null") as Partial<AppSettings> | null;
    if (!stored) return defaults;
    return {
      ...defaults,
      ...stored,
      models: { ...defaults.models, ...stored.models },
      // 代理的網址也以建置時的為準（staging 與正式各有自己的代理）
      proxy: { ...defaults.proxy, ...stored.proxy, url: defaults.proxy.url || stored.proxy?.url || "" },
      intervals: { ...defaults.intervals, ...stored.intervals },
      // 服務網址以建置時的為準：換了部署位置時不必每台重設
      sync: { ...defaults.sync, key: stored.sync?.key ?? "", url: defaults.sync.url || stored.sync?.url || "" },
    };
  } catch {
    return defaults;
  }
}

function secretsOf(s: AppSettings): Secrets {
  return { apiKey: s.apiKey, proxyToken: s.proxy.token, intervalsApiKey: s.intervals.apiKey, syncKey: s.sync.key, intervalsToken: s.intervals.accessToken };
}

function withSecrets(s: AppSettings, secrets: Secrets): AppSettings {
  return {
    ...s,
    apiKey: secrets.apiKey,
    proxy: { ...s.proxy, token: secrets.proxyToken },
    intervals: { ...s.intervals, apiKey: secrets.intervalsApiKey, accessToken: secrets.intervalsToken ?? "" },
    sync: { ...s.sync, key: secrets.syncKey ?? "" },
  };
}

const NO_SECRETS: Secrets = { apiKey: "", proxyToken: "", intervalsApiKey: "", syncKey: "", intervalsToken: "" };

/** 這個瀏覽器存過設定嗎（設定精靈只給從來沒設定過的人，規格 12.35 的 A） */
export function hasStoredSettings(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY()) !== null || localStorage.getItem(LOCK_KEY()) !== null;
  } catch {
    return false;
  }
}

/** 設定；啟用密碼鎖時，憑證只有在解鎖後才會出現 */
export function loadSettings(): AppSettings {
  const plain = loadPlainSettings();
  return lockEnabled() ? withSecrets(plain, unlockedSecrets ?? NO_SECRETS) : plain;
}

// ---------------------------------------------------------------------------
// 跟著同步的 key（規格 12.47）：哪些欄位算一樣、這台什麼時候改的
// ---------------------------------------------------------------------------

export type SecretName = "llm" | "intervals";
export const SECRET_NAMES: SecretName[] = ["llm", "intervals"];

/** AI 的 API key（自己的 key 才有；免費試用的憑證不跟同步，每台一個） */
export interface LlmSecret {
  provider: ProviderKind;
  apiKey: string;
  baseURL: string;
  models: Record<Purpose, string>;
}
export type IntervalsSecret = AppSettings["intervals"];

/** 這台不參與 llm 的同步：用免費試用（試用的憑證每台一個；不送這台的、也不拿別台的蓋掉） */
export const secretSkipped = (s: AppSettings, name: SecretName) => name === "llm" && s.llmMode === "proxy";

/** 這台要帶到其他裝置的內容；沒有（還沒填、清掉了）時是 null */
export function secretOf(s: AppSettings, name: "llm"): LlmSecret | null;
export function secretOf(s: AppSettings, name: "intervals"): IntervalsSecret | null;
export function secretOf(s: AppSettings, name: SecretName): LlmSecret | IntervalsSecret | null;
export function secretOf(s: AppSettings, name: SecretName): LlmSecret | IntervalsSecret | null {
  if (name === "llm") {
    if (s.llmMode !== "byok" || !s.apiKey.trim()) return null;
    return { provider: s.provider, apiKey: s.apiKey, baseURL: s.baseURL, models: { ...s.models } };
  }
  if (!intervalsConnected(s)) return null;
  const { apiKey, athleteId, accessToken, account } = s.intervals;
  return { apiKey, athleteId, accessToken, account: account ? { id: account.id, name: account.name } : null };
}

/** 兩份內容一樣嗎（欄位順序不算） */
export function sameSecret(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, norm((v as Record<string, unknown>)[k])]),
        )
      : v;
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * 每一樣在這台的同步狀態（只有時間與旗標，沒有 key）：
 * - at：這台現在這份的時間（這台改的時間，或帶進來的那份的時間，最多到帶進來時的「現在＋幾分鐘」）
 * - seen：這台最後一次和雲端一致時，雲端那份的時間（原樣）；雲端之後換了才算「另一台改過」
 * - edited：這台在那之後自己改過（還沒送上去）. 這台的修改不會被默默蓋掉
 */
export interface SecretStamp {
  at: string;
  seen: string | null;
  edited: boolean;
}

export function secretStamps(): Partial<Record<SecretName, SecretStamp>> {
  try {
    const value = JSON.parse(localStorage.getItem(STAMPS_KEY()) ?? "{}") as Record<string, Partial<SecretStamp>>;
    const out: Partial<Record<SecretName, SecretStamp>> = {};
    for (const n of SECRET_NAMES) {
      const v = value[n];
      if (v && typeof v.at === "string") out[n] = { at: v.at, seen: typeof v.seen === "string" ? v.seen : null, edited: v.edited === true };
    }
    return out;
  } catch {
    return {};
  }
}

export function setSecretStamp(name: SecretName, stamp: SecretStamp): void {
  try {
    localStorage.setItem(STAMPS_KEY(), JSON.stringify({ ...secretStamps(), [name]: stamp }));
  } catch {
    // 記不住就當成不知道什麼時候改的：兩台不同時問使用者
  }
}

/** 這台的修改的時間：至少比這台現在這份晚（這台的修改一定比它看過的新） */
function editStamp(old: SecretStamp | undefined, now: Date): SecretStamp {
  const after = old ? Date.parse(old.at) + 1 : 0;
  const at = new Date(Math.max(now.getTime(), Number.isFinite(after) ? after : 0)).toISOString();
  return { at, seen: old?.seen ?? null, edited: true };
}

/**
 * 存設定時：跟著同步的內容變了（填了、換了 key），記成這台的修改.
 * 變成空的不算（App 自己清的，例如被移除、忘記密碼）：當成「沒有意見」，之後照雲端的；
 * 使用者在畫面上清掉、而且這台同意帶 key 時，畫面另外呼叫 markUserCleared() 才會把「已清除」送出去
 */
function stampChanges(prev: AppSettings, next: AppSettings, now = new Date()): void {
  const stamps = secretStamps();
  for (const name of SECRET_NAMES) {
    // 換成免費試用不算清掉 key
    if (secretSkipped(next, name)) continue;
    const value = secretOf(next, name);
    if (sameSecret(secretOf(prev, name), value)) continue;
    const old = stamps[name];
    if (value === null) {
      if (old) setSecretStamp(name, { at: old.at, seen: old.seen, edited: false });
      continue;
    }
    setSecretStamp(name, editStamp(old, now));
  }
}

/** 使用者在畫面上清掉了 key 或中斷了連結（這台同意帶 key 時才呼叫）：「已清除」算這台的修改，下次同步送出去 */
export function markUserCleared(name: SecretName, now = new Date()): void {
  setSecretStamp(name, editStamp(secretStamps()[name], now));
}

/** 這台同意把自己的 key 帶上去的那一次「提供分享」（sk:share 的時間）；拒絕的是 declined:時間 */
export function shareAgreement(): string | null {
  try {
    return localStorage.getItem(SHARE_OK_KEY());
  } catch {
    return null;
  }
}

export function setShareAgreement(value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(SHARE_OK_KEY());
    else localStorage.setItem(SHARE_OK_KEY(), value);
  } catch {
    // 記不住：下次再問
  }
}

/** 被移除、全部重置：跟著同步的 key 在這台的狀態一起清掉（之後重新加入時當成沒有意見、也重新問要不要帶） */
export function clearSecretSyncState(): void {
  try {
    localStorage.removeItem(STAMPS_KEY());
    localStorage.removeItem(SHARE_OK_KEY());
  } catch {
    // 清不掉：照樣不會送「已清除」（清掉的 key 不算修改）
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  if (lockEnabled()) {
    if (!lockSession) throw new Error("密碼鎖尚未解鎖，無法儲存設定");
    stampChanges(withSecrets(loadPlainSettings(), unlockedSecrets ?? NO_SECRETS), settings);
    const sealed = await sealSecrets(lockSession, secretsOf(settings));
    localStorage.setItem(LOCK_KEY(), JSON.stringify(sealed));
    localStorage.setItem(STORAGE_KEY(), JSON.stringify(withSecrets(settings, NO_SECRETS)));
    unlockedSecrets = secretsOf(settings);
    return;
  }
  stampChanges(loadPlainSettings(), settings);
  localStorage.setItem(STORAGE_KEY(), JSON.stringify(settings));
}

/** 刪除儲存的設定（含 API key 與密碼鎖），下次載入時回到預設值 */
export function clearSettings(): void {
  localStorage.removeItem(STORAGE_KEY());
  localStorage.removeItem(LOCK_KEY());
  clearSecretSyncState();
}

// ---------------------------------------------------------------------------
// 密碼鎖（選用）
// ---------------------------------------------------------------------------

export function lockEnabled(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY()) !== null;
  } catch {
    return false;
  }
}

/** 已啟用密碼鎖、但這次開啟頁面後還沒輸入密碼 */
export function needsUnlock(): boolean {
  return lockEnabled() && lockSession === null;
}

/** 密碼錯誤時丟出 WrongPasswordError */
export async function unlock(password: string): Promise<void> {
  const sealed = JSON.parse(localStorage.getItem(LOCK_KEY()) ?? "null") as SealedSecrets | null;
  if (!sealed) throw new Error("沒有啟用密碼鎖");
  const opened = await openLock(sealed, password);
  lockSession = opened.session;
  unlockedSecrets = opened.secrets;
}

/** 已解鎖後再確認一次密碼（顯示復原碼、新增裝置前，規格 12.26）；不改變解鎖的狀態 */
export async function checkPassword(password: string): Promise<boolean> {
  const sealed = JSON.parse(localStorage.getItem(LOCK_KEY()) ?? "null") as SealedSecrets | null;
  if (!sealed) throw new Error("沒有啟用密碼鎖");
  return passwordMatches(sealed, password);
}

/** 以密碼加密目前的憑證，明文設定裡的憑證改為空白 */
export async function enableLock(password: string, settings: AppSettings): Promise<void> {
  const { sealed, session } = await createLock(password, secretsOf(settings));
  localStorage.setItem(LOCK_KEY(), JSON.stringify(sealed));
  localStorage.setItem(STORAGE_KEY(), JSON.stringify(withSecrets(settings, NO_SECRETS)));
  lockSession = session;
  unlockedSecrets = secretsOf(settings);
}

/** 停用密碼鎖：憑證改回以明文保存 */
export function disableLock(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY(), JSON.stringify(settings));
  localStorage.removeItem(LOCK_KEY());
  lockSession = null;
  unlockedSecrets = null;
}

/** 忘記密碼：刪除加密的憑證（其餘設定保留），之後要重新填寫 key */
export function forgetLockedSecrets(): void {
  localStorage.removeItem(LOCK_KEY());
  lockSession = null;
  unlockedSecrets = null;
}

/** 切換供應商時的建議模型；Claude 以外的模型名稱由使用者填寫 */
export function suggestedModels(mode: AppSettings["llmMode"], provider: ProviderKind): Record<Purpose, string> {
  // 免費試用的模型由代理決定（選手不能改）；本機記成同一個，顯示與費用的估算才一致
  if (mode === "proxy") return { chat: TRIAL_MODEL, summary: TRIAL_MODEL, compress: TRIAL_MODEL };
  return provider === "anthropic" ? { ...CLAUDE_MODELS } : { chat: "", summary: "", compress: "" };
}

/**
 * 資料流向的同意綁在「送到誰」：自己的 key 綁供應商；其他相容服務再綁服務網址（換了網址要重新確認，
 * 同步帶進來的設定也一樣，規格 12.47）
 */
export const consentKey = (s: AppSettings) =>
  s.llmMode === "proxy" ? "proxy" : s.provider === "openai-compatible" ? `byok:openai-compatible:${s.baseURL.trim().replace(/\/+$/, "")}` : `byok:${s.provider}`;

/** 已確認過這一版的使用須知（規格 12.32） */
export const termsAccepted = (s: AppSettings) => s.terms?.version === TERMS_VERSION;

/**
 * 用過 App 的人（確認過資料流向）還沒確認過這一版的使用須知：打開時請他確認一次（App 只在打開時看）.
 * 第一次用的人在設定的「AI 教練」和資料流向一起勾選，不另外問
 */
export const needsTermsConfirm = (s: AppSettings) => s.consents.length > 0 && !termsAccepted(s);

/** 連上 Intervals.icu 了嗎（API key 或登入） */
export const intervalsConnected = (s: AppSettings) => s.intervals.apiKey.trim() !== "" || s.intervals.accessToken !== "";

/** LLM 設定是否完整到可以開始對話；不完整時回傳缺少的項目 */
export function llmProblem(s: AppSettings): string | null {
  if (s.llmMode === "proxy") {
    if (!s.proxy.url.trim()) return "這個版本沒有提供免費試用";
    if (!s.proxy.token.trim()) return "還沒輸入免費試用的邀請碼";
  } else {
    if (!s.apiKey.trim()) return "尚未填寫 API key";
    if (s.provider === "openai-compatible" && !s.baseURL.trim()) return "尚未填寫服務網址";
  }
  if (!s.models.chat.trim()) return "尚未填寫主對話模型";
  if (!s.consents.includes(consentKey(s))) return "尚未確認資料流向";
  if (!termsAccepted(s)) return "尚未確認使用須知";
  return null;
}

export function buildProvider(s: AppSettings): LlmProvider {
  if (s.llmMode === "proxy") {
    // meterHeader：告訴代理這次是對話、自動的分析還是壓縮，代理據此算每天的次數
    return new AnthropicProvider({ apiKey: s.proxy.token.trim(), baseURL: s.proxy.url.trim(), browser: true, meterHeader: true });
  }
  const apiKey = s.apiKey.trim();
  switch (s.provider) {
    case "anthropic":
      // VITE_ANTHROPIC_BASE_URL 只給 E2E 用（指向模擬上游）；正式的建置不設定
      return new AnthropicProvider({ apiKey, browser: true, baseURL: import.meta.env.VITE_ANTHROPIC_BASE_URL || undefined });
    case "openai":
    case "gemini":
      return new OpenAICompatibleProvider({ ...OPENAI_COMPATIBLE_PRESETS[s.provider], apiKey });
    case "openai-compatible":
      return new OpenAICompatibleProvider({ apiKey, baseURL: s.baseURL.trim() });
  }
}

/** 摘要與壓縮模型留空時沿用主對話模型 */
export function resolvedModels(s: AppSettings): Record<Purpose, string> {
  const chat = s.models.chat.trim();
  return { chat, summary: s.models.summary.trim() || chat, compress: s.models.compress.trim() || chat };
}
