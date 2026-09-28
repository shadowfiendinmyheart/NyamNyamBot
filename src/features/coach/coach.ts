import { Bot, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema.js";
import { config } from "../../config.js";
import type { MyContext } from "../../context.js";
import { askCoach, CoachError } from "../../ai/coach.js";
import { withChatAction } from "../../utils/chatAction.js";
import { COACH_BUTTON } from "../mainMenu.js";
import { transcribeVoiceMessage } from "../mealLogging.js";
import { createCoachDataSource } from "./dataSource.js";
import { CoachSessionStore } from "./session.js";

type Db = BetterSQLite3Database<typeof schema>;

const GREETING = [
  "🐱 Мур! Я Ням-Ням — ваш личный коуч по питанию, тренировкам и самочувствию.",
  "Я вижу ваш профиль, дневник питания и вес, так что спрашивайте что угодно:",
  "",
  "• Хорошо ли я питался сегодня?",
  "• Как прошла моя неделя?",
  "• Что съесть на ужин, чтобы добрать белок?",
  "• Почему вес стоит на месте?",
  "• Сорвался на сладкое — что делать?",
  "",
  "Пишите текстом или голосом. Фото еды я по-прежнему запишу в дневник.",
].join("\n");

const DISCUSS_GREETING = "🐱 Давайте обсудим! Что хотите спросить?";
const EXIT_TEXT = "Возвращаюсь к записи еды 🐾 Позовите, если что — кнопка «🐱 Спросить Ням-Ням».";

export function coachExitKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("✖️ Завершить разговор", "coach:exit");
}

export function coachDiscussKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("💬 Обсудить с Ням-Ням", "coach:discuss");
}

export function registerCoach(
  bot: Bot<MyContext>,
  db: Db,
  store: CoachSessionStore = new CoachSessionStore(),
): void {
  store.startSweeper();

  async function answer(ctx: MyContext, userId: number, question: string): Promise<void> {
    const session = store.get(userId);
    if (!session) return;

    try {
      const reply = await askCoach({
        history: session.history,
        question,
        context: session.context,
        dataSource: createCoachDataSource(db, userId, config.defaultTimezone),
      });
      store.append(userId, question, reply);
      await ctx.reply(reply, { reply_markup: coachExitKeyboard() });
    } catch (err) {
      console.error("Коуч не смог ответить:", err);
      await ctx.reply(
        err instanceof CoachError
          ? err.message
          : "Ням-Ням не смогла ответить. Попробуйте ещё раз.",
        { reply_markup: coachExitKeyboard() },
      );
    }
  }

  async function exit(ctx: MyContext): Promise<void> {
    if (!ctx.from) return;
    await ctx.reply(store.end(ctx.from.id) ? EXIT_TEXT : "Разговор с Ням-Ням и так не открыт.");
  }

  bot.hears(COACH_BUTTON, async (ctx) => {
    if (!ctx.from) return;
    store.start(ctx.from.id);
    await ctx.reply(GREETING, { reply_markup: coachExitKeyboard() });
  });

  bot.command("exit", exit);

  bot.callbackQuery("coach:exit", async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await exit(ctx);
  });

  // Кнопка под вечерней сводкой / недельным отчётом / оценкой приёма пищи: текст
  // сообщения становится контекстом.
  bot.callbackQuery("coach:discuss", async (ctx) => {
    await ctx.answerCallbackQuery();
    store.start(ctx.from.id, ctx.callbackQuery.message?.text);
    await ctx.reply(DISCUSS_GREETING, { reply_markup: coachExitKeyboard() });
  });

  // В режиме разговора текст и голос идут коучу, иначе — дальше, в запись еды.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/") || !store.get(ctx.from.id)) return next();

    await withChatAction(ctx, "typing", () => answer(ctx, ctx.from.id, text));
  });

  bot.on("message:voice", async (ctx, next) => {
    if (!store.get(ctx.from.id)) return next();

    try {
      await withChatAction(ctx, "typing", async () => {
        const text = await transcribeVoiceMessage(ctx);
        if (text === undefined) return;
        await answer(ctx, ctx.from.id, text);
      });
    } catch (err) {
      console.error("Не удалось обработать голосовой вопрос коучу:", err);
      await ctx.reply("Не получилось обработать голосовое сообщение, попробуйте ещё раз.");
    }
  });
}
