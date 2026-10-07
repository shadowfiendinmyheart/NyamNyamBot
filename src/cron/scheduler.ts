import cron from "node-cron";
import type { Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import { commentOnPeriod, type CommentOnPeriod, type PeriodKind } from "../ai/coach.js";
import { getMealsForUserOnDate } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getLastReminderAt, recordReminder } from "../db/reminders.js";
import { getWeightEntriesBetween } from "../db/weightLog.js";
import { getAllUserSchedules, type UserSchedule, type UserTimeZone } from "../db/users.js";
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
import { isValidTimeZone } from "../utils/timezones.js";

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
// день недели (0 — воскресенье).
export function isLocalTime(now: Date, timeZone: string, time: string, weekday?: number): boolean {
  const { hour, minute } = parseTime(time);
  if (getZonedMinutesOfDay(now, timeZone) !== hour * 60 + minute) return false;
  return weekday === undefined || weekdayOf(getZonedYmd(now, timeZone)) === weekday;
}

const MINUTE_MS = 60 * 1000;
// Сколько пропущенных минут догоняет тик (если предыдущие опоздали или не сработали).
const MAX_CATCH_UP_MIN = 15;

function floorToMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / MINUTE_MS) * MINUTE_MS);
}

// Начала минут в полуинтервале (since, now], не больше MAX_CATCH_UP_MIN последних.
export function minutesSince(since: Date, now: Date): Date[] {
  const last = floorToMinute(now).getTime();
  const first = Math.max(
    floorToMinute(since).getTime() + MINUTE_MS,
    last - (MAX_CATCH_UP_MIN - 1) * MINUTE_MS,
  );
  const minutes: Date[] = [];
  for (let t = first; t <= last; t += MINUTE_MS) minutes.push(new Date(t));
  return minutes;
}

// Пользователи, у которых в одну из минут тика по их поясу наступило time (общее или
// своё у каждого — например, время вечерней сводки из «🔔 Уведомления»).
function usersDueAt(
  users: UserSchedule[],
  minutes: Date[],
  time: string | ((user: UserSchedule) => string),
  weekday?: number,
): UserSchedule[] {
  return users.filter((user) => {
    const userTime = typeof time === "string" ? time : time(user);
    return minutes.some((minute) => isLocalTime(minute, user.timeZone, userTime, weekday));
  });
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

async function sendReport(
  api: MessageSender,
  userId: number,
  text: string,
  kind: PeriodKind,
): Promise<boolean> {
  try {
    await api.sendMessage(userId, text, { reply_markup: coachDiscussKeyboard() });
    return true;
  } catch (err) {
    // Например, пользователь заблокировал бота — остальным отчёт всё равно шлём.
    const label = kind === "day" ? "вечернюю сводку" : "недельный отчёт";
    console.error(`Не удалось отправить ${label} пользователю ${userId}:`, err);
    return false;
  }
}

// Вечерняя сводка за «сегодня» по поясу каждого пользователя — тем, у кого за день есть
// записи еды или тренировок. Не больше одной за день: время сводки можно поменять в
// «🔔 Уведомления» уже после того, как сегодняшняя ушла.
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
    const lastSummary = getLastReminderAt(db, userId, "summary");
    if (lastSummary && lastSummary >= start) continue;

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
    if (await sendReport(api, userId, text, "day")) recordReminder(db, userId, "summary", now);
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

// Один тик планировщика: каждая рассылка — тем пользователям, у кого по их поясу её время
// попало в минуты (previousTick, now]. Обычно это одна минута, но опоздавший или
// пропущенный тик догоняется. Ошибка одной рассылки не мешает остальным.
export async function runScheduledTasks(
  api: MessageSender,
  db: Db,
  now: Date,
  previousTick: Date = new Date(now.getTime() - MINUTE_MS),
  comment: CommentOnPeriod = commentOnPeriod,
): Promise<void> {
  const minutes = minutesSince(previousTick, now);
  if (minutes.length === 0) return;
  const users = getAllUserSchedules(db);
  // Кто выключил сводку, отчёт или напоминания в «🔔 Уведомления» — тем их не шлём.
  const withSummary = users.filter((user) => user.eveningSummaryEnabled);
  const withWeekly = users.filter((user) => user.weeklyReportEnabled);
  const withReminders = users.filter((user) => user.remindersEnabled);
  const tasks: Array<[string, () => Promise<void>]> = [
    [
      "вечерней сводки",
      () =>
        sendEveningSummaries(
          api,
          db,
          now,
          usersDueAt(withSummary, minutes, (user) => user.eveningSummaryTime),
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
          usersDueAt(withWeekly, minutes, config.weeklyReportTime, SUNDAY),
          comment,
        ),
    ],
    [
      "напоминаний о весе",
      () =>
        sendWeightReminders(
          api,
          db,
          now,
          usersDueAt(withReminders, minutes, config.weightReminderTime),
        ),
    ],
  ];
  const mealRemindersDue = minutes.some(
    (minute) => minute.getUTCMinutes() % MEAL_REMINDER_EVERY_MIN === 0,
  );
  if (config.mealRemindersEnabled && mealRemindersDue) {
    tasks.push(["напоминаний о еде", () => sendMealReminders(api, db, now, withReminders)]);
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
  // Неверные время или пояс в .env — ошибка при запуске, а не молча пропущенные рассылки.
  if (!isValidTimeZone(config.defaultTimezone)) {
    throw new Error(`Некорректный DEFAULT_TIMEZONE "${config.defaultTimezone}"`);
  }
  for (const time of [
    config.eveningSummaryTime,
    config.weeklyReportTime,
    config.weightReminderTime,
  ]) {
    parseTime(time);
  }

  let previousTick = new Date();
  cron.schedule(
    "* * * * *",
    () => {
      const now = new Date();
      runScheduledTasks(api, db, now, previousTick).catch((err) => {
        console.error("Ошибка планировщика:", err);
      });
      previousTick = now;
    },
    { name: "scheduler-tick" },
  );
}
