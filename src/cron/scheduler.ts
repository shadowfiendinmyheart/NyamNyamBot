import cron from "node-cron";
import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { commentOnPeriod, type CommentOnPeriod, type PeriodKind } from "../ai/coach.js";
import { getMealsForUserOnDate, getUserIdsWithMealsBetween } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getWeightEntriesBetween } from "../db/weightLog.js";
import { coachDiscussKeyboard } from "../features/coach/coach.js";
import { sendMealReminders, sendWeightReminders } from "./reminders.js";
import { createCoachDataSource } from "../features/coach/dataSource.js";
import { buildTodayReport, buildWeeklyReport } from "../features/reports.js";
import { formatYmd, getTodayBoundsUtc, getWeekBoundsUtc } from "../utils/dates.js";

type Db = BetterSQLite3Database<typeof schema>;
type MessageSender = Pick<Api, "sendMessage">;

export const EVENING_SUMMARY_TITLE = "🌙 Итоги дня";

function parseTime(time: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  const hour = match ? Number(match[1]) : NaN;
  const minute = match ? Number(match[2]) : NaN;
  if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
    throw new Error(`Некорректное время "${time}", ожидается формат HH:MM`);
  }
  return { hour, minute };
}

// "23:30" → "30 23 * * *"
export function timeToDailyCron(time: string): string {
  const { hour, minute } = parseTime(time);
  return `${minute} ${hour} * * *`;
}

// "21:00" → "0 21 * * 0" (воскресенье)
export function timeToSundayCron(time: string): string {
  const { hour, minute } = parseTime(time);
  return `${minute} ${hour} * * 0`;
}

// Комментарий Ням-Ням к отчёту. Если ИИ недоступен — отчёт уходит без комментария.
async function withCoachComment(
  report: string,
  makeComment: () => Promise<string>,
  userId: number,
): Promise<string> {
  try {
    return `${report}\n\n🐱 Ням-Ням: ${await makeComment()}`;
  } catch (err) {
    console.error(`Не удалось получить комментарий коуча для пользователя ${userId}:`, err);
    return report;
  }
}

async function sendReport(api: MessageSender, userId: number, text: string, kind: PeriodKind) {
  try {
    await api.sendMessage(userId, text, { reply_markup: coachDiscussKeyboard() });
  } catch (err) {
    // Например, пользователь заблокировал бота — остальным отчёт всё равно шлём.
    const label = kind === "day" ? "вечернюю сводку" : "недельный отчёт";
    console.error(`Не удалось отправить ${label} пользователю ${userId}:`, err);
  }
}

export async function sendEveningSummaries(
  api: MessageSender,
  db: Db,
  now: Date,
  timeZone: string,
  comment: CommentOnPeriod,
): Promise<void> {
  const { start, end } = getTodayBoundsUtc(now, timeZone);

  for (const userId of getUserIdsWithMealsBetween(db, start, end)) {
    const meals = getMealsForUserOnDate(db, userId, start, end);
    const profile = getProfileByUserId(db, userId);
    const report = buildTodayReport(meals, timeZone, profile, EVENING_SUMMARY_TITLE);

    const text = await withCoachComment(
      report,
      () => {
        const snapshot = createCoachDataSource(db, userId, timeZone, () => now).getSnapshot();
        return comment({ kind: "day", snapshot, summaries: [snapshot.today] });
      },
      userId,
    );
    await sendReport(api, userId, text, "day");
  }
}

export async function sendWeeklyReports(
  api: MessageSender,
  db: Db,
  now: Date,
  timeZone: string,
  comment: CommentOnPeriod,
): Promise<void> {
  const week = getWeekBoundsUtc(now, timeZone);

  for (const userId of getUserIdsWithMealsBetween(db, week.start, week.end)) {
    const dataSource = createCoachDataSource(db, userId, timeZone, () => now);
    const days = dataSource.getDailySummaries(formatYmd(week.first), formatYmd(week.last));
    const weights = getWeightEntriesBetween(db, userId, week.start, week.end);
    const report = buildWeeklyReport(days, getProfileByUserId(db, userId), weights);

    const text = await withCoachComment(
      report,
      () => comment({ kind: "week", snapshot: dataSource.getSnapshot(), summaries: days }),
      userId,
    );
    await sendReport(api, userId, text, "week");
  }
}

export function startScheduler(api: MessageSender, db: Db): void {
  const timeZone = config.defaultTimezone;

  cron.schedule(
    timeToDailyCron(config.eveningSummaryTime),
    () => {
      sendEveningSummaries(api, db, new Date(), timeZone, commentOnPeriod).catch((err) => {
        console.error("Ошибка при рассылке вечерней сводки:", err);
      });
    },
    { timezone: timeZone, name: "evening-summary" },
  );

  cron.schedule(
    timeToSundayCron(config.weeklyReportTime),
    () => {
      sendWeeklyReports(api, db, new Date(), timeZone, commentOnPeriod).catch((err) => {
        console.error("Ошибка при рассылке недельного отчёта:", err);
      });
    },
    { timezone: timeZone, name: "weekly-report" },
  );

  if (config.mealRemindersEnabled) {
    cron.schedule(
      "*/15 * * * *",
      () => {
        sendMealReminders(api, db, new Date(), timeZone).catch((err) => {
          console.error("Ошибка при рассылке напоминаний о еде:", err);
        });
      },
      { timezone: timeZone, name: "meal-reminders" },
    );
  }

  cron.schedule(
    timeToDailyCron(config.weightReminderTime),
    () => {
      sendWeightReminders(api, db, new Date(), timeZone).catch((err) => {
        console.error("Ошибка при рассылке напоминаний о весе:", err);
      });
    },
    { timezone: timeZone, name: "weight-reminders" },
  );
}
