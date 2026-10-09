import os

# Anthropic
ANTHROPIC_API_KEY: str = os.environ["ANTHROPIC_API_KEY"]
# 主對話（教練對話、排課表、tool use）用較強的模型；摘要與壓縮可各自指定較便宜的模型
CLAUDE_MODEL: str = os.getenv("CLAUDE_MODEL", "claude-opus-5-5")
# 分用途模型（未設定則沿用 CLAUDE_MODEL）
CLAUDE_MODEL_SUMMARY: str = os.getenv("CLAUDE_MODEL_SUMMARY") or CLAUDE_MODEL    # 跑後分析摘要
CLAUDE_MODEL_COMPRESS: str = os.getenv("CLAUDE_MODEL_COMPRESS") or CLAUDE_MODEL  # 對話壓縮
# 主對話的思考強度（low / medium / high / xhigh / max）；不支援 effort 的模型會自動略過
CLAUDE_CHAT_EFFORT: str = os.getenv("CLAUDE_CHAT_EFFORT") or "medium"

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
RACE_LOOKAHEAD_DAYS: int = int(os.getenv("RACE_LOOKAHEAD_DAYS", "90"))
# 已結束但尚未記錄成績的賽事，保留在賽事清單中的天數（供賽後補登成績）
RACE_LOOKBACK_DAYS: int = int(os.getenv("RACE_LOOKBACK_DAYS", "14"))

# Agent
TOOL_CALL_MAX_ROUNDS: int = int(os.getenv("TOOL_CALL_MAX_ROUNDS", "5"))
# 輸出上限含思考 token；只有實際輸出才計費，設寬一點避免回覆被截斷
MAX_RESPONSE_TOKENS: int = int(os.getenv("MAX_RESPONSE_TOKENS", "16000"))
