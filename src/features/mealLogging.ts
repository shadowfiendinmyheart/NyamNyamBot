import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { analyzeFood, type FoodItem } from "../ai/foodAnalyzer.js";
import { createMeal, deleteMealForUser, sumNutrition, type MealType } from "../db/meals.js";

type Db = BetterSQLite3Database<typeof schema>;

const MEAL_TYPE_LABEL: Record<MealType, string> = {
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
