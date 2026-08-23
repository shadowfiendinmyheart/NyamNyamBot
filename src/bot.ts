import { Bot } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import { db } from "./db/client.js";
import { deleteProfile } from "./db/profiles.js";
import { createAccessGate } from "./features/accessGate.js";
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
  const deleted = deleteProfile(db, ctx.from.id);
  await ctx.reply(
    deleted
      ? "Профиль удалён. Отправьте /start, чтобы пройти анкету заново."
      : "У вас пока нет профиля — отправьте /start, чтобы пройти анкету.",
  );
});

bot.command("help", async (ctx) => {
  await ctx.reply(
    "Доступные команды:\n/today — сводка приёмов пищи за сегодня\n" +
      "/start — пройти анкету заново и пересчитать норму\n" +
      "/reset — удалить профиль (сбросить анкету)\n/help — этот список",
  );
});

registerReports(bot, db);
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
