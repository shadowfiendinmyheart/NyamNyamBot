import { Bot } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { getMealsForUserOnDate, sumNutrition, type MealRow } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import type { NutritionTargets } from "../nutrition/calculations.js";
import { MEAL_TYPE_LABEL } from "./mealLogging.js";

type Db = BetterSQLite3Database<typeof schema>;

function getZonedYmd(date: Date, timeZone: string): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function getTimeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((acc, p) => {
      if (p.type !== "literal") acc[p.type] = p.value;
      return acc;
    }, {});
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

function zonedMidnightUtc(year: number, month: number, day: number, timeZone: string): Date {
  const naiveUtc = Date.UTC(year, month - 1, day, 0, 0, 0);
  const offsetMs = getTimeZoneOffsetMs(new Date(naiveUtc), timeZone);
  return new Date(naiveUtc - offsetMs);
}

export function getTodayBoundsUtc(now: Date, timeZone: string): { start: Date; end: Date } {
  const { year, month, day } = getZonedYmd(now, timeZone);
  const start = zonedMidnightUtc(year, month, day, timeZone);
  const tomorrow = getZonedYmd(new Date(start.getTime() + 24 * 60 * 60 * 1000), timeZone);
  const end = zonedMidnightUtc(tomorrow.year, tomorrow.month, tomorrow.day, timeZone);
  return { start, end };
}

export function buildTodayReport(
  meals: MealRow[],
  timeZone: string,
  targets?: NutritionTargets,
  title = "📋 Сегодня",
): string {
  if (meals.length === 0) {
    return "Сегодня записей о приёмах пищи пока нет.";
  }

  const totals = sumNutrition(meals);
  const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const lines = meals.map((meal) => {
    const time = timeFormatter.format(meal.loggedAt);
    return (
      `• ${time} ${MEAL_TYPE_LABEL[meal.mealType]} — ${meal.description}: ${meal.kcal} ккал ` +
      `(Б ${meal.proteinG.toFixed(1)} / Ж ${meal.fatG.toFixed(1)} / У ${meal.carbG.toFixed(1)})`
    );
  });

  const parts = [
    title,
    "",
    ...lines,
    "",
    `Итого: ${totals.kcal} ккал | Б ${totals.proteinG.toFixed(1)} ` +
      `Ж ${totals.fatG.toFixed(1)} У ${totals.carbG.toFixed(1)}`,
  ];

  if (targets) {
    const remainingKcal = targets.dailyKcalTarget - totals.kcal;
    parts.push(
      `Норма: ${targets.dailyKcalTarget} ккал | Б ${targets.proteinGTarget.toFixed(1)} ` +
        `Ж ${targets.fatGTarget.toFixed(1)} У ${targets.carbGTarget.toFixed(1)}`,
      remainingKcal >= 0
        ? `Осталось: ${remainingKcal} ккал`
        : `Превышение: ${-remainingKcal} ккал`,
    );
  }

  return parts.join("\n");
}

export async function sendTodayReport(ctx: MyContext, db: Db): Promise<void> {
  if (!ctx.from) return;

  const { start, end } = getTodayBoundsUtc(new Date(), config.defaultTimezone);
  const meals = getMealsForUserOnDate(db, ctx.from.id, start, end);
  const profile = getProfileByUserId(db, ctx.from.id);
  await ctx.reply(buildTodayReport(meals, config.defaultTimezone, profile));
}

export function registerReports(bot: Bot<MyContext>, db: Db): void {
  bot.command("today", async (ctx) => {
    await sendTodayReport(ctx, db);
  });
}
