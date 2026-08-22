import { Bot } from "grammy";
import { config } from "./config.js";
import { db } from "./db/client.js";
import { createAccessGate } from "./features/accessGate.js";
import { registerMealLogging } from "./features/mealLogging.js";

const bot = new Bot(config.botToken);

bot.catch((err) => {
  console.error("Ошибка при обработке обновления:", err);
});

bot.use(createAccessGate(db));

bot.command("help", async (ctx) => {
  await ctx.reply("Доступные команды:\n/help — этот список");
});

registerMealLogging(bot, db);

bot
  .start({
    onStart: (botInfo) => {
      console.log(`Бот @${botInfo.username} запущен и готов к работе.`);
    },
  })
  .catch((err) => {
    console.error("Не удалось запустить бота:", err);
    process.exit(1);
  });
