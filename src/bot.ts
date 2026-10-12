import { Bot } from "grammy";
import { conversations, createConversation } from "@grammyjs/conversations";
import { run, sequentialize } from "@grammyjs/runner";
import { config } from "./config.js";
import type { MyContext } from "./context.js";
import { startScheduler } from "./cron/scheduler.js";
import { db } from "./db/client.js";
import { syncInviteCodes } from "./db/inviteCodes.js";
import { createAccessGate } from "./features/accessGate.js";
import {
  buildProfileView,
  HELP_TEXT,
  mainKeyboard,
  registerMainMenu,
  RESET_CONFIRM_TEXT,
  resetConfirmKeyboard,
  WELCOME_BACK_TEXT,
} from "./features/mainMenu.js";
import { coachKeyboard, registerCoach } from "./features/coach/coach.js";
import { CoachSessionStore } from "./features/coach/session.js";
import { correctionConversation, registerCorrection } from "./features/correction.js";
import { registerMealCorrection } from "./features/mealCorrection.js";
import { registerMealLogging } from "./features/mealLogging.js";
import { registerMealTime } from "./features/mealTime.js";
import { motivationConversation, registerMotivation } from "./features/motivation.js";
import { onboardingConversation, registerOnboarding } from "./features/onboarding.js";
import { getProfileByUserId } from "./db/profiles.js";
import { registerHistory } from "./features/history.js";
import { registerNotifications } from "./features/notifications.js";
import { registerTimeZone } from "./features/timezone.js";
import {
  registerWeight,
  registerWeightShortcut,
  weightConversation,
} from "./features/weight.js";
import {
  registerWorkout,
  workoutConversation,
  workoutEditConversation,
} from "./features/workout.js";
import { telegramClientOptions } from "./utils/telegram.js";

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

const bot = new Bot<MyContext>(config.botToken, { client: telegramClientOptions });

bot.catch((err) => {
  console.error("Ошибка при обработке обновления:", err);
});

// Runner обрабатывает обновления параллельно, чтобы долгий запрос к ИИ у одного
// пользователя не останавливал бота для всех. Внутри одного чата обновления
// по-прежнему идут строго по очереди — на это рассчитаны диалоги (conversations).
bot.use(sequentialize((ctx) => (ctx.chat?.id ?? ctx.from?.id)?.toString()));
bot.use(conversations());
bot.use(createConversation(onboardingConversation(db, bot.api), "onboarding"));
bot.use(createConversation(motivationConversation(db, bot.api), "motivation"));
bot.use(createConversation(correctionConversation(db, bot.api), "correction"));
bot.use(createConversation(weightConversation(db), "weight"));
bot.use(createConversation(workoutConversation(db), "workout"));
bot.use(createConversation(workoutEditConversation(db, bot.api), "workoutEdit"));
bot.use(createAccessGate(db));

// /start шлют и те, кто уже пользуется ботом (например, «Перезапустить бота» в Telegram):
// анкету открываем, только если профиля ещё нет. Во время анкеты сюда не попадаем:
// /start перехватывает сам диалог (в первой — «сначала закончите», в повторной — отмена).
bot.command("start", async (ctx) => {
  if (!ctx.from) return;
  if (getProfileByUserId(db, ctx.from.id)) {
    await ctx.reply(WELCOME_BACK_TEXT, { reply_markup: mainKeyboard });
    return;
  }
  await ctx.conversation.enter("onboarding");
});

bot.command("reset", async (ctx) => {
  if (!ctx.from) return;
  await ctx.reply(RESET_CONFIRM_TEXT, { reply_markup: resetConfirmKeyboard() });
});

bot.command("profile", async (ctx) => {
  if (!ctx.from) return;
  const { text, reply_markup } = buildProfileView(db, ctx.from.id);
  await ctx.reply(text, { reply_markup });
});

// Разговоры с Ням-Ням: /help посреди разговора не должна подменять его клавиатуру главной.
const coachSessions = new CoachSessionStore();

bot.command("help", async (ctx) => {
  const inCoachMode = ctx.from !== undefined && coachSessions.isActive(ctx.from.id);
  await ctx.reply(HELP_TEXT, { reply_markup: inCoachMode ? coachKeyboard : mainKeyboard });
});

registerOnboarding(bot);
registerHistory(bot, db);
registerMainMenu(bot, db);
registerWeight(bot, db);
registerWorkout(bot, db);
registerMotivation(bot);
registerTimeZone(bot, db);
registerNotifications(bot, db);
// До registerMealLogging: в режиме разговора с Ням-Ням текст и голос идут коучу.
registerCoach(bot, db, coachSessions);
// Вне разговора с Ням-Ням «78.5» / «вес 78.5» — запись веса, а не еда.
registerWeightShortcut(bot, db);
registerMealLogging(bot, db);
registerMealTime(bot, db);
registerCorrection(bot, db);
registerMealCorrection(bot, db);

try {
  await bot.init();
} catch (err) {
  console.error("Не удалось запустить бота:", err);
  process.exit(1);
}

const runner = run(bot);
console.log(`Бот @${bot.botInfo.username} запущен и готов к работе.`);
startScheduler(bot.api, db);

const stopRunner = () => {
  if (runner.isRunning()) void runner.stop();
};
process.once("SIGINT", stopRunner);
process.once("SIGTERM", stopRunner);

runner.task()?.catch((err) => {
  console.error("Бот остановился из-за ошибки:", err);
  process.exit(1);
});
