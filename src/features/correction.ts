import type { Conversation } from "@grammyjs/conversations";
import { Bot, InlineKeyboard, type Api, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { analyzeFood, type AnalyzeFoodResult, type ImageMimeType } from "../ai/foodAnalyzer.js";
import { getMealById, updateMeal, type MealRow } from "../db/meals.js";
import { buildMealMessage, mealActionsKeyboard, mimeTypeForFilePath, toMealItemInputs } from "./mealLogging.js";
import {
  buildVoiceConfirmMessage,
  settleVoiceConfirmation,
  transcribeVoiceInConversation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
} from "./voiceConfirm.js";
import { downloadTelegramFile } from "../utils/telegram.js";
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

  const items = db
    .select()
    .from(schema.mealItems)
    .where(eq(schema.mealItems.mealId, meal.id))
    .all();

  return {
    foodDetected: true,
    notes: null,
    items: items.map((i) => ({
      name: i.name,
      estimatedWeightG: i.weightG,
      kcal: i.kcal,
      proteinG: i.proteinG,
      fatG: i.fatG,
      carbG: i.carbG,
    })),
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
      if (!match) await conversation.skip({ next: true });

      userText = await settleVoiceConfirmation(
        next,
        match?.[1] === "yes",
        "Не учитываю. Опишите уточнение ещё раз — текстом или голосом. /cancel — отменить.",
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

    // Фото не храним у себя — при коррекции заново скачиваем его из Telegram по file_id.
    // Если не получилось, пересчитываем только по тексту предыдущей оценки.
    const fileId = meal.source === "photo" ? meal.telegramFileId : null;
    const downloadImage = async (): Promise<
      { imageBase64: string; mimeType: ImageMimeType } | undefined
    > => {
      if (!fileId) return undefined;
      try {
        const file = await api.getFile(fileId);
        if (!file.file_path) return undefined;
        const buf = await downloadTelegramFile(file.file_path);
        return {
          imageBase64: buf.toString("base64"),
          mimeType: mimeTypeForFilePath(file.file_path),
        };
      } catch (err) {
        console.error("Не удалось скачать фото из Telegram для коррекции:", err);
        return undefined;
      }
    };

    let result: AnalyzeFoodResult;
    try {
      result = await conversation.external(() =>
        withChatActionVia(api, chatId, "typing", async () => {
          const imageInput = await downloadImage();
          return analyzeFood({ text: prompt, ...imageInput });
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

    const updated = await conversation.external(() =>
      updateMeal(db, mealId, userId, {
        items: toMealItemInputs(result.items),
        rawClaudeResponse: result,
      }),
    );
    if (!updated) {
      await ctx.reply("Не получилось обновить запись — возможно, она была удалена.");
      return;
    }

    const messageText = buildMealMessage(meal.mealType, result.items, result.notes);
    await conversation.external(async () => {
      try {
        await api.editMessageText(chatId, messageId, messageText, {
          reply_markup: mealActionsKeyboard(mealId),
        });
      } catch (err) {
        console.error("Не удалось обновить исходное сообщение:", err);
      }
    });

    // Исходное сообщение может быть далеко вверху чата — присылаем обновлённую запись
    // отдельным сообщением с теми же кнопками, чтобы результат был виден сразу.
    await ctx.reply(`✅ Обновил запись:\n\n${messageText}`, {
      reply_markup: mealActionsKeyboard(mealId),
    });
  };
}

export function registerCorrection(bot: Bot<MyContext>, db: Db): void {
  // Во время правки /cancel перехватывает сам диалог; сюда попадаем, только если
  // отменять нечего.
  bot.command("cancel", async (ctx) => {
    await ctx.reply("Сейчас нечего отменять.");
  });

  // Пока правка идёт, нажатия «Да/Нет» под голосовым уточнением перехватывает сам
  // диалог; сюда попадаем, только если правка уже закончилась (или бот перезапускался).
  bot.callbackQuery(voiceConfirmPattern("fix"), async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Это уточнение уже неактуально — нажмите «✏️ Изменить» под записью ещё раз.",
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
