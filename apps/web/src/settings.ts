/** 使用者設定 — 存在這個瀏覽器的 localStorage，不會上傳. */
import {
  AnthropicProvider,
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type Effort,
  type LlmProvider,
  type Purpose,
} from "@running-coach/core";

import { createLock, openLock, sealSecrets, type LockSession, type SealedSecrets, type Secrets } from "./key-lock";

const STORAGE_KEY = "running-coach.settings.v1";
/** 啟用密碼鎖時，API key 等憑證以密文存在這裡，STORAGE_KEY 裡的對應欄位留空 */
const LOCK_KEY = "running-coach.lock.v1";

/** 解鎖後的金鑰與憑證只放在記憶體；重新載入頁面就要再輸入一次密碼 */
let lockSession: LockSession | null = null;
let unlockedSecrets: Secrets | null = null;

export type ProviderKind = "anthropic" | "openai" | "gemini" | "openai-compatible";

export interface AppSettings {
  /** byok：自己的 API key，直連供應商；proxy：訂閱，經作者的代理轉發 */
  llmMode: "byok" | "proxy";
  provider: ProviderKind;
  apiKey: string;
  /** 僅「其他相容服務」需要 */
  baseURL: string;
  models: Record<Purpose, string>;
  chatEffort: Effort;
  proxy: { url: string; token: string };
  intervals: { apiKey: string; athleteId: string };
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
    intervals: { apiKey: "", athleteId: "" },
    sync: { url: import.meta.env.VITE_SYNC_URL ?? "", key: "" },
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
    weather: null,
    consents: [],
  };
}

function loadPlainSettings(): AppSettings {
  const defaults = defaultSettings();
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AppSettings> | null;
    if (!stored) return defaults;
    return {
      ...defaults,
      ...stored,
      models: { ...defaults.models, ...stored.models },
      proxy: { ...defaults.proxy, ...stored.proxy },
      intervals: { ...defaults.intervals, ...stored.intervals },
      // 服務網址以建置時的為準：換了部署位置時不必每台重設
      sync: { ...defaults.sync, key: stored.sync?.key ?? "", url: defaults.sync.url || stored.sync?.url || "" },
    };
  } catch {
    return defaults;
  }
}

function secretsOf(s: AppSettings): Secrets {
  return { apiKey: s.apiKey, proxyToken: s.proxy.token, intervalsApiKey: s.intervals.apiKey, syncKey: s.sync.key };
}

function withSecrets(s: AppSettings, secrets: Secrets): AppSettings {
  return {
    ...s,
    apiKey: secrets.apiKey,
    proxy: { ...s.proxy, token: secrets.proxyToken },
    intervals: { ...s.intervals, apiKey: secrets.intervalsApiKey },
    sync: { ...s.sync, key: secrets.syncKey ?? "" },
  };
}

const NO_SECRETS: Secrets = { apiKey: "", proxyToken: "", intervalsApiKey: "", syncKey: "" };

/** 設定；啟用密碼鎖時，憑證只有在解鎖後才會出現 */
export function loadSettings(): AppSettings {
  const plain = loadPlainSettings();
  return lockEnabled() ? withSecrets(plain, unlockedSecrets ?? NO_SECRETS) : plain;
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  if (lockEnabled()) {
    if (!lockSession) throw new Error("密碼鎖尚未解鎖，無法儲存設定");
    const sealed = await sealSecrets(lockSession, secretsOf(settings));
    localStorage.setItem(LOCK_KEY, JSON.stringify(sealed));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(withSecrets(settings, NO_SECRETS)));
    unlockedSecrets = secretsOf(settings);
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** 刪除儲存的設定（含 API key 與密碼鎖），下次載入時回到預設值 */
export function clearSettings(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(LOCK_KEY);
}

// ---------------------------------------------------------------------------
// 密碼鎖（選用）
// ---------------------------------------------------------------------------

export function lockEnabled(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY) !== null;
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
  const sealed = JSON.parse(localStorage.getItem(LOCK_KEY) ?? "null") as SealedSecrets | null;
  if (!sealed) throw new Error("沒有啟用密碼鎖");
  const opened = await openLock(sealed, password);
  lockSession = opened.session;
  unlockedSecrets = opened.secrets;
}

/** 以密碼加密目前的憑證，明文設定裡的憑證改為空白 */
export async function enableLock(password: string, settings: AppSettings): Promise<void> {
  const { sealed, session } = await createLock(password, secretsOf(settings));
  localStorage.setItem(LOCK_KEY, JSON.stringify(sealed));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(withSecrets(settings, NO_SECRETS)));
  lockSession = session;
  unlockedSecrets = secretsOf(settings);
}

/** 停用密碼鎖：憑證改回以明文保存 */
export function disableLock(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  localStorage.removeItem(LOCK_KEY);
  lockSession = null;
  unlockedSecrets = null;
}

/** 忘記密碼：刪除加密的憑證（其餘設定保留），之後要重新填寫 key */
export function forgetLockedSecrets(): void {
  localStorage.removeItem(LOCK_KEY);
  lockSession = null;
  unlockedSecrets = null;
}

/** 切換供應商時的建議模型；Claude 以外的模型名稱由使用者填寫 */
export function suggestedModels(mode: AppSettings["llmMode"], provider: ProviderKind): Record<Purpose, string> {
  return mode === "proxy" || provider === "anthropic" ? { ...CLAUDE_MODELS } : { chat: "", summary: "", compress: "" };
}

export const consentKey = (s: AppSettings) => (s.llmMode === "proxy" ? "proxy" : `byok:${s.provider}`);

/** LLM 設定是否完整到可以開始對話；不完整時回傳缺少的項目 */
export function llmProblem(s: AppSettings): string | null {
  if (s.llmMode === "proxy") {
    if (!s.proxy.url.trim() || !s.proxy.token.trim()) return "尚未填寫訂閱代理的網址與憑證";
  } else {
    if (!s.apiKey.trim()) return "尚未填寫 API key";
    if (s.provider === "openai-compatible" && !s.baseURL.trim()) return "尚未填寫服務網址";
  }
  if (!s.models.chat.trim()) return "尚未填寫主對話模型";
  if (!s.consents.includes(consentKey(s))) return "尚未確認資料流向";
  return null;
}

export function buildProvider(s: AppSettings): LlmProvider {
  if (s.llmMode === "proxy") {
    return new AnthropicProvider({ apiKey: s.proxy.token.trim(), baseURL: s.proxy.url.trim(), browser: true });
  }
  const apiKey = s.apiKey.trim();
  switch (s.provider) {
    case "anthropic":
      return new AnthropicProvider({ apiKey, browser: true });
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
