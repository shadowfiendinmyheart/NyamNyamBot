// Тип и время приёма пищи: по часам записи или по тому, что пользователь назвал сам
// («вчера на ужин», «в 9 утра»). Время — в таймзоне пользователя, хранится в UTC.
import type { MealTimeHint } from "../ai/messageAnalyzer.js";
import type { MealType } from "../db/meals.js";
import {
  addDays,
  diffDays,
  getZonedDateTimeUtc,
  getZonedMinutesOfDay,
  getZonedYmd,
} from "./dates.js";

// Насколько далеко назад можно записать еду из текста — дальше это скорее ошибка разбора.
export const MAX_MEAL_DAYS_AGO = 7;

// Время, на которое ставим «вчера на ужин», если час не назван. Перекус — без
// типичного времени: берётся текущее время суток.
const TYPICAL_MINUTES: Partial<Record<MealType, number>> = {
  breakfast: 9 * 60,
  lunch: 13 * 60,
  dinner: 19 * 60,
};

export function determineMealType(date: Date, timeZone: string): MealType {
  const hour = Math.floor(getZonedMinutesOfDay(date, timeZone) / 60);

  if (hour >= 4 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 16) return "lunch";
  if (hour >= 16 && hour < 22) return "dinner";
  return "snack";
}

export function normalizeDaysAgo(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_MEAL_DAYS_AGO
    ? value
    : 0;
}

// Когда записать приём пищи: названный день и время, иначе типичное время названного
// приёма пищи, иначе текущее время суток. В будущее запись не попадает — такое время
// заменяется на «сейчас». Тип — названный или по часам итогового времени.
export function resolveMealTime(
  hint: MealTimeHint,
  now: Date,
  timeZone: string,
): { loggedAt: Date; mealType: MealType } {
  const daysAgo = normalizeDaysAgo(hint.daysAgo);
  const minutes =
    hint.minutesOfDay ?? (hint.mealType ? TYPICAL_MINUTES[hint.mealType] : undefined);

  let loggedAt = now;
  if (daysAgo > 0 || minutes !== undefined) {
    const day = addDays(getZonedYmd(now, timeZone), -daysAgo);
    const at = getZonedDateTimeUtc(day, minutes ?? getZonedMinutesOfDay(now, timeZone), timeZone);
    if (at < now) loggedAt = at;
  }

  return { loggedAt, mealType: hint.mealType ?? determineMealType(loggedAt, timeZone) };
}

// Время записи после смены типа кнопкой: типичное время нового приёма пищи в тот же
// день (не в будущем), чтобы «🌅 Завтрак» не стоял в отчёте на 21:10. Перекус — без
// типичного времени, время не меняется.
export function loggedAtForMealType(
  loggedAt: Date,
  mealType: MealType,
  now: Date,
  timeZone: string,
): Date {
  const minutes = TYPICAL_MINUTES[mealType];
  if (minutes === undefined) return loggedAt;
  const at = getZonedDateTimeUtc(getZonedYmd(loggedAt, timeZone), minutes, timeZone);
  return at < now ? at : now;
}

export function mealDaysAgo(loggedAt: Date, now: Date, timeZone: string): number {
  return diffDays(getZonedYmd(loggedAt, timeZone), getZonedYmd(now, timeZone));
}

// Подпись дня для записи не за сегодня: «вчера», «позавчера», «3 октября»; null — сегодня.
export function formatMealDay(loggedAt: Date, now: Date, timeZone: string): string | null {
  const daysAgo = mealDaysAgo(loggedAt, now, timeZone);
  if (daysAgo === 0) return null;
  if (daysAgo === 1) return "вчера";
  if (daysAgo === 2) return "позавчера";
  return new Intl.DateTimeFormat("ru-RU", { timeZone, day: "numeric", month: "long" }).format(
    loggedAt,
  );
}
