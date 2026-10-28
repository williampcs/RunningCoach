/** Discord Bot — 接收訊息、轉發給 Coach、回傳結果. */
import {
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";

import { formatStatus, type Coach, type Logger, type UsageStats } from "@running-coach/core";

import { helpText, replyParts } from "./messages";
import { VERSION_LABEL } from "./version";

const TYPING_INTERVAL_MS = 8_000;

const COMMANDS = [
  new SlashCommandBuilder().setName("sync").setDescription("手動觸發 Intervals.icu 資料同步（含合併主觀暫存）"),
  new SlashCommandBuilder()
    .setName("plan")
    .setDescription("更新本週訓練計畫")
    .addStringOption((o) => o.setName("content").setDescription("訓練計畫內容").setRequired(true)),
  new SlashCommandBuilder()
    .setName("profile")
    .setDescription("更新選手資料")
    .addStringOption((o) =>
      o.setName("key").setDescription("資料欄位名稱（如 goal_long_term、injuries）").setRequired(true),
    )
    .addStringOption((o) => o.setName("value").setDescription("欄位值").setRequired(true)),
  new SlashCommandBuilder().setName("status").setDescription("顯示版本、模型設定與五層記憶狀態"),
  new SlashCommandBuilder().setName("help").setDescription("教練的自我介紹、指令與使用須知"),
];

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createBot(coach: Coach, allowedChannelId: string, logger: Logger, termsUrl: string): Client {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  client.once(Events.ClientReady, async (ready) => {
    logger.info(`Bot online: ${ready.user.tag} (id=${ready.user.id})`);
    try {
      await ready.application.commands.set(COMMANDS.map((c) => c.toJSON()));
      logger.info("Slash commands synced.");
    } catch (e) {
      logger.error(`Slash command sync failed: ${errorText(e)}`);
    }
  });

  client.on(Events.MessageCreate, (message) => {
    onMessage(message).catch((e) => logger.error(`Message handler error: ${errorText(e)}`));
  });

  client.on(Events.InteractionCreate, (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.channelId !== allowedChannelId) return;
    onCommand(interaction).catch((e) => logger.error(`Command /${interaction.commandName} error: ${errorText(e)}`));
  });

  async function onMessage(message: Message): Promise<void> {
    if (message.author.bot || message.channelId !== allowedChannelId) return;
    // 斜線指令由 InteractionCreate 處理，這裡只處理一般文字訊息
    if (!message.content || message.content.startsWith("/")) return;
    const channel = message.channel;
    if (!channel.isSendable()) return;

    // 輸入中的提示約 10 秒就會消失，模型回應期間持續補送
    const sendTyping = () => void channel.sendTyping().catch(() => undefined);
    sendTyping();
    const typing = setInterval(sendTyping, TYPING_INTERVAL_MS);

    let reply: string;
    let stats: UsageStats | null = null;
    let sources: string[] = [];
    try {
      ({ reply, stats, sources } = await coach.chat(message.content));
    } catch (e) {
      logger.error(`Agent error: ${errorText(e)}`);
      reply = "目前無法回應，請稍後再試。";
    } finally {
      clearInterval(typing);
    }

    for (const part of replyParts(reply, stats, sources)) await channel.send(part);
  }

  async function onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    switch (interaction.commandName) {
      case "sync": {
        await interaction.deferReply();
        let result: string;
        try {
          result = await coach.sync();
        } catch (e) {
          logger.error(`Sync error: ${errorText(e)}`);
          result = "❌ 同步失敗，請稍後再試。";
        }
        await interaction.editReply(result);
        return;
      }
      case "plan": {
        const weekLabel = await coach.savePlanForThisWeek(interaction.options.getString("content", true));
        await interaction.reply(`訓練計畫已更新（${weekLabel}）。`);
        return;
      }
      case "profile": {
        const key = interaction.options.getString("key", true);
        const value = interaction.options.getString("value", true);
        await coach.db.setProfileKey(key, value);
        await interaction.reply(`已更新 \`${key}\` = \`${value}\`。`);
        return;
      }
      case "status": {
        await interaction.reply(formatStatus(await coach.status(), coach.describeModels(), coach.settings, VERSION_LABEL));
        return;
      }
      case "help": {
        await interaction.reply(helpText(termsUrl));
        return;
      }
    }
  }

  return client;
}
