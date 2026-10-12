import type { Conversation } from "@grammyjs/conversations";
import { Bot, InlineKeyboard, type Api, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { analyzeFood, type AnalyzeFoodResult, type FoodImage } from "../ai/foodAnalyzer.js";
import { getMealById, getMealItemsForMeals, mealPhotoFileIds, type MealRow } from "../db/meals.js";
import { downloadPhoto, toFoodItems } from "./mealLogging.js";
import { applyMealCorrection, correctionUndos, publishMealCorrection } from "./mealCorrection.js";
import {
  buildVoiceConfirmMessage,
  claimVoiceConfirmation,
  settleVoiceConfirmation,
  transcribeVoiceInConversation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
} from "./voiceConfirm.js";
import { withChatActionVia } from "../utils/chatAction.js";
import { isCancelInput } from "./mainMenu.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

function buildCorrectionPrompt(
  previous: AnalyzeFoodResult,
  userText: string,
): string {
  const itemsList = previous.items
    .map(
      (i) =>
        `- ${i.name}: ${i.estimatedWeightG} г, ${i.kcal} ккал ` +
        `(Б ${i.proteinG} / Ж ${i.fatG} / У ${i.carbG})`,
    )
    .join("\n");

  return [
    "Ранее ты оценил этот приём пищи так:",
    itemsList,
    "",
    "Пользователь уточняет оценку: это может быть фактический вес порции, " +
      "состав продуктов и/или их количество.",
    `Уточнение пользователя: "${userText}"`,
    "",
    "Пересчитай состав и КБЖУ с учётом этого уточнения и верни ПОЛНЫЙ обновлённый " +
      "результат через тот же инструмент (все продукты, а не только изменённые).",
  ].join("\n");
}

function extractPreviousResult(db: Db, meal: MealRow): AnalyzeFoodResult {
  const stored = meal.rawClaudeResponse as AnalyzeFoodResult | null;
  if (stored) return stored;

  return {
    foodDetected: true,
    notes: null,
    items: toFoodItems(getMealItemsForMeals(db, [meal.id])),
  };
}

// Кнопки главного меню и команды во время правки не должны превращаться в «уточнение» —
// такое сообщение отменяет правку и обрабатывается как обычно.
// api — внешний bot.api: внутри conversation.external нельзя пользоваться ctx диалога.
export function correctionConversation(db: Db, api: Api) {
  return async function correction(
    conversation: MyConversation,
    ctx: Context,
    mealId: number,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const meal = await conversation.external(() => getMealById(db, mealId, userId));
    if (!meal) {
      await ctx.reply("Эта запись уже не найдена — возможно, она была удалена.");
      return;
    }

    await ctx.reply(
      "Что нужно исправить — вес порции или состав? Опишите текстом или голосовым " +
        "сообщением. /cancel — отменить.",
    );

    // next: true — прочие обновления (фото, нажатия других inline-кнопок) не глотаются
    // диалогом, а уходят обычным обработчикам.
    let response = await conversation.waitFor(["message:text", "message:voice"], {
      next: true,
    });

    let userText: string | undefined;
    while (userText === undefined) {
      const rawText = response.message.text?.trim();
      if (rawText !== undefined) {
        if (isCancelInput(rawText)) {
          await response.reply("Правка отменена.");
          // /cancel обрабатывать больше нечем; остальные команды и кнопки — пропускаем дальше.
          await conversation.halt({ next: rawText !== "/cancel" });
        }
        if (!rawText) {
          await response.reply("Пустое сообщение, отмена.");
          return;
        }
        userText = rawText;
        break;
      }

      const voice = response.message.voice;
      if (!voice) return;
      const transcript = await transcribeVoiceInConversation(conversation, api, response, voice);
      if (transcript === undefined) return;

      // Голосовое уточнение применяем только после подтверждения расшифровки.
      await response.reply(buildVoiceConfirmMessage(transcript), {
        reply_markup: voiceConfirmKeyboard("fix"),
      });

      const next = await conversation.waitFor(
        ["callback_query:data", "message:text", "message:voice"],
        { next: true },
      );
      if (next.has(["message:text", "message:voice"])) {
        // Вместо нажатия кнопки прислали новое сообщение — это новое уточнение.
        response = next;
        continue;
      }

      const match = next.callbackQuery?.data?.match(voiceConfirmPattern("fix"));
      // Чужие кнопки (удалить, обсудить…) диалог не трогает — их обработают как обычно.
      if (!match) return conversation.skip({ next: true });

      // ✏️ и ❌ — ждём новое уточнение ниже, оно и заменит расшифровку.
      userText = await settleVoiceConfirmation(
        next,
        match[1],
        {
          reject:
            "Не учитываю. Опишите уточнение ещё раз — текстом или голосом. /cancel — отменить.",
          edit: "Пришлите исправленное уточнение текстом или голосом. /cancel — отменить.",
        },
        (chatId, messageId) =>
          conversation.external(() => claimVoiceConfirmation(chatId, messageId)),
      );
      if (userText === undefined) {
        response = await conversation.waitFor(["message:text", "message:voice"], {
          next: true,
        });
      }
    }

    const previous = await conversation.external(() => extractPreviousResult(db, meal));
    const prompt = buildCorrectionPrompt(previous, userText);

    await response.reply("⏳ Пересчитываю с учётом уточнения…");

    // Фото не храним у себя — при коррекции заново скачиваем их из Telegram по file_id
    // (у альбома их несколько). Какие не скачались — пропускаем; если ни одного,
    // пересчитываем только по тексту предыдущей оценки.
    const fileIds = meal.source === "photo" ? mealPhotoFileIds(meal) : [];
    const downloadImages = async (): Promise<FoodImage[]> => {
      const results = await Promise.allSettled(
        fileIds.map((fileId) => downloadPhoto(api, fileId)),
      );
      const images: FoodImage[] = [];
      for (const result of results) {
        if (result.status === "fulfilled") images.push(result.value);
        else console.error("Не удалось скачать фото из Telegram для коррекции:", result.reason);
      }
      return images;
    };

    let result: AnalyzeFoodResult;
    try {
      result = await conversation.external(() =>
        withChatActionVia(api, chatId, "typing", async () => {
          return analyzeFood({ text: prompt, images: await downloadImages() });
        }),
      );
    } catch (err) {
      console.error("Не удалось пересчитать приём пищи:", err);
      await ctx.reply("Не получилось пересчитать, попробуйте ещё раз позже.");
      return;
    }

    if (!result.foodDetected || result.items.length === 0) {
      await ctx.reply(
        `Не получилось учесть уточнение.${result.notes ? ` ${result.notes}` : ""} ` +
          "Попробуйте переформулировать.",
      );
      return;
    }

    const applied = await conversation.external(() =>
      applyMealCorrection(db, correctionUndos, {
        userId,
        mealId,
        result,
        sourceMessageId: messageId,
      }),
    );
    if (!applied) {
      await ctx.reply("Не получилось обновить запись — возможно, она была удалена.");
      return;
    }
    await conversation.external(() => publishMealCorrection(api, chatId, applied, messageId));
  };
}

export function registerCorrection(bot: Bot<MyContext>, db: Db): void {
  // Во время правки /cancel перехватывает сам диалог; сюда попадаем, только если
  // отменять нечего.
  bot.command("cancel", async (ctx) => {
    await ctx.reply("Сейчас нечего отменять.");
  });

  // Пока правка идёт, нажатия ✅ / ✏️ / ❌ под голосовым уточнением перехватывает сам
  // диалог; сюда попадаем, только если правка уже закончилась (или бот перезапускался).
  bot.callbackQuery(voiceConfirmPattern("fix"), async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Это уточнение уже неактуально — нажмите «💬 Поправить или спросить» под записью.",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  });

  // correct_weight/correct_items — старые кнопки в уже отправленных сообщениях.
  bot.callbackQuery(/^correct(?:_weight|_items)?:(\d+)$/, async (ctx) => {
    const mealId = Number(ctx.match[1]);

    const meal = getMealById(db, mealId, ctx.from.id);
    if (!meal) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery({
        text: "Не удалось определить сообщение.",
        show_alert: true,
      });
      return;
    }

    if (ctx.conversation.active("correction")) {
      await ctx.answerCallbackQuery({
        text: "Уже идёт уточнение, закончите его.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("correction", mealId, chatId, messageId);
  });
}
