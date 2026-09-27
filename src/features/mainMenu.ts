import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { deleteProfile, getProfileByUserId } from "../db/profiles.js";
import { buildProfileMessage } from "./profile.js";
import { sendTodayReport } from "./reports.js";

type Db = BetterSQLite3Database<typeof schema>;

const TODAY_BUTTON = "📋 Сегодня";
const MENU_BUTTON = "⚙️ Меню";

export const mainKeyboard = new Keyboard()
  .text(TODAY_BUTTON)
  .text(MENU_BUTTON)
  .resized()
  .persistent();

export const HELP_TEXT = [
  "Пришлите фото еды, опишите текстом или голосовым сообщением, что съели — бот посчитает КБЖУ.",
  "",
  `${TODAY_BUTTON} — сводка приёмов пищи за сегодня`,
  `${MENU_BUTTON} — профиль и норма, анкета, сброс профиля, помощь`,
].join("\n");

function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("👤 Мой профиль", "menu:profile")
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
