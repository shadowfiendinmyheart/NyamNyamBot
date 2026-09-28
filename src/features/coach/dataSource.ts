import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../../db/schema.js";
import {
  MAX_SUMMARY_DAYS,
  type CoachDataSource,
  type CoachMeal,
  type CoachProfile,
  type DayMealItems,
  type DaySummary,
  type WeightEntry,
} from "../../ai/coach.js";
import {
  getMealItemsForMeals,
  getMealsForUserOnDate,
  sumNutrition,
  type MealRow,
} from "../../db/meals.js";
import { getProfileByUserId, type ProfileRow } from "../../db/profiles.js";
import { getWeightHistory } from "../../db/weightLog.js";
import { calculateBmr, calculateTdee } from "../../nutrition/calculations.js";
import {
  addDays,
  diffDays,
  formatYmd,
  getDayBoundsUtc,
  getZonedYmd,
  parseYmd,
  type Ymd,
} from "../../utils/dates.js";

type Db = BetterSQLite3Database<typeof schema>;

const RECENT_WEIGHTS = 5;
const MAX_WEIGHT_HISTORY = 50;

export function createCoachDataSource(
  db: Db,
  userId: number,
  timeZone: string,
  now: () => Date = () => new Date(),
): CoachDataSource {
  const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const toCoachMeal = (meal: MealRow): CoachMeal => ({
    time: timeFormatter.format(meal.loggedAt),
    mealType: meal.mealType,
    description: meal.description,
    kcal: meal.kcal,
    proteinG: meal.proteinG,
    fatG: meal.fatG,
    carbG: meal.carbG,
  });

  const summarizeDays = (first: Ymd, last: Ymd): DaySummary[] => {
    const start = getDayBoundsUtc(first, timeZone).start;
    const end = getDayBoundsUtc(last, timeZone).end;
    const byDate = new Map<string, MealRow[]>();
    for (const meal of getMealsForUserOnDate(db, userId, start, end)) {
      const date = formatYmd(getZonedYmd(meal.loggedAt, timeZone));
      byDate.set(date, [...(byDate.get(date) ?? []), meal]);
    }

    const days: DaySummary[] = [];
    for (let i = 0; i <= diffDays(first, last); i++) {
      const date = formatYmd(addDays(first, i));
      const meals = byDate.get(date) ?? [];
      days.push({ date, totals: sumNutrition(meals), meals: meals.map(toCoachMeal) });
    }
    return days;
  };

  const weightHistory = (limit: number): WeightEntry[] =>
    getWeightHistory(db, userId, limit).map((entry) => ({
      date: formatYmd(getZonedYmd(entry.loggedAt, timeZone)),
      weightKg: entry.weightKg,
    }));

  return {
    getSnapshot() {
      const current = now();
      const today = getZonedYmd(current, timeZone);
      const localNow = new Intl.DateTimeFormat("ru-RU", {
        timeZone,
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(current);

      return {
        now: `${localNow} (${formatYmd(today)})`,
        timeZone,
        profile: toCoachProfile(getProfileByUserId(db, userId)),
        today: summarizeDays(today, today)[0],
        recentWeights: weightHistory(RECENT_WEIGHTS),
      };
    },

    getDailySummaries(from, to) {
      const first = parseDate(from);
      const last = parseDate(to);
      const days = diffDays(first, last) + 1;
      if (days < 1) {
        throw new Error("start_date должна быть не позже end_date");
      }
      if (days > MAX_SUMMARY_DAYS) {
        throw new Error(
          `Период слишком длинный (${days} дн.). Максимум — ${MAX_SUMMARY_DAYS} дней за один запрос.`,
        );
      }
      return summarizeDays(first, last);
    },

    getMealItems(date): DayMealItems {
      const day = parseDate(date);
      const { start, end } = getDayBoundsUtc(day, timeZone);
      const meals = getMealsForUserOnDate(db, userId, start, end);
      const items = getMealItemsForMeals(
        db,
        meals.map((meal) => meal.id),
      );

      return {
        date: formatYmd(day),
        meals: meals.map((meal) => ({
          ...toCoachMeal(meal),
          items: items
            .filter((item) => item.mealId === meal.id)
            .map(({ name, weightG, kcal, proteinG, fatG, carbG }) => ({
              name,
              weightG,
              kcal,
              proteinG,
              fatG,
              carbG,
            })),
        })),
      };
    },

    getWeightHistory(limit) {
      const safeLimit = Number.isFinite(limit)
        ? Math.min(Math.max(Math.trunc(limit), 1), MAX_WEIGHT_HISTORY)
        : RECENT_WEIGHTS;
      return weightHistory(safeLimit);
    },
  };
}

function parseDate(text: string): Ymd {
  const ymd = parseYmd(text);
  if (!ymd) throw new Error(`Некорректная дата "${text}", нужен формат YYYY-MM-DD`);
  return ymd;
}

function toCoachProfile(profile: ProfileRow | undefined): CoachProfile | null {
  if (!profile) return null;
  return {
    sex: profile.sex,
    age: profile.age,
    heightCm: profile.heightCm,
    weightKg: profile.weightKg,
    activityLevel: profile.activityLevel,
    goal: profile.goal,
    bmrKcal: Math.round(calculateBmr(profile)),
    tdeeKcal: Math.round(calculateTdee(profile)),
    targets: {
      dailyKcalTarget: profile.dailyKcalTarget,
      proteinGTarget: profile.proteinGTarget,
      fatGTarget: profile.fatGTarget,
      carbGTarget: profile.carbGTarget,
    },
  };
}
