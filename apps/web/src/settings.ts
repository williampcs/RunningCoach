/** 使用者設定 — 存在這個瀏覽器的 localStorage，不會上傳. */
import {
  AnthropicProvider,
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type Effort,
  type LlmProvider,
  type Purpose,
} from "@running-coach/core";

const STORAGE_KEY = "running-coach.settings.v1";

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
  timeZone: string;
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
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Taipei",
    consents: [],
  };
}

export function loadSettings(): AppSettings {
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
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
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
