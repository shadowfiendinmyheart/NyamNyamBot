import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { deleteProfile, getProfileByUserId } from "../db/profiles.js";
import { getUserTimeZone } from "../db/users.js";
import { buildProfileMessage } from "./profile.js";
import { sendTodayReport } from "./reports.js";

type Db = BetterSQLite3Database<typeof schema>;

export const TODAY_BUTTON = "📋 Сегодня";
export const MENU_BUTTON = "⚙️ Меню";
export const COACH_BUTTON = "🐱 Спросить Ням-Ням";
// Клавиатура режима разговора с Ням-Ням (features/coach) вместо главной.
export const COACH_EXIT_BUTTON = "✖️ Завершить разговор";

// Выход из пошагового диалога: любая команда или кнопка главного меню / режима коуча.
export function isCancelInput(text: string): boolean {
  return (
    text.startsWith("/") ||
    [TODAY_BUTTON, MENU_BUTTON, COACH_BUTTON, COACH_EXIT_BUTTON].includes(text)
  );
}

export const mainKeyboard = new Keyboard()
  .text(TODAY_BUTTON)
  .text(MENU_BUTTON)
  .row()
  .text(COACH_BUTTON)
  .resized()
  .persistent();

export const HELP_TEXT = [
  "Пришлите фото еды, опишите текстом или голосовым сообщением, что съели — бот посчитает КБЖУ.",
  "Тренировки тоже можно просто описать: «бегал 40 минут». Вес — просто числом: «78.5».",
  "Забыли записать вовремя? Напишите, когда ели: «вчера на ужин…», «в 9 утра…» — или " +
    "нажмите «🕐 Время» под записью.",
  "",
  `${TODAY_BUTTON} — сводка приёмов пищи и тренировок за сегодня`,
  `${MENU_BUTTON} — профиль и норма, вес, тренировка, активность, анкета, сброс профиля, помощь`,
  `${COACH_BUTTON} — личный коуч: питание, тренировки, самочувствие, срывы. ` +
    "Знает ваш профиль, дневник, тренировки и вес. Если в разговоре напишете, что съели, — " +
    `предложит записать в дневник. «${COACH_EXIT_BUTTON}» или /exit — вернуться к записи еды`,
  "",
  "/workout — записать тренировку (или сразу: /workout бег 40)",
  "/weight — записать текущий вес и пересчитать норму",
  "/activity — изменить уровень активности (например, если начали тренироваться)",
  "/timezone — часовой пояс (или сразу: /timezone Екатеринбург, /timezone UTC+5)",
].join("\n");

export const WELCOME_BACK_TEXT = [
  "🐱 С возвращением! Профиль уже настроен — просто присылайте фото еды, описание " +
    "текстом или голосовым.",
  "",
  `${TODAY_BUTTON} — что уже съедено сегодня и сколько осталось до нормы.`,
  `${MENU_BUTTON} — профиль, вес, тренировки и повторная анкета.`,
].join("\n");

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 Мой профиль", "menu:profile")
    .row()
    .text("⚖️ Записать вес", "menu:weight")
    .row()
    .text("🏋️ Записать тренировку", "menu:workout")
    .row()
    .text("🏃 Изменить активность", "menu:activity")
    .row()
    .text("🔄 Пройти анкету заново", "menu:restart")
    .row()
    .text("🗑 Удалить профиль", "menu:reset")
    .row()
    .text("❓ Помощь", "menu:help");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("◀️ Назад", "menu:back");
}

export function profileKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("🏃 Активность", "menu:activity")
    .text("🕐 Часовой пояс", "menu:timezone")
    .row()
    .text("✍️ Зачем мне бот", "menu:motivation")
    .row()
    .text("🔄 Пройти анкету заново", "menu:restart")
    .row()
    .text("◀️ Назад", "menu:back");
}

export function resetConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✅ Да, удалить", "menu:reset_do").text("❌ Отмена", "menu:back");
}

export function registerMainMenu(bot: Bot<MyContext>, db: Db): void {
  bot.hears(TODAY_BUTTON, async (ctx) => {
    await sendTodayReport(ctx, db);
  });

  bot.hears(MENU_BUTTON, async (ctx) => {
    await ctx.reply("⚙️ Меню", { reply_markup: menuKeyboard() });
  });

  bot.callbackQuery("menu:back", async (ctx) => {
    await ctx.editMessageText("⚙️ Меню", { reply_markup: menuKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.editMessageText(HELP_TEXT, { reply_markup: backKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:profile", async (ctx) => {
    if (!ctx.from) return;
    const profile = getProfileByUserId(db, ctx.from.id);
    await ctx.editMessageText(buildProfileMessage(profile, getUserTimeZone(db, ctx.from.id)), {
      reply_markup: profileKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:reset", async (ctx) => {
    await ctx.editMessageText("Точно удалить профиль и начать анкету заново?", {
      reply_markup: resetConfirmKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:reset_do", async (ctx) => {
    if (!ctx.from) return;
    const deleted = deleteProfile(db, ctx.from.id);
    await ctx.editMessageText(
      deleted
        ? "Профиль удалён. Нажмите «🔄 Пройти анкету заново» в меню, когда будете готовы."
        : "У вас пока нет профиля.",
    );
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:restart", async (ctx) => {
    await ctx.editMessageText("Открываю анкету...");
    await ctx.answerCallbackQuery();
    // Повторная анкета пропускает чужие кнопки к обычным обработчикам — в том числе эту.
    if (ctx.conversation.active("onboarding")) return;
    await ctx.conversation.enter("onboarding");
  });
}
