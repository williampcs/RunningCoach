import os

# Anthropic
ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
CLAUDE_MODEL: str = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5")
# 分用途模型（未設定則沿用 CLAUDE_MODEL）
CLAUDE_MODEL_SUMMARY: str = os.getenv("CLAUDE_MODEL_SUMMARY") or CLAUDE_MODEL    # 跑後分析摘要
CLAUDE_MODEL_COMPRESS: str = os.getenv("CLAUDE_MODEL_COMPRESS") or CLAUDE_MODEL  # 對話壓縮

# Discord
DISCORD_BOT_TOKEN: str = os.environ["DISCORD_BOT_TOKEN"]
DISCORD_ALLOWED_CHANNEL_ID: int = int(os.environ["DISCORD_ALLOWED_CHANNEL_ID"])

# Intervals.icu
INTERVALS_API_KEY: str = os.getenv("INTERVALS_API_KEY", "")
INTERVALS_ATHLETE_ID: str = os.getenv("INTERVALS_ATHLETE_ID", "0")

# DB
DB_PATH: str = os.getenv("DB_PATH", "/app/data/coach.db")

# Context / memory tuning
CONVERSATION_MAX: int = int(os.getenv("CONVERSATION_MAX", "20"))
CONVERSATION_KEEP: int = int(os.getenv("CONVERSATION_KEEP", "10"))
CONVERSATION_MSG_MAX_CHARS: int = int(os.getenv("CONVERSATION_MSG_MAX_CHARS", "600"))
WORKOUT_SUMMARY_COUNT: int = int(os.getenv("WORKOUT_SUMMARY_COUNT", "7"))
RACE_LOOKAHEAD_DAYS: int = int(os.getenv("RACE_LOOKAHEAD_DAYS", "90"))

# Agent
TOOL_CALL_MAX_ROUNDS: int = int(os.getenv("TOOL_CALL_MAX_ROUNDS", "5"))
MAX_RESPONSE_TOKENS: int = int(os.getenv("MAX_RESPONSE_TOKENS", "4096"))
