import type { MiddlewareFn } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { redeemInviteCode } from "../db/inviteCodes.js";
import { getUserByTelegramId } from "../db/users.js";
import { mainKeyboard } from "./mainMenu.js";

type Db = BetterSQLite3Database<typeof schema>;

export const WELCOME_TEXT = [
  "🐱 Мур! Я Ням-Ням — помогаю следить за питанием.",
  "",
  "Присылайте фото еды, описание текстом или голосовым — я оценю калории и БЖУ, " +
    "веду дневник питания, считаю дневную норму и подсказываю, сколько осталось.",
  "",
  "Я работаю по приглашениям: пришлите инвайт-код, который вам дал тот, кто вас " +
    "пригласил.",
].join("\n");

const WRONG_CODE_TEXT =
  "Не нашла такого кода или он уже использован. Проверьте код и пришлите ещё раз — " +
  "его можно уточнить у того, кто вас пригласил.";

const ASK_CODE_TEXT = "🐱 Чтобы начать, пришлите инвайт-код — его можно взять у того, кто вас пригласил.";

// Что прислал ещё не зарегистрированный пользователь: код (текстом или в deep link
// t.me/<bot>?start=<код>), просьбу о знакомстве (/start без кода, другие команды) или
// что-то без текста.
export type GuestInput = { kind: "code"; code: string } | { kind: "welcome" } | { kind: "none" };

export function parseGuestInput(text: string | undefined): GuestInput {
  const trimmed = text?.trim();
  if (!trimmed) return { kind: "none" };
  if (!trimmed.startsWith("/")) return { kind: "code", code: trimmed };

  const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(trimmed);
  return start?.[1] ? { kind: "code", code: start[1] } : { kind: "welcome" };
}

export function createAccessGate(db: Db): MiddlewareFn<MyContext> {
  return async (ctx, next) => {
    if (!ctx.from) return;

    const user = getUserByTelegramId(db, ctx.from.id);
    if (user) {
      return next();
    }

    if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});

    const input = parseGuestInput(ctx.message?.text ?? ctx.message?.caption);
    if (input.kind === "welcome") {
      await ctx.reply(WELCOME_TEXT);
      return;
    }
    if (input.kind === "none") {
      await ctx.reply(ASK_CODE_TEXT);
      return;
    }

    let redeemed: boolean;
    try {
      redeemed = redeemInviteCode(db, input.code, ctx.from.id, ctx.from.username);
    } catch (err) {
      console.error("Не удалось создать пользователя:", err);
      await ctx.reply("Что-то пошло не так, попробуйте ещё раз.");
      return;
    }

    if (!redeemed) {
      await ctx.reply(WRONG_CODE_TEXT);
      return;
    }

    await ctx.reply(
      "Код принят, добро пожаловать! 🎉 Давайте настроим профиль — несколько коротких " +
        "вопросов, чтобы посчитать вашу дневную норму.",
      { reply_markup: mainKeyboard },
    );
    await ctx.conversation.enter("onboarding");
  };
}
