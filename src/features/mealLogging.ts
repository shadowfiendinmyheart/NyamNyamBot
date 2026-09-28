import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import {
  analyzeFood,
  FoodAnalyzerError,
  type FoodItem,
  type ImageMimeType,
} from "../ai/foodAnalyzer.js";
import { transcribeAudio, TranscriberError } from "../ai/transcriber.js";
import {
  createMeal,
  deleteMealForUser,
  sumNutrition,
  type MealItemInput,
  type MealType,
} from "../db/meals.js";
import { downloadTelegramFile } from "../utils/telegram.js";
import { withChatAction } from "../utils/chatAction.js";

const MIME_BY_EXT: Record<string, ImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function mimeTypeForFilePath(filePath: string): ImageMimeType {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
}

type Db = BetterSQLite3Database<typeof schema>;

export const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: "🌅 Завтрак",
  lunch: "🍲 Обед",
  dinner: "🌙 Ужин",
  snack: "🍎 Перекус",
};

export function determineMealType(date: Date, timeZone: string): MealType {
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(
      date,
    ),
  );

  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

export function buildMealMessage(
  mealType: MealType,
  items: FoodItem[],
  notes: string | null,
): string {
  const totals = sumNutrition(items);

  const lines = items.map(
    (item) =>
      `• ${item.name} — ${item.estimatedWeightG} г: ${item.kcal} ккал ` +
      `(Б ${item.proteinG} / Ж ${item.fatG} / У ${item.carbG})`,
  );

  const parts = [
    MEAL_TYPE_LABEL[mealType],
    "",
    ...lines,
    "",
    `Итого: ${totals.kcal} ккал | Б ${totals.proteinG.toFixed(1)} ` +
      `Ж ${totals.fatG.toFixed(1)} У ${totals.carbG.toFixed(1)}`,
  ];

  if (notes) {
    parts.push("", `⚠️ ${notes}`);
  }

  return parts.join("\n");
}

export function mealActionsKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Изменить", `correct:${mealId}`)
    .text("🗑 Удалить", `delete_meal:${mealId}`);
}

export function toMealItemInputs(items: FoodItem[]): MealItemInput[] {
  return items.map((item) => ({
    name: item.name,
    weightG: item.estimatedWeightG,
    kcal: item.kcal,
    proteinG: item.proteinG,
    fatG: item.fatG,
    carbG: item.carbG,
  }));
}

export function replyMessageForError(err: unknown, fallback: string): string {
  return err instanceof FoodAnalyzerError ? err.message : fallback;
}

export function replyMessageForTranscriberError(err: unknown, fallback: string): string {
  return err instanceof TranscriberError ? err.message : fallback;
}

// Скачивает голосовое сообщение и расшифровывает его в текст. При понятных
// пользователю проблемах (слишком длинное, не распознано) сам отвечает и возвращает
// undefined; прочие ошибки пробрасывает.
export async function transcribeVoiceMessage(ctx: MyContext): Promise<string | undefined> {
  const voice = ctx.message?.voice;
  if (!voice) return undefined;

  // Whisper API ограничен 25MB
  const maxSizeBytes = 25 * 1024 * 1024;
  if (voice.file_size && voice.file_size > maxSizeBytes) {
    await ctx.reply(
      "Голосовое сообщение слишком длинное (больше 25MB). Попробуйте записать короче или напишите текстом.",
    );
    return undefined;
  }

  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram не вернул file_path для голосового сообщения");
  }

  const buffer = await downloadTelegramFile(file.file_path);

  try {
    return await transcribeAudio({
      audioBuffer: buffer,
      mimeType: "audio/ogg",
      filename: path.basename(file.file_path),
    });
  } catch (err) {
    console.error("Не удалось распознать голосовое сообщение:", err);
    await ctx.reply(
      replyMessageForTranscriberError(
        err,
        "Не получилось распознать голосовое сообщение, попробуйте ещё раз или напишите текстом.",
      ),
    );
    return undefined;
  }
}

async function logDescribedMeal(
  db: Db,
  ctx: MyContext,
  text: string,
  source: "text" | "voice",
): Promise<void> {
  if (!ctx.from) return;

  const subject = source === "voice" ? "в голосовом сообщении" : "в сообщении";

  try {
    const result = await analyzeFood({ text });
    if (!result.foodDetected || result.items.length === 0) {
      await ctx.reply(
        `Не получилось распознать еду ${subject}.${result.notes ? ` ${result.notes}` : ""} ` +
          "Опишите, что съели, или пришлите фото.",
      );
      return;
    }

    const mealType = determineMealType(new Date(), config.defaultTimezone);
    const mealId = createMeal(db, {
      userId: ctx.from.id,
      mealType,
      source,
      description: text,
      items: toMealItemInputs(result.items),
      rawClaudeResponse: result,
    });

    await ctx.reply(buildMealMessage(mealType, result.items, result.notes), {
      reply_markup: mealActionsKeyboard(mealId),
    });
  } catch (err) {
    console.error("Не удалось обработать описание еды:", err);
    await ctx.reply(
      replyMessageForError(err, "Не получилось обработать сообщение, попробуйте ещё раз."),
    );
  }
}

export function registerMealLogging(bot: Bot<MyContext>, db: Db): void {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    await withChatAction(ctx, "typing", async () => {
      await logDescribedMeal(db, ctx, text, "text");
    });
  });

  bot.on("message:voice", async (ctx) => {
    try {
      await withChatAction(ctx, "typing", async () => {
        const text = await transcribeVoiceMessage(ctx);
        if (text === undefined) return;
        await logDescribedMeal(db, ctx, text, "voice");
      });
    } catch (err) {
      console.error("Не удалось обработать голосовое сообщение:", err);
      await ctx.reply("Не получилось обработать голосовое сообщение, попробуйте ещё раз.");
    }
  });

  bot.on("message:photo", async (ctx) => {
    try {
      console.log(`[${ctx.from.id}] Начало обработки фото в ${new Date().toISOString()}`);
      await withChatAction(ctx, "typing", async () => {
        const photo = ctx.message.photo.at(-1);
        if (!photo) return;

        const file = await ctx.getFile();
        if (!file.file_path) {
          throw new Error("Telegram не вернул file_path для фото");
        }

        const buffer = await downloadTelegramFile(file.file_path);
        const mimeType = mimeTypeForFilePath(file.file_path);
        const caption = ctx.message.caption?.trim();

        const result = await analyzeFood({
          imageBase64: buffer.toString("base64"),
          mimeType,
          text: caption || undefined,
        });
        if (!result.foodDetected || result.items.length === 0) {
          await ctx.reply(
            `Не получилось распознать еду на фото.${result.notes ? ` ${result.notes}` : ""} ` +
              "Пришлите другое фото или опишите текстом.",
          );
          return;
        }

        const mealType = determineMealType(new Date(), config.defaultTimezone);
        const mealId = createMeal(db, {
          userId: ctx.from.id,
          mealType,
          source: "photo",
          telegramFileId: photo.file_id,
          description: caption || result.items.map((item) => item.name).join(", "),
          items: toMealItemInputs(result.items),
          rawClaudeResponse: result,
        });

        await ctx.reply(buildMealMessage(mealType, result.items, result.notes), {
          reply_markup: mealActionsKeyboard(mealId),
        });
        console.log(`[${ctx.from.id}] Фото обработано успешно в ${new Date().toISOString()}`);
      });
    } catch (err) {
      console.error("Не удалось обработать фото еды:", err);
      await ctx.reply(
        replyMessageForError(err, "Не получилось обработать фото, попробуйте ещё раз."),
      );
    }
  });

  bot.callbackQuery(/^delete_meal:(\d+)$/, async (ctx) => {
    const mealId = Number(ctx.match[1]);
    const deleted = deleteMealForUser(db, mealId, ctx.from.id);

    if (deleted) {
      await ctx.editMessageText("🗑 Запись удалена.", { reply_markup: new InlineKeyboard() });
    } else {
      await ctx.answerCallbackQuery({
        text: "Не удалось удалить запись.",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
  });
}
