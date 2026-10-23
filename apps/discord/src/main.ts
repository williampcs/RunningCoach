/** 進入點 — 初始化 DB 並啟動 Discord Bot. */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { Coach, IntervalsClient, localDate, OpenMeteoWeather, type Logger } from "@running-coach/core";
import { openNodeSqlite } from "@running-coach/sqlite-node";

import { createBot } from "./bot";
import { loadConfig } from "./config";

const log = (level: string) => (message: string) => console.log(`${new Date().toISOString()} ${level} — ${message}`);
const logger: Logger = { info: log("INFO"), warn: log("WARNING"), error: log("ERROR") };

const config = loadConfig(process.env);

mkdirSync(dirname(config.dbPath), { recursive: true });
const driver = openNodeSqlite(config.dbPath);

const coach = new Coach({
  driver,
  llm: config.llm,
  activities: new IntervalsClient({
    ...config.intervals,
    today: () => localDate(new Date(), config.settings.timeZone),
  }),
  weather: config.weather
    ? new OpenMeteoWeather({ place: config.weather, timeZone: config.settings.timeZone, today: () => localDate(new Date(), config.settings.timeZone) })
    : null,
  settings: config.settings,
  logger,
});
await coach.init();
logger.info(`DB initialized at ${config.dbPath}`);

const bot = createBot(coach, config.allowedChannelId, logger);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`${signal} received, shutting down`);
  await bot.destroy();
  await coach.idle();
  driver.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await bot.login(config.discordToken);
