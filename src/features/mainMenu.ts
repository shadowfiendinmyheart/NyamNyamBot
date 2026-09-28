import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { deleteProfile, getProfileByUserId } from "../db/profiles.js";
import { buildProfileMessage } from "./profile.js";
import { sendTodayReport } from "./reports.js";

type Db = BetterSQLite3Database<typeof schema>;

export const TODAY_BUTTON = "📋 Сегодня";
export const MENU_BUTTON = "⚙️ Меню";
export const COACH_BUTTON = "🐱 Спросить Ням-Ням";

// Выход из пошагового диалога: любая команда или кнопка главного меню.
export function isCancelInput(text: string): boolean {
  return (
    text.startsWith("/") || [TODAY_BUTTON, MENU_BUTTON, COACH_BUTTON].includes(text)
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
  "Тренировки тоже можно просто описать: «бегал 40 минут».",
  "",
  `${TODAY_BUTTON} — сводка приёмов пищи и тренировок за сегодня`,
  `${MENU_BUTTON} — профиль и норма, вес, тренировка, активность, анкета, сброс профиля, помощь`,
  `${COACH_BUTTON} — личный коуч: питание, тренировки, самочувствие, срывы. ` +
    "Знает ваш профиль, дневник, тренировки и вес. /exit — завершить разговор",
  "",
  "/workout — записать тренировку (или сразу: /workout бег 40)",
  "/weight — записать текущий вес и пересчитать норму",
  "/activity — изменить уровень активности (например, если начали тренироваться)",
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
    .text("⚖️ Записать вес", "menu:weight")
    .text("🏃 Активность", "menu:activity")
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
    await ctx.editMessageText(buildProfileMessage(profile), { reply_markup: profileKeyboard() });
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
    if (ctx.conversation.active("onboarding")) return;
    await ctx.conversation.enter("onboarding");
  });
}
