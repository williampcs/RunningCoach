"""進入點 — 初始化 DB 並啟動 Discord Bot."""
import logging
import sys
import os

# src/ 本身即工作目錄，確保 import 路徑正確
sys.path.insert(0, os.path.dirname(__file__))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s — %(message)s",
)

import config
import memory.db as db
from bot.discord_bot import create_bot


def main():
    db.init_db()
    logging.getLogger(__name__).info("DB initialized at %s", config.DB_PATH)

    bot = create_bot()
    bot.run(config.DISCORD_BOT_TOKEN)


if __name__ == "__main__":
    main()
