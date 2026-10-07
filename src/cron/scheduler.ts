import cron from "node-cron";
import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { commentOnPeriod, type CommentOnPeriod, type PeriodKind } from "../ai/coach.js";
import { getMealsForUserOnDate } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getWeightEntriesBetween } from "../db/weightLog.js";
import { getAllUserTimeZones, type UserTimeZone } from "../db/users.js";
import { getWorkoutsBetween } from "../db/workouts.js";
import { coachDiscussKeyboard } from "../features/coach/coach.js";
import { sendMealReminders, sendWeightReminders } from "./reminders.js";
import { createCoachDataSource } from "../features/coach/dataSource.js";
import { buildTodayReport, buildWeeklyReport } from "../features/reports.js";
import {
  formatYmd,
  getTodayBoundsUtc,
  getWeekBoundsUtc,
  getZonedMinutesOfDay,
  getZonedYmd,
  weekdayOf,
} from "../utils/dates.js";

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

const SUNDAY = 0;

// Локальное время пользователя — ровно time (HH:MM), а если задан weekday, то ещё и этот
// день недели (0 — воскресенье). Планировщик тикает раз в минуту, и каждую рассылку
// пользователь получает в «свою» минуту.
export function isLocalTime(now: Date, timeZone: string, time: string, weekday?: number): boolean {
  const { hour, minute } = parseTime(time);
  if (getZonedMinutesOfDay(now, timeZone) !== hour * 60 + minute) return false;
  return weekday === undefined || weekdayOf(getZonedYmd(now, timeZone)) === weekday;
}

function usersAtLocalTime(
  users: UserTimeZone[],
  now: Date,
  time: string,
  weekday?: number,
): UserTimeZone[] {
  return users.filter(({ timeZone }) => isLocalTime(now, timeZone, time, weekday));
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

// Вечерняя сводка за «сегодня» по поясу каждого пользователя — тем, у кого за день есть
// записи еды или тренировок.
export async function sendEveningSummaries(
  api: MessageSender,
  db: Db,
  now: Date,
  users: UserTimeZone[],
  comment: CommentOnPeriod,
): Promise<void> {
  for (const { userId, timeZone } of users) {
    const { start, end } = getTodayBoundsUtc(now, timeZone);
    const meals = getMealsForUserOnDate(db, userId, start, end);
    const workouts = getWorkoutsBetween(db, userId, start, end);
    if (meals.length === 0 && workouts.length === 0) continue;

    const profile = getProfileByUserId(db, userId);
    const report = buildTodayReport(meals, timeZone, profile, EVENING_SUMMARY_TITLE, workouts);

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

// Недельный отчёт за текущую неделю (пн–вс) по поясу каждого пользователя — тем, у кого
// за неделю есть записи еды или тренировок.
export async function sendWeeklyReports(
  api: MessageSender,
  db: Db,
  now: Date,
  users: UserTimeZone[],
  comment: CommentOnPeriod,
): Promise<void> {
  for (const { userId, timeZone } of users) {
    const week = getWeekBoundsUtc(now, timeZone);
    const active =
      getMealsForUserOnDate(db, userId, week.start, week.end).length > 0 ||
      getWorkoutsBetween(db, userId, week.start, week.end).length > 0;
    if (!active) continue;

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

// Напоминания о еде проверяются раз в 15 минут: все пояса сдвинуты от UTC на кратное
// 15 минутам, так что окна у всех пользователей одинаково точные.
const MEAL_REMINDER_EVERY_MIN = 15;

// Один тик планировщика: каждая рассылка — тем пользователям, у кого по их поясу
// наступило её время. Ошибка одной рассылки не мешает остальным.
export async function runScheduledTasks(
  api: MessageSender,
  db: Db,
  now: Date,
  comment: CommentOnPeriod = commentOnPeriod,
): Promise<void> {
  const users = getAllUserTimeZones(db);
  const tasks: Array<[string, () => Promise<void>]> = [
    [
      "вечерней сводки",
      () =>
        sendEveningSummaries(
          api,
          db,
          now,
          usersAtLocalTime(users, now, config.eveningSummaryTime),
          comment,
        ),
    ],
    [
      "недельного отчёта",
      () =>
        sendWeeklyReports(
          api,
          db,
          now,
          usersAtLocalTime(users, now, config.weeklyReportTime, SUNDAY),
          comment,
        ),
    ],
    [
      "напоминаний о весе",
      () =>
        sendWeightReminders(api, db, now, usersAtLocalTime(users, now, config.weightReminderTime)),
    ],
  ];
  if (config.mealRemindersEnabled && now.getUTCMinutes() % MEAL_REMINDER_EVERY_MIN === 0) {
    tasks.push(["напоминаний о еде", () => sendMealReminders(api, db, now, users)]);
  }

  for (const [label, task] of tasks) {
    try {
      await task();
    } catch (err) {
      console.error(`Ошибка при рассылке ${label}:`, err);
    }
  }
}

export function startScheduler(api: MessageSender, db: Db): void {
  // Неверное время в .env — ошибка при запуске, а не молча пропущенные рассылки.
  for (const time of [
    config.eveningSummaryTime,
    config.weeklyReportTime,
    config.weightReminderTime,
  ]) {
    parseTime(time);
  }

  cron.schedule(
    "* * * * *",
    () => {
      runScheduledTasks(api, db, new Date()).catch((err) => {
        console.error("Ошибка планировщика:", err);
      });
    },
    { name: "scheduler-tick" },
  );
}
