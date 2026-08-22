import { Bot } from "grammy";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { createAccessGate } from "./features/accessGate.js";

const bot = new Bot(config.botToken);

bot.catch((err) => {
  console.error("Ошибка при обработке обновления:", err);
});

bot.use(createAccessGate(db));

bot.command("help", async (ctx) => {
  await ctx.reply("Доступные команды:\n/help — этот список");
});

bot.start().catch((err) => {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
});
