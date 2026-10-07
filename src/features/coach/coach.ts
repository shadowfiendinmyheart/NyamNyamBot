import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema.js";
import { getUserTimeZone } from "../../db/users.js";
import type { MyContext } from "../../context.js";
import { askCoach, CoachError } from "../../ai/coach.js";
import { withChatAction } from "../../utils/chatAction.js";
import { COACH_BUTTON, COACH_EXIT_BUTTON, mainKeyboard } from "../mainMenu.js";
import { logDescribedMeal, transcribeVoiceMessage } from "../mealLogging.js";
import {
  buildVoiceConfirmMessage,
  settleVoiceConfirmation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
} from "../voiceConfirm.js";
import { createCoachDataSource } from "./dataSource.js";
import { DiaryOfferStore } from "./diaryOffers.js";
import { CoachSessionStore } from "./session.js";

type Db = BetterSQLite3Database<typeof schema>;

const MODE_HINT =
  `Пока идёт разговор, ваши сообщения уходят мне. «${COACH_EXIT_BUTTON}» внизу ` +
  "вернёт к записи еды. Напишете, что съели, — предложу записать в дневник.";

const GREETING = [
  "🐱 Мур! Я Ням-Ням — ваш личный коуч по питанию, тренировкам и самочувствию.",
  "Я вижу ваш профиль, дневник питания, тренировки и вес, так что спрашивайте что угодно:",
  "",
  "• Хорошо ли я питался сегодня?",
  "• Как прошла моя неделя?",
  "• Что съесть на ужин, чтобы добрать белок?",
  "• Почему вес стоит на месте?",
  "• Сорвался на сладкое — что делать?",
  "",
  "Пишите текстом или голосом. Фото еды я по-прежнему запишу в дневник.",
  "",
  MODE_HINT,
].join("\n");

const DISCUSS_GREETING = ["🐱 Давайте обсудим! Что хотите спросить?", "", MODE_HINT].join("\n");
const EXIT_TEXT = "Возвращаюсь к записи еды 🐾 Позовите, если что — кнопка «🐱 Спросить Ням-Ням».";
const AUTO_CLOSE_TEXT =
  "🐱 Разговор с Ням-Ням закрыт — час без сообщений. Возвращаюсь к записи еды: " +
  "присылайте фото или пишите, что съели. Поговорить — снова «🐱 Спросить Ням-Ням».";
const DIARY_BUTTON = "📝 Записать в дневник";

// Своя клавиатура в режиме разговора: видно, что сообщения уходят коучу, и выход
// всегда под рукой. При выходе возвращается главная (mainKeyboard).
export const coachKeyboard = new Keyboard()
  .text(COACH_EXIT_BUTTON)
  .resized()
  .persistent()
  .placeholder("Вопрос для Ням-Ням…");

export function coachDiscussKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("💬 Обсудить с Ням-Ням", "coach:discuss");
}

function diaryOfferKeyboard(offerId: number): InlineKeyboard {
  return new InlineKeyboard().text(DIARY_BUTTON, `coach:log:${offerId}`);
}

export function registerCoach(
  bot: Bot<MyContext>,
  db: Db,
  store: CoachSessionStore = new CoachSessionStore(),
  offers: DiaryOfferStore = new DiaryOfferStore(),
): void {
  // Сессия закрылась сама — сообщаем и возвращаем главную клавиатуру.
  store.onExpire((userId) => {
    bot.api
      .sendMessage(userId, AUTO_CLOSE_TEXT, { reply_markup: mainKeyboard })
      .catch((err: unknown) => {
        console.error(`Не удалось сообщить ${userId} о закрытии разговора с Ням-Ням:`, err);
      });
  });
  store.startSweeper();

  async function answer(
    ctx: MyContext,
    userId: number,
    question: string,
    source: "text" | "voice",
  ): Promise<void> {
    const session = store.get(userId);
    if (!session) return;

    try {
      const reply = await askCoach({
        history: session.history,
        question,
        context: session.context,
        dataSource: createCoachDataSource(db, userId, getUserTimeZone(db, userId)),
      });
      store.append(userId, question, reply.text);
      await ctx.reply(
        reply.text,
        reply.offerDiaryEntry
          ? { reply_markup: diaryOfferKeyboard(offers.add(userId, question, source)) }
          : {},
      );
    } catch (err) {
      console.error("Коуч не смог ответить:", err);
      await ctx.reply(
        err instanceof CoachError ? err.message : "Ням-Ням не смогла ответить. Попробуйте ещё раз.",
      );
    }
  }

  async function exit(ctx: MyContext): Promise<void> {
    if (!ctx.from) return;
    await ctx.reply(store.end(ctx.from.id) ? EXIT_TEXT : "Разговор с Ням-Ням и так не открыт.", {
      reply_markup: mainKeyboard,
    });
  }

  bot.hears(COACH_BUTTON, async (ctx) => {
    if (!ctx.from) return;
    store.start(ctx.from.id);
    await ctx.reply(GREETING, { reply_markup: coachKeyboard });
  });

  bot.hears(COACH_EXIT_BUTTON, exit);
  bot.command("exit", exit);

  // Inline-кнопка выхода у ответов, отправленных до появления клавиатуры режима.
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
    await ctx.reply(DISCUSS_GREETING, { reply_markup: coachKeyboard });
  });

  // «📝 Записать в дневник» под ответом коуча: сообщение пользователя разбирается как
  // обычная запись еды/тренировки. Разговор при этом не прерывается.
  bot.callbackQuery(/^coach:log:(\d+)$/, async (ctx) => {
    const offer = offers.take(Number(ctx.match[1]), ctx.from.id);
    if (!offer) {
      await ctx.answerCallbackQuery({
        text: "Кнопка устарела — напишите, что съели, ещё раз.",
        show_alert: true,
      });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await withChatAction(ctx, "typing", () =>
      logDescribedMeal(db, ctx, offer.text, offer.source),
    );
  });

  // В режиме разговора текст и голос идут коучу, иначе — дальше, в запись еды.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/") || !store.get(ctx.from.id)) return next();

    await withChatAction(ctx, "typing", () => answer(ctx, ctx.from.id, text, "text"));
  });

  bot.on("message:voice", async (ctx, next) => {
    if (!store.get(ctx.from.id)) return next();

    try {
      await withChatAction(ctx, "typing", async () => {
        const text = await transcribeVoiceMessage(ctx);
        if (text === undefined) return;
        await ctx.reply(buildVoiceConfirmMessage(text), {
          reply_markup: voiceConfirmKeyboard("coach"),
        });
      });
    } catch (err) {
      console.error("Не удалось обработать голосовой вопрос коучу:", err);
      await ctx.reply("Не получилось обработать голосовое сообщение, попробуйте ещё раз.");
    }
  });

  bot.callbackQuery(voiceConfirmPattern("coach"), async (ctx) => {
    const text = await settleVoiceConfirmation(
      ctx,
      ctx.match[1] === "yes",
      "Не отправляю. Задайте вопрос ещё раз голосом или текстом.",
    );
    if (text === undefined) return;

    // Пока пользователь думал над кнопкой, разговор мог закончиться (/exit, таймаут).
    if (!store.get(ctx.from.id)) {
      await ctx.reply(
        "Разговор с Ням-Ням уже завершён. Нажмите «🐱 Спросить Ням-Ням» и задайте вопрос заново.",
        { reply_markup: mainKeyboard },
      );
      return;
    }
    await withChatAction(ctx, "typing", () => answer(ctx, ctx.from.id, text, "voice"));
  });
}
