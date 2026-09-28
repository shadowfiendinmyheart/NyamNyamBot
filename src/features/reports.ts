import { Bot } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import { getMealsForUserOnDate, sumNutrition, type MealRow } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import type { DaySummary } from "../ai/coach.js";
import type { WeightLogRow } from "../db/weightLog.js";
import type { NutritionTargets } from "../nutrition/calculations.js";
import { getTodayBoundsUtc, parseYmd, weekdayOf } from "../utils/dates.js";
import { MEAL_TYPE_LABEL } from "./mealLogging.js";

type Db = BetterSQLite3Database<typeof schema>;

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

const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

function formatDayLabel(date: string): string {
  const ymd = parseYmd(date);
  if (!ymd) return date;
  const dm = `${String(ymd.day).padStart(2, "0")}.${String(ymd.month).padStart(2, "0")}`;
  return `${WEEKDAY_SHORT[weekdayOf(ymd)]} ${dm}`;
}

function formatSignedKg(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "без изменений";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} кг`;
}

// days — все дни недели по порядку (в т.ч. пустые), weights — записи веса за неделю
// по возрастанию времени.
export function buildWeeklyReport(
  days: DaySummary[],
  targets: NutritionTargets | undefined,
  weights: Pick<WeightLogRow, "weightKg">[],
): string {
  const title =
    days.length > 0
      ? `📊 Неделя ${formatDayLabel(days[0].date).slice(3)}–${formatDayLabel(days.at(-1)!.date).slice(3)}`
      : "📊 Неделя";

  const dayLines = days.map((day) =>
    day.meals.length > 0
      ? `• ${formatDayLabel(day.date)} — ${day.totals.kcal} ккал`
      : `• ${formatDayLabel(day.date)} — нет записей`,
  );

  const logged = days.filter((day) => day.meals.length > 0);
  const parts = [title, "", ...dayLines, "", `Дней с записями: ${logged.length} из ${days.length}`];

  if (logged.length > 0) {
    const sum = sumNutrition(logged.map((day) => day.totals));
    const avg = {
      kcal: Math.round(sum.kcal / logged.length),
      proteinG: sum.proteinG / logged.length,
      fatG: sum.fatG / logged.length,
      carbG: sum.carbG / logged.length,
    };
    parts.push(
      `В среднем за день: ${avg.kcal} ккал | Б ${avg.proteinG.toFixed(1)} ` +
        `Ж ${avg.fatG.toFixed(1)} У ${avg.carbG.toFixed(1)}`,
    );
    if (targets) {
      const diff = avg.kcal - targets.dailyKcalTarget;
      parts.push(
        `Норма: ${targets.dailyKcalTarget} ккал | Б ${targets.proteinGTarget.toFixed(1)} ` +
          `Ж ${targets.fatGTarget.toFixed(1)} У ${targets.carbGTarget.toFixed(1)}`,
        diff === 0
          ? "Точно в норму"
          : diff > 0
            ? `В среднем выше нормы на ${diff} ккал в день`
            : `В среднем ниже нормы на ${-diff} ккал в день`,
      );
    }
  }

  parts.push("");
  if (weights.length === 0) {
    parts.push("⚖️ Вес за неделю не записывали — /weight");
  } else if (weights.length === 1) {
    parts.push(`⚖️ Вес: ${weights[0].weightKg} кг (одна запись за неделю)`);
  } else {
    const first = weights[0].weightKg;
    const last = weights.at(-1)!.weightKg;
    parts.push(`⚖️ Вес: ${first} → ${last} кг (${formatSignedKg(last - first)})`);
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
