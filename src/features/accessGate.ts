import type { MiddlewareFn } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { createUser, getUserByTelegramId } from "../db/users.js";

type Db = BetterSQLite3Database<typeof schema>;

function matchesInviteCode(code: string): boolean {
  return config.inviteCodes.some(
    (inviteCode) => inviteCode.toLowerCase() === code.toLowerCase(),
  );
}

export function createAccessGate(db: Db): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    if (!ctx.from) return;

    const user = getUserByTelegramId(db, ctx.from.id);
    if (user) {
      return next();
    }

    const code = (ctx.message?.text ?? ctx.message?.caption)?.trim();
    if (!code || !matchesInviteCode(code)) {
      await ctx.reply("Для доступа к боту пришлите инвайт-код.");
      return;
    }

    try {
      createUser(db, ctx.from.id, ctx.from.username);
    } catch (err) {
      console.error("Не удалось создать пользователя:", err);
      await ctx.reply("Что-то пошло не так, попробуйте ещё раз.");
      return;
    }

    await ctx.reply("Добро пожаловать! Давайте настроим профиль, чтобы посчитать вашу дневную норму.");
    await ctx.conversation.enter("onboarding");
  };
}
