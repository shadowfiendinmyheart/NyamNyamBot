import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { getMealsForUserOnDate, sumNutrition } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getWorkoutsBetween, sumBurnedKcal } from "../db/workouts.js";
import { dayKcalTarget } from "../nutrition/calculations.js";
import { getTodayBoundsUtc } from "../utils/dates.js";

type Db = BetterSQLite3Database<typeof schema>;

// Строка под записью еды: «📊 За день: 1240 / 2100 ккал, осталось 860».
// targetKcal — норма на день с учётом тренировок; undefined — профиля нет, нормы тоже.
// dayLabel — подпись дня записи не за сегодня («вчера»), см. formatMealDay.
export function formatDayProgress(
  eatenKcal: number,
  targetKcal: number | undefined,
  dayLabel: string | null = null,
): string {
  const head = `📊 За ${dayLabel ?? "день"}: ${eatenKcal}`;
  if (targetKcal === undefined) return `${head} ккал`;
  const remaining = targetKcal - eatenKcal;
  return remaining >= 0
    ? `${head} / ${targetKcal} ккал, осталось ${remaining}`
    : `${head} / ${targetKcal} ккал, сверх нормы ${-remaining}`;
}

// Прогресс за тот день (в поясе пользователя), к которому относится момент `at`.
// Норма — как в «📋 Сегодня»: с расходом тренировок, если он прибавляется к норме.
export function buildDayProgressLine(
  db: Db,
  userId: number,
  at: Date,
  timeZone: string,
  dayLabel: string | null = null,
): string {
  const { start, end } = getTodayBoundsUtc(at, timeZone);
  const eaten = sumNutrition(getMealsForUserOnDate(db, userId, start, end)).kcal;

  const profile = getProfileByUserId(db, userId);
  if (!profile) return formatDayProgress(eaten, undefined, dayLabel);

  const burned = sumBurnedKcal(getWorkoutsBetween(db, userId, start, end));
  const target = dayKcalTarget(profile.dailyKcalTarget, profile.activityLevel, burned);
  return formatDayProgress(eaten, target, dayLabel);
}
