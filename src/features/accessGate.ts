import type { MiddlewareFn } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { redeemInviteCode } from "../db/inviteCodes.js";
import { getUserByTelegramId } from "../db/users.js";
import { mainKeyboard } from "./mainMenu.js";

type Db = BetterSQLite3Database<typeof schema>;

export function createAccessGate(db: Db): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    if (!ctx.from) return;

    const user = getUserByTelegramId(db, ctx.from.id);
    if (user) {
      return next();
    }

    const code = (ctx.message?.text ?? ctx.message?.caption)?.trim();
    if (!code) {
      await ctx.reply("Для доступа к боту пришлите инвайт-код.");
      return;
    }

    let redeemed: boolean;
    try {
      redeemed = redeemInviteCode(db, code, ctx.from.id, ctx.from.username);
    } catch (err) {
      console.error("Не удалось создать пользователя:", err);
      await ctx.reply("Что-то пошло не так, попробуйте ещё раз.");
      return;
    }

    if (!redeemed) {
      await ctx.reply("Неверный или уже использованный инвайт-код.");
      return;
    }

    await ctx.reply(
      "Добро пожаловать! Давайте настроим профиль, чтобы посчитать вашу дневную норму.",
      { reply_markup: mainKeyboard },
    );
    await ctx.conversation.enter("onboarding");
  };
}
