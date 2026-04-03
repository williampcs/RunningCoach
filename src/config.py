import os

# Anthropic
ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
CLAUDE_MODEL: str = os.getenv("CLAUDE_MODEL", "claude-sonnet-4-5")

# Discord
DISCORD_BOT_TOKEN: str = os.environ["DISCORD_BOT_TOKEN"]
DISCORD_ALLOWED_CHANNEL_ID: int = int(os.environ["DISCORD_ALLOWED_CHANNEL_ID"])

# Strava
STRAVA_CLIENT_ID: str = os.getenv("STRAVA_CLIENT_ID", "")
STRAVA_CLIENT_SECRET: str = os.getenv("STRAVA_CLIENT_SECRET", "")

# DB
DB_PATH: str = os.getenv("DB_PATH", "/app/data/coach.db")

# Context / memory tuning
CONVERSATION_MAX: int = int(os.getenv("CONVERSATION_MAX", "20"))
CONVERSATION_KEEP: int = int(os.getenv("CONVERSATION_KEEP", "10"))
WORKOUT_SUMMARY_COUNT: int = int(os.getenv("WORKOUT_SUMMARY_COUNT", "7"))
RACE_LOOKAHEAD_DAYS: int = int(os.getenv("RACE_LOOKAHEAD_DAYS", "90"))

# Agent
TOOL_CALL_MAX_ROUNDS: int = int(os.getenv("TOOL_CALL_MAX_ROUNDS", "5"))
MAX_RESPONSE_TOKENS: int = int(os.getenv("MAX_RESPONSE_TOKENS", "4096"))
