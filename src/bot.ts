import { Bot } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import { db } from "./db/client.js";
import { createAccessGate } from "./features/accessGate.js";
import {
  HELP_TEXT,
  mainKeyboard,
  registerMainMenu,
  resetConfirmKeyboard,
} from "./features/mainMenu.js";
import { registerMealLogging } from "./features/mealLogging.js";
import { onboardingConversation } from "./features/onboarding.js";
import { registerReports } from "./features/reports.js";

const bot = new Bot<MyContext>(config.botToken);

bot.catch((err) => {
  console.error("Ошибка при обработке обновления:", err);
});

bot.use(conversations());
bot.use(createAccessGate(db));
bot.use(createConversation(onboardingConversation(db), "onboarding"));

bot.command("start", async (ctx) => {
  if (ctx.conversation.active("onboarding")) return;
  await ctx.conversation.enter("onboarding");
});

bot.command("reset", async (ctx) => {
  if (!ctx.from) return;
  await ctx.reply("Точно удалить профиль и начать анкету заново?", {
    reply_markup: resetConfirmKeyboard(),
  });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, { reply_markup: mainKeyboard });
});

registerReports(bot, db);
registerMainMenu(bot, db);
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
