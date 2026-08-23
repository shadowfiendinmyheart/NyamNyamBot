import fs from "node:fs/promises";
import path from "node:path";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { analyzeFood, type FoodItem, type ImageMimeType } from "../ai/foodAnalyzer.js";
import { createMeal, deleteMealForUser, sumNutrition, type MealType } from "../db/meals.js";

const MIME_BY_EXT: Record<string, ImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

function mimeTypeForFilePath(filePath: string): ImageMimeType {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
}

function extensionForMimeType(mimeType: ImageMimeType): string {
  return mimeType === "image/png" ? ".png" : mimeType === "image/webp" ? ".webp" : ".jpg";
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

function deleteKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard().text("🗑 Удалить", `delete_meal:${mealId}`);
}

export function registerMealLogging(bot: Bot<Context>, db: Db): void {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    await ctx.replyWithChatAction("typing");

    try {
      const result = await analyzeFood({ text });
      if (!result.foodDetected || result.items.length === 0) {
        await ctx.reply(
          `Не получилось распознать еду в сообщении.${result.notes ? ` ${result.notes}` : ""} ` +
            "Опишите, что съели, или пришлите фото.",
        );
        return;
      }

      const mealType = determineMealType(new Date(), config.defaultTimezone);
      const mealId = createMeal(db, {
        userId: ctx.from.id,
        mealType,
        source: "text",
        description: text,
        items: result.items.map((item) => ({
          name: item.name,
          weightG: item.estimatedWeightG,
          kcal: item.kcal,
          proteinG: item.proteinG,
          fatG: item.fatG,
          carbG: item.carbG,
        })),
        rawClaudeResponse: result,
      });

      await ctx.reply(buildMealMessage(mealType, result.items, result.notes), {
        reply_markup: deleteKeyboard(mealId),
      });
    } catch (err) {
      console.error("Не удалось обработать текстовое описание еды:", err);
      await ctx.reply("Не получилось обработать сообщение, попробуйте ещё раз.");
    }
  });

  bot.on("message:photo", async (ctx) => {
    await ctx.replyWithChatAction("typing");

    try {
      const photo = ctx.message.photo.at(-1);
      if (!photo) return;

      const file = await ctx.getFile();
      if (!file.file_path) {
        throw new Error("Telegram не вернул file_path для фото");
      }

      const fileUrl = `https://api.telegram.org/file/bot${config.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        throw new Error(`Не удалось скачать фото из Telegram: ${response.status}`);
      }
      const buffer = Buffer.from(await response.arrayBuffer());
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

      const photoPath = path.join(
        config.photosDir,
        `${ctx.from.id}_${Date.now()}${extensionForMimeType(mimeType)}`,
      );
      await fs.writeFile(photoPath, buffer);

      const mealType = determineMealType(new Date(), config.defaultTimezone);
      const mealId = createMeal(db, {
        userId: ctx.from.id,
        mealType,
        source: "photo",
        photoPath,
        description: caption || result.items.map((item) => item.name).join(", "),
        items: result.items.map((item) => ({
          name: item.name,
          weightG: item.estimatedWeightG,
          kcal: item.kcal,
          proteinG: item.proteinG,
          fatG: item.fatG,
          carbG: item.carbG,
        })),
        rawClaudeResponse: result,
      });

      await ctx.reply(buildMealMessage(mealType, result.items, result.notes), {
        reply_markup: deleteKeyboard(mealId),
      });
    } catch (err) {
      console.error("Не удалось обработать фото еды:", err);
      await ctx.reply("Не получилось обработать фото, попробуйте ещё раз.");
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
