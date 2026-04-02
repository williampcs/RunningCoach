"""Discord Bot — 接收訊息、轉發 Agent、回傳結果."""
import logging

import discord
from discord.ext import commands
from discord import app_commands

import config
import agent.loop as agent_loop
import memory.db as db

logger = logging.getLogger(__name__)

DISCORD_MSG_LIMIT = 2000


def _split_message(text: str) -> list[str]:
    """將長訊息切割為不超過 2000 字的分段."""
    parts = []
    while len(text) > DISCORD_MSG_LIMIT:
        split_at = text.rfind("\n", 0, DISCORD_MSG_LIMIT)
        if split_at == -1:
            split_at = DISCORD_MSG_LIMIT
        parts.append(text[:split_at])
        text = text[split_at:].lstrip("\n")
    if text:
        parts.append(text)
    return parts


class CoachBot(commands.Bot):
    def __init__(self):
        intents = discord.Intents.default()
        intents.message_content = True
        super().__init__(command_prefix="!", intents=intents)

    async def setup_hook(self):
        await self.tree.sync()
        logger.info("Slash commands synced.")

    async def on_ready(self):
        logger.info("Bot online: %s (id=%s)", self.user, self.user.id)

    async def on_message(self, message: discord.Message):
        if message.author.bot:
            return
        if message.channel.id != config.DISCORD_ALLOWED_CHANNEL_ID:
            return
        # 斜線指令由 app_commands 處理，這裡只處理一般文字訊息
        if message.content.startswith("/"):
            await self.process_commands(message)
            return

        async with message.channel.typing():
            try:
                reply = await agent_loop.run(message.content)
            except Exception as e:
                logger.error("Agent error: %s", e)
                reply = "目前無法回應，請稍後再試。"

        for part in _split_message(reply):
            await message.channel.send(part)


def create_bot() -> CoachBot:
    bot = CoachBot()

    # ------------------------------------------------------------------ /sync
    @bot.tree.command(name="sync", description="手動觸發 Strava 資料同步")
    async def cmd_sync(interaction: discord.Interaction):
        if interaction.channel_id != config.DISCORD_ALLOWED_CHANNEL_ID:
            return
        await interaction.response.defer()
        # Phase 3 實作 Strava 同步，目前回傳提示
        await interaction.followup.send("Strava 同步功能將於 Phase 3 開放。")

    # ------------------------------------------------------------------ /plan
    @bot.tree.command(name="plan", description="更新本週訓練計畫")
    @app_commands.describe(content="訓練計畫內容")
    async def cmd_plan(interaction: discord.Interaction, content: str):
        if interaction.channel_id != config.DISCORD_ALLOWED_CHANNEL_ID:
            return
        from datetime import date
        week_label = date.today().strftime("%G-W%V")
        db.save_training_plan(week_label, content)
        await interaction.response.send_message(f"訓練計畫已更新（{week_label}）。")

    # --------------------------------------------------------------- /profile
    @bot.tree.command(name="profile", description="更新選手資料")
    @app_commands.describe(key="資料欄位名稱（如 goal_long_term、injuries）", value="欄位值")
    async def cmd_profile(interaction: discord.Interaction, key: str, value: str):
        if interaction.channel_id != config.DISCORD_ALLOWED_CHANNEL_ID:
            return
        db.set_profile_key(key, value)
        await interaction.response.send_message(f"已更新 `{key}` = `{value}`。")

    # --------------------------------------------------------------- /status
    @bot.tree.command(name="status", description="顯示目前記憶狀態（debug）")
    async def cmd_status(interaction: discord.Interaction):
        if interaction.channel_id != config.DISCORD_ALLOWED_CHANNEL_ID:
            return
        profile = db.get_profile()
        conv_count = db.count_conversations()
        races = db.get_upcoming_races(config.RACE_LOOKAHEAD_DAYS)
        plan = db.get_active_training_plan()

        lines = ["**記憶狀態**", ""]
        lines.append(f"選手資料：{len(profile)} 筆")
        lines.append(f"對話紀錄：{conv_count} 筆（閾值 {config.CONVERSATION_MAX}）")
        lines.append(f"近期賽事（{config.RACE_LOOKAHEAD_DAYS} 天內）：{len(races)} 筆")
        lines.append(f"訓練計畫：{'有' if plan else '無'}")

        await interaction.response.send_message("\n".join(lines))

    return bot
