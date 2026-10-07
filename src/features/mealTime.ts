import { Bot, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getMealById, updateMealTime, MEAL_TYPES, type MealType } from "../db/meals.js";
import { getUserTimeZone } from "../db/users.js";
import { getZonedMinutesOfDay } from "../utils/dates.js";
import { loggedAtForMealType, mealDaysAgo, resolveMealTime } from "../utils/mealTime.js";
import { buildStoredMealMessage, MEAL_TYPE_LABEL, mealActionsKeyboard } from "./mealLogging.js";

type Db = BetterSQLite3Database<typeof schema>;

const DAY_CHOICES = [
  { daysAgo: 0, label: "Сегодня" },
  { daysAgo: 1, label: "Вчера" },
];

function marked(label: string, selected: boolean): string {
  return selected ? `✅ ${label}` : label;
}

// Выбор типа приёма пищи и дня под записью; текущие значения отмечены галочкой.
export function mealTimeKeyboard(mealId: number, mealType: MealType, daysAgo: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  MEAL_TYPES.forEach((type, index) => {
    keyboard.text(marked(MEAL_TYPE_LABEL[type], type === mealType), `meal_set:${mealId}:type:${type}`);
    if (index % 2 === 1) keyboard.row();
  });
  for (const day of DAY_CHOICES) {
    keyboard.text(marked(day.label, day.daysAgo === daysAgo), `meal_set:${mealId}:day:${day.daysAgo}`);
  }
  return keyboard.row().text("◀️ Готово", `meal_time_done:${mealId}`);
}

export function registerMealTime(bot: Bot<MyContext>, db: Db): void {
  bot.callbackQuery(/^meal_time:(\d+)$/, async (ctx) => {
    const meal = getMealById(db, Number(ctx.match[1]), ctx.from.id);
    if (!meal) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    const timeZone = getUserTimeZone(db, ctx.from.id);
    await ctx.answerCallbackQuery({ text: "Выберите приём пищи и день" });
    // Повторное нажатие падает с «message is not modified» — клавиатура уже та же.
    await ctx
      .editMessageReplyMarkup({
        reply_markup: mealTimeKeyboard(
          meal.id,
          meal.mealType,
          mealDaysAgo(meal.loggedAt, new Date(), timeZone),
        ),
      })
      .catch(() => {});
  });

  bot.callbackQuery(/^meal_set:(\d+):(type|day):(\w+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const meal = getMealById(db, Number(ctx.match[1]), userId);
    if (!meal) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    const now = new Date();
    const timeZone = getUserTimeZone(db, userId);
    let update: { loggedAt: Date; mealType: MealType };
    if (ctx.match[2] === "type") {
      const mealType = ctx.match[3] as MealType;
      if (!MEAL_TYPES.includes(mealType)) {
        await ctx.answerCallbackQuery();
        return;
      }
      update = { loggedAt: loggedAtForMealType(meal.loggedAt, mealType, now, timeZone), mealType };
    } else {
      // Переносим на другой день в то же время суток (но не в будущее).
      update = resolveMealTime(
        {
          daysAgo: Number(ctx.match[3]),
          minutesOfDay: getZonedMinutesOfDay(meal.loggedAt, timeZone),
          mealType: meal.mealType,
        },
        now,
        timeZone,
      );
    }

    // Повторное нажатие на выбранный вариант: Telegram не даёт «изменить» сообщение
    // на такое же.
    if (
      update.mealType === meal.mealType &&
      mealDaysAgo(update.loggedAt, now, timeZone) === mealDaysAgo(meal.loggedAt, now, timeZone)
    ) {
      await ctx.answerCallbackQuery();
      return;
    }

    if (!updateMealTime(db, meal.id, userId, update)) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    const updated = { ...meal, ...update };
    await ctx.editMessageText(buildStoredMealMessage(db, updated, timeZone, now), {
      reply_markup: mealTimeKeyboard(
        meal.id,
        updated.mealType,
        mealDaysAgo(updated.loggedAt, now, timeZone),
      ),
    });
    await ctx.answerCallbackQuery({ text: "Сохранил" });
  });

  bot.callbackQuery(/^meal_time_done:(\d+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx
      .editMessageReplyMarkup({ reply_markup: mealActionsKeyboard(Number(ctx.match[1])) })
      .catch(() => {});
  });
}
