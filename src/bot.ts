import { Bot } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import { startScheduler } from "./cron/scheduler.js";
import { db } from "./db/client.js";
import { syncInviteCodes } from "./db/inviteCodes.js";
import { createAccessGate } from "./features/accessGate.js";
import {
  HELP_TEXT,
  mainKeyboard,
  profileKeyboard,
  registerMainMenu,
  resetConfirmKeyboard,
} from "./features/mainMenu.js";
import { correctionConversation, registerCorrection } from "./features/correction.js";
import { registerMealLogging } from "./features/mealLogging.js";
import { onboardingConversation } from "./features/onboarding.js";
import { buildProfileMessage } from "./features/profile.js";
import { getProfileByUserId } from "./db/profiles.js";
import { registerReports } from "./features/reports.js";
import { registerWeight, weightConversation } from "./features/weight.js";

try {
  syncInviteCodes(db, config.inviteCodes);
} catch (err) {
  console.error(
    "Не удалось синхронизировать инвайт-коды — проверьте, что миграции применены " +
      "(npm run db:migrate):",
    err,
  );
  process.exit(1);
}

const bot = new Bot<MyContext>(config.botToken);

bot.catch((err) => {
  console.error("Ошибка при обработке обновления:", err);
});

bot.use(conversations());
bot.use(createConversation(onboardingConversation(db), "onboarding"));
bot.use(createConversation(correctionConversation(db), "correction"));
bot.use(createConversation(weightConversation(db), "weight"));
bot.use(createAccessGate(db));

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

bot.command("profile", async (ctx) => {
  if (!ctx.from) return;
  const profile = getProfileByUserId(db, ctx.from.id);
  await ctx.reply(buildProfileMessage(profile), { reply_markup: profileKeyboard() });
});

bot.command("help", async (ctx) => {
  await ctx.reply(HELP_TEXT, { reply_markup: mainKeyboard });
});

registerReports(bot, db);
registerMainMenu(bot, db);
registerWeight(bot, db);
registerMealLogging(bot, db);
registerCorrection(bot, db);

bot
  .start({
    onStart: (botInfo) => {
      console.log(`Бот @${botInfo.username} запущен и готов к работе.`);
      startScheduler(bot.api, db);
    },
  })
  .catch((err) => {
    console.error("Не удалось запустить бота:", err);
    process.exit(1);
  });
