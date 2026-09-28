import cron from "node-cron";
import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { getMealsForUserOnDate, getUserIdsWithMealsBetween } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { buildTodayReport, getTodayBoundsUtc } from "../features/reports.js";

type Db = BetterSQLite3Database<typeof schema>;
type MessageSender = Pick<Api, "sendMessage">;

export const EVENING_SUMMARY_TITLE = "🌙 Итоги дня";

// "23:30" → "30 23 * * *"
export function timeToDailyCron(time: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new Error(`Некорректное время "${time}", ожидается формат HH:MM`);
  }
  return `${minute} ${hour} * * *`;
}

export async function sendEveningSummaries(
  api: MessageSender,
  db: Db,
  now: Date,
  timeZone: string,
): Promise<void> {
  const { start, end } = getTodayBoundsUtc(now, timeZone);

  for (const userId of getUserIdsWithMealsBetween(db, start, end)) {
    const meals = getMealsForUserOnDate(db, userId, start, end);
    const profile = getProfileByUserId(db, userId);
    try {
      await api.sendMessage(
        userId,
        buildTodayReport(meals, timeZone, profile, EVENING_SUMMARY_TITLE),
      );
    } catch (err) {
      // Например, пользователь заблокировал бота — остальным сводку всё равно шлём.
      console.error(`Не удалось отправить вечернюю сводку пользователю ${userId}:`, err);
    }
  }
}

export function startScheduler(api: MessageSender, db: Db): void {
  const timeZone = config.defaultTimezone;

  cron.schedule(
    timeToDailyCron(config.eveningSummaryTime),
    () => {
      sendEveningSummaries(api, db, new Date(), timeZone).catch((err) => {
        console.error("Ошибка при рассылке вечерней сводки:", err);
      });
    },
    { timezone: timeZone, name: "evening-summary" },
  );
}
