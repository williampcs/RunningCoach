/** 環境變數設定 — 變數名稱沿用 v1，原本的 .env 可直接使用. */
import {
  AnthropicProvider,
  DEFAULT_SETTINGS,
  OPENAI_COMPATIBLE_PRESETS,
  OpenAICompatibleProvider,
  type CoachSettings,
  type Effort,
  type LlmProvider,
  type Purpose,
} from "@running-coach/core";

type Env = Record<string, string | undefined>;

const EFFORTS: readonly string[] = ["low", "medium", "high", "xhigh", "max"];

export interface BotConfig {
  discordToken: string;
  /** Discord 的 ID 超過 JS 整數的安全範圍，一律以字串比對 */
  allowedChannelId: string;
  dbPath: string;
  intervals: { apiKey: string; athleteId: string };
  llm: { provider: LlmProvider; models: Record<Purpose, string>; chatEffort: Effort };
  settings: CoachSettings;
}

function required(env: Env, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少環境變數 ${name}`);
  return value;
}

function int(env: Env, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error(`環境變數 ${name} 必須是整數：${raw}`);
  return value;
}

function loadLlm(env: Env): BotConfig["llm"] {
  const kind = (env.LLM_PROVIDER?.trim() || "anthropic").toLowerCase();
  const chatEffort = env.CLAUDE_CHAT_EFFORT?.trim() || env.LLM_CHAT_EFFORT?.trim() || "medium";
  if (!EFFORTS.includes(chatEffort)) throw new Error(`思考強度必須是 ${EFFORTS.join(" / ")}：${chatEffort}`);

  let provider: LlmProvider;
  let chatModel: string;
  if (kind === "anthropic") {
    provider = new AnthropicProvider({
      apiKey: required(env, "ANTHROPIC_API_KEY"),
      baseURL: env.ANTHROPIC_BASE_URL?.trim() || undefined,
    });
    chatModel = env.CLAUDE_MODEL?.trim() || "claude-opus-5-5";
  } else if (kind === "openai" || kind === "gemini") {
    provider = new OpenAICompatibleProvider({ ...OPENAI_COMPATIBLE_PRESETS[kind], apiKey: required(env, "LLM_API_KEY") });
    chatModel = required(env, "LLM_MODEL");
  } else if (kind === "openai-compatible") {
    provider = new OpenAICompatibleProvider({
      apiKey: required(env, "LLM_API_KEY"),
      baseURL: required(env, "LLM_BASE_URL"),
      maxTokensParam: env.LLM_MAX_TOKENS_PARAM === "max_tokens" ? "max_tokens" : "max_completion_tokens",
      reasoningEffort: env.LLM_REASONING_EFFORT === "true",
    });
    chatModel = required(env, "LLM_MODEL");
  } else {
    throw new Error(`LLM_PROVIDER 必須是 anthropic / openai / gemini / openai-compatible：${kind}`);
  }

  // 分用途模型（未設定則沿用主對話模型）。名稱前綴跟著供應商，換供應商時留在 .env 裡的 Claude 模型不會被送給別家
  const prefix = kind === "anthropic" ? "CLAUDE" : "LLM";
  const pick = (purpose: "SUMMARY" | "COMPRESS") => env[`${prefix}_MODEL_${purpose}`]?.trim() || chatModel;
  return {
    provider,
    chatEffort: chatEffort as Effort,
    models: { chat: chatModel, summary: pick("SUMMARY"), compress: pick("COMPRESS") },
  };
}

export function loadConfig(env: Env): BotConfig {
  return {
    discordToken: required(env, "DISCORD_BOT_TOKEN"),
    allowedChannelId: required(env, "DISCORD_ALLOWED_CHANNEL_ID"),
    dbPath: env.DB_PATH?.trim() || "/app/data/coach.db",
    intervals: {
      apiKey: env.INTERVALS_API_KEY?.trim() ?? "",
      athleteId: env.INTERVALS_ATHLETE_ID?.trim() || "0",
    },
    llm: loadLlm(env),
    settings: {
      timeZone: env.TIMEZONE?.trim() || DEFAULT_SETTINGS.timeZone,
      shell: "discord",
      conversationMax: int(env, "CONVERSATION_MAX", DEFAULT_SETTINGS.conversationMax),
      conversationKeep: int(env, "CONVERSATION_KEEP", DEFAULT_SETTINGS.conversationKeep),
      conversationMsgMaxChars: int(env, "CONVERSATION_MSG_MAX_CHARS", DEFAULT_SETTINGS.conversationMsgMaxChars),
      conversationFullRecent: int(env, "CONVERSATION_FULL_RECENT", DEFAULT_SETTINGS.conversationFullRecent),
      raceLookaheadDays: int(env, "RACE_LOOKAHEAD_DAYS", DEFAULT_SETTINGS.raceLookaheadDays),
      raceLookbackDays: int(env, "RACE_LOOKBACK_DAYS", DEFAULT_SETTINGS.raceLookbackDays),
      toolCallMaxRounds: int(env, "TOOL_CALL_MAX_ROUNDS", DEFAULT_SETTINGS.toolCallMaxRounds),
      maxResponseTokens: int(env, "MAX_RESPONSE_TOKENS", DEFAULT_SETTINGS.maxResponseTokens),
    },
  };
}
