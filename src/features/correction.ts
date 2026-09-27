import type { Conversation } from "@grammyjs/conversations";
import { Bot, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { eq } from "drizzle-orm";
import * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { analyzeFood, type AnalyzeFoodResult, type ImageMimeType } from "../ai/foodAnalyzer.js";
import { transcribeAudio, TranscriberError } from "../ai/transcriber.js";
import { getMealById, updateMeal, type MealRow } from "../db/meals.js";
import { buildMealMessage, mealActionsKeyboard, mimeTypeForFilePath, toMealItemInputs } from "./mealLogging.js";
import { downloadTelegramFile } from "../utils/telegram.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;
type CorrectionMode = "weight" | "composition";

function buildCorrectionPrompt(
  previous: AnalyzeFoodResult,
  mode: CorrectionMode,
  userText: string,
): string {
  const itemsList = previous.items
    .map(
      (i) =>
        `- ${i.name}: ${i.estimatedWeightG} г, ${i.kcal} ккал ` +
        `(Б ${i.proteinG} / Ж ${i.fatG} / У ${i.carbG})`,
    )
    .join("\n");

  const instruction =
    mode === "weight"
      ? "Пользователь уточняет фактический вес порции (состав продуктов не менялся)."
      : "Пользователь уточняет состав приёма пищи (изменились продукты и/или их количество).";

  return [
    "Ранее ты оценил этот приём пищи так:",
    itemsList,
    "",
    instruction,
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

export function correctionConversation(db: Db) {
  return async function correction(
    conversation: MyConversation,
    ctx: Context,
    mealId: number,
    mode: CorrectionMode,
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
      mode === "weight"
        ? "Какой был фактический вес порции? Опишите текстом или голосовым сообщением."
        : "Что нужно изменить в составе? Опишите текстом или голосовым сообщением.",
    );

    const response = await conversation.waitFor(["message:text", "message:voice"]);

    let userText: string;
    if (response.message.voice) {
      const voice = response.message.voice;
      
      // Whisper API ограничен 25MB
      const maxSizeBytes = 25 * 1024 * 1024;
      if (voice.file_size && voice.file_size > maxSizeBytes) {
        await response.reply(
          "Голосовое сообщение слишком длинное (больше 25MB). Попробуйте записать короче или напишите текстом.",
        );
        return;
      }

      const voiceFile = await conversation.external(() => response.getFile());
      if (!voiceFile.file_path) {
        await response.reply("Не удалось скачать голосовое сообщение, попробуйте ещё раз.");
        return;
      }
      const filePath = voiceFile.file_path;

      try {
        const buffer = await conversation.external(() => downloadTelegramFile(filePath));
        userText = await conversation.external(() =>
          transcribeAudio({
            audioBuffer: buffer,
            mimeType: "audio/ogg",
            filename: filePath.split("/").pop() ?? "voice.oga",
          }),
        );
      } catch (err) {
        console.error("Не удалось распознать голосовое уточнение:", err);
        await response.reply(
          err instanceof TranscriberError
            ? err.message
            : "Не получилось распознать голосовое сообщение, попробуйте ещё раз или напишите текстом.",
        );
        return;
      }
    } else {
      userText = response.message.text?.trim() ?? "";
    }

    if (!userText) {
      await response.reply("Пустое сообщение, отмена.");
      return;
    }

    const previous = await conversation.external(() => extractPreviousResult(db, meal));
    const prompt = buildCorrectionPrompt(previous, mode, userText);

    // Фото не храним у себя — при коррекции заново скачиваем его из Telegram по file_id.
    // Если не получилось, пересчитываем только по тексту предыдущей оценки.
    let imageInput: { imageBase64: string; mimeType: ImageMimeType } | undefined;
    if (meal.source === "photo" && meal.telegramFileId) {
      const fileId = meal.telegramFileId;
      imageInput = await conversation.external(async () => {
        try {
          const file = await ctx.api.getFile(fileId);
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
      });
    }

    let result: AnalyzeFoodResult;
    try {
      result = await conversation.external(() => analyzeFood({ text: prompt, ...imageInput }));
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
        await ctx.api.editMessageText(chatId, messageId, messageText, {
          reply_markup: mealActionsKeyboard(mealId),
        });
      } catch (err) {
        console.error("Не удалось обновить исходное сообщение:", err);
      }
    });

    await ctx.reply("✅ Обновил запись.");
  };
}

export function registerCorrection(bot: Bot<MyContext>, db: Db): void {
  bot.callbackQuery(/^correct_(weight|items):(\d+)$/, async (ctx) => {
    const mode: CorrectionMode = ctx.match[1] === "weight" ? "weight" : "composition";
    const mealId = Number(ctx.match[2]);

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
    await ctx.conversation.enter("correction", mealId, mode, chatId, messageId);
  });
}
