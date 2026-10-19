import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema.js";
import { getUserTimeZone } from "../../db/users.js";
import {
  FINISH_CONVERSATION_FIRST_TEXT,
  hasActiveConversation,
  type MyContext,
} from "../../context.js";
import { askCoach, CoachError, type CoachMealContext, type CoachReply } from "../../ai/coach.js";
import type { FoodItem } from "../../ai/foodAnalyzer.js";
import { getMealById, getMealItemsForMeals } from "../../db/meals.js";
import { withChatAction } from "../../utils/chatAction.js";
import { COACH_BUTTON, COACH_EXIT_BUTTON, mainKeyboard } from "../mainMenu.js";
import { applyMealCorrection, correctionUndos, publishMealCorrection } from "../mealCorrection.js";
import {
  buildPer100gBlock,
  buildStoredMealMessage,
  logDescribedMeal,
  toFoodItems,
  transcribeVoiceMessage,
} from "../mealLogging.js";
import {
  buildVoiceConfirmMessage,
  settleVoiceConfirmation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
} from "../voiceConfirm.js";
import { enrichWithProductData } from "../productData.js";
import { createCoachDataSource } from "./dataSource.js";
import { DiaryOfferStore } from "./diaryOffers.js";
import { CoachSessionStore, type CoachSessionMeal } from "./session.js";

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
const MEAL_GREETING = [
  "🐱 Давайте разберёмся с этой записью. Напишите, что поправить или о чём спросить: " +
    "«порция была 200 г», «ещё был сырный соус», «это много на ужин?».",
  "",
  MODE_HINT,
].join("\n");
const MEAL_NOT_FOUND_TEXT = "Эта запись уже не найдена — возможно, её удалили.";
const EXIT_TEXT = "Возвращаюсь к записи еды 🐾 Позовите, если что — кнопка «🐱 Спросить Ням-Ням».";
const AUTO_CLOSE_TEXT =
  "🐱 Закрываю наш разговор — час без сообщений. Возвращаюсь к записи еды: " +
  "присылайте фото или пишите, что съели. Поговорить (или повторить последний вопрос) — " +
  "снова «🐱 Спросить Ням-Ням».";
const NOT_TALKING_TEXT = "Мы сейчас и не разговариваем — просто присылайте, что съели 🐾";
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

// Разговор с Ням-Ням о записи еды: вопросы — ответ, правка — новый состав записи.
// messageId — сообщение с записью, его бот обновит после правки.
export type StartMealDiscussion = (
  ctx: MyContext,
  mealId: number,
  messageId: number | null,
) => Promise<void>;

// Кнопка «💬 Поправить или спросить» и «✏️» в истории (features/history.ts).
export function createMealDiscussion(store: CoachSessionStore): StartMealDiscussion {
  return async (ctx, mealId, messageId) => {
    if (!ctx.from) return;
    store.start(ctx.from.id, undefined, { id: mealId, messageId });
    await ctx.reply(MEAL_GREETING, { reply_markup: coachKeyboard });
  };
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

  // "expired" — сессия только что закрылась по таймауту: сообщение об этом уже ушло
  // (onExpire), вопрос не отправляем ни коучу, ни в запись еды.
  function sessionState(userId: number): "active" | "expired" | "none" {
    const existed = store.has(userId);
    if (store.get(userId)) return "active";
    return existed ? "expired" : "none";
  }

  async function answer(
    ctx: MyContext,
    userId: number,
    question: string,
    source: "text" | "voice",
  ): Promise<void> {
    const session = store.get(userId);
    if (!session) return;
    // Вопрос — уже активность: пока Ням-Ням думает, сессия не должна истечь по таймауту.
    store.touch(userId);
    const sentAt = new Date();

    let reply: CoachReply;
    try {
      reply = await askCoach({
        history: session.history,
        question,
        context: session.context,
        meal: mealContext(userId, session.meal),
        dataSource: createCoachDataSource(db, userId, getUserTimeZone(db, userId)),
      });
      store.append(userId, question, reply.text);
      await ctx.reply(
        reply.text,
        reply.offerDiaryEntry
          ? { reply_markup: diaryOfferKeyboard(offers.add({ userId, text: question, source, sentAt })) }
          : {},
      );
    } catch (err) {
      console.error("Коуч не смог ответить:", err);
      await ctx.reply(
        err instanceof CoachError ? err.message : "🐱 Не смогла ответить. Попробуйте ещё раз.",
      );
      return;
    }

    if (reply.mealCorrection && session.meal) {
      await saveMealCorrection(ctx, userId, session.meal, reply.mealCorrection);
    }
  }

  // Запись читается из БД на каждом ходу: после правки Ням-Ням видит новый состав.
  function mealContext(userId: number, meal: CoachSessionMeal | undefined): CoachMealContext | undefined {
    if (!meal) return undefined;
    const row = getMealById(db, meal.id, userId);
    if (!row) return { entry: null };
    // КБЖУ на 100 г — чтобы при правке модель перенесла нетронутые продукты как есть, а не
    // пересчитывала их из значений порции.
    const entry = buildStoredMealMessage(db, row, getUserTimeZone(db, userId));
    const items = toFoodItems(getMealItemsForMeals(db, [row.id]));
    return { entry: `${entry}\n\n${buildPer100gBlock(items)}` };
  }

  // Новый состав от Ням-Ням сохраняет бот — так же, как после «✏️ Изменить».
  async function saveMealCorrection(
    ctx: MyContext,
    userId: number,
    meal: CoachSessionMeal,
    items: FoodItem[],
  ): Promise<void> {
    try {
      const applied = applyMealCorrection(db, correctionUndos, {
        userId,
        mealId: meal.id,
        result: { foodDetected: true, items: await enrichWithProductData(items), notes: null },
        sourceMessageId: meal.messageId,
      });
      if (!applied || !ctx.chat) {
        await ctx.reply(`Не получилось поправить запись. ${MEAL_NOT_FOUND_TEXT}`);
        return;
      }
      // Тот же состав, что уже записан: ответ Ням-Ням уже прозвучал, карточка не нужна.
      if (applied === "unchanged") return;
      await publishMealCorrection(ctx.api, ctx.chat.id, applied, meal.messageId);
    } catch (err) {
      console.error("Не удалось сохранить правку записи от Ням-Ням:", err);
      await ctx.reply("Не получилось сохранить правку записи, попробуйте ещё раз.");
    }
  }

  async function exit(ctx: MyContext): Promise<void> {
    if (!ctx.from) return;
    await ctx.reply(store.end(ctx.from.id) ? EXIT_TEXT : NOT_TALKING_TEXT, {
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

  // «💬 Поправить или спросить» под записью еды: разговор о ней — на вопросы Ням-Ням
  // отвечает, а правку («было 200 г») сохраняет в эту запись.
  const startMealDiscussion = createMealDiscussion(store);
  bot.callbackQuery(/^coach:meal:(\d+)$/, async (ctx) => {
    const mealId = Number(ctx.match[1]);
    if (!getMealById(db, mealId, ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: MEAL_NOT_FOUND_TEXT, show_alert: true });
      return;
    }
    // Пока открыт диалог (например, старая «✏️ Изменить»), текст уйдёт ему, а не Ням-Ням:
    // вопрос «это много?» пересчитал бы запись.
    if (hasActiveConversation(ctx)) {
      await ctx.answerCallbackQuery({ text: FINISH_CONVERSATION_FIRST_TEXT, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await startMealDiscussion(ctx, mealId, ctx.callbackQuery.message?.message_id ?? null);
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
      logDescribedMeal(db, ctx, offer.text, offer.source, offer.sentAt),
    );
  });

  // В режиме разговора текст и голос идут коучу, иначе — дальше, в запись еды.
  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return next();
    const state = sessionState(ctx.from.id);
    if (state === "none") return next();
    if (state === "expired") return;

    await withChatAction(ctx, "typing", () => answer(ctx, ctx.from.id, text, "text"));
  });

  bot.on("message:voice", async (ctx, next) => {
    const state = sessionState(ctx.from.id);
    if (state === "none") return next();
    if (state === "expired") return;

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
    const text = await settleVoiceConfirmation(ctx, ctx.match[1], {
      reject: "Не отправляю. Задайте вопрос ещё раз голосом или текстом.",
      edit: "Пришлите исправленный вопрос текстом или задайте его голосом ещё раз.",
    });
    if (text === undefined) return;

    // Пока пользователь думал над кнопкой, разговор мог закончиться (/exit, таймаут).
    const state = sessionState(ctx.from.id);
    if (state === "expired") return;
    if (state === "none") {
      await ctx.reply(
        "Наш разговор уже закончился. Нажмите «🐱 Спросить Ням-Ням» и задайте вопрос заново.",
        { reply_markup: mainKeyboard },
      );
      return;
    }
    await withChatAction(ctx, "typing", () => answer(ctx, ctx.from.id, text, "voice"));
  });
}
