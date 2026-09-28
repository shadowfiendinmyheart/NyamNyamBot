import { InlineKeyboard, type Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { getMealTimesBetween, getUserIdsWithMealsBetween } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getLastReminderAt, recordReminder, type ReminderKind } from "../db/reminders.js";
import { getWeightHistory } from "../db/weightLog.js";
import {
  addDays,
  formatYmd,
  getDayBoundsUtc,
  getTodayBoundsUtc,
  getZonedMinutesOfDay,
  getZonedYmd,
} from "../utils/dates.js";

type Db = BetterSQLite3Database<typeof schema>;
type MessageSender = Pick<Api, "sendMessage">;

export type MealSlot = "lunch" | "dinner";

// Окна приёмов пищи в минутах от локальной полуночи — те же, что в determineMealType.
export const MEAL_SLOT_WINDOWS: Record<MealSlot, { from: number; to: number }> = {
  lunch: { from: 11 * 60, to: 16 * 60 },
  dinner: { from: 16 * 60, to: 22 * 60 },
};

// За сколько прошлых дней ищем привычки и сколько дней с приёмом пищи в окне нужно,
// чтобы считать время привычным.
export const HABIT_LOOKBACK_DAYS = 14;
export const MIN_HABIT_DAYS = 3;
// Напоминаем через час после привычного времени и не позже чем через 2 часа после
// этого — чтобы перезапуск бота вечером не прислал запоздалое напоминание про обед.
export const MEAL_REMINDER_DELAY_MIN = 60;
export const MEAL_REMINDER_WINDOW_MIN = 120;
export const WEIGHT_REMINDER_INTERVAL_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

const SLOT_LABEL: Record<MealSlot, string> = { lunch: "Обед", dinner: "Ужин" };

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function formatMinutes(minutes: number): string {
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
}

// Привычное время обеда/ужина (минуты от полуночи): медиана времени первого приёма
// пищи в окне слота по дням. Слот без достаточной истории в результат не попадает.
export function findHabitualMealTimes(
  mealTimes: Date[],
  timeZone: string,
): Partial<Record<MealSlot, number>> {
  const firstBySlotAndDay = new Map<MealSlot, Map<string, number>>(
    (Object.keys(MEAL_SLOT_WINDOWS) as MealSlot[]).map((slot) => [slot, new Map()]),
  );

  for (const time of mealTimes) {
    const day = formatYmd(getZonedYmd(time, timeZone));
    const minutes = getZonedMinutesOfDay(time, timeZone);
    for (const [slot, byDay] of firstBySlotAndDay) {
      const { from, to } = MEAL_SLOT_WINDOWS[slot];
      if (minutes < from || minutes >= to) continue;
      byDay.set(day, Math.min(byDay.get(day) ?? Infinity, minutes));
    }
  }

  const result: Partial<Record<MealSlot, number>> = {};
  for (const [slot, byDay] of firstBySlotAndDay) {
    if (byDay.size >= MIN_HABIT_DAYS) result[slot] = median([...byDay.values()]);
  }
  return result;
}

export function buildMealReminderMessage(slot: MealSlot, habitualMinutes: number): string {
  return (
    `🐱 Мур! ${SLOT_LABEL[slot]} у вас обычно около ${formatMinutes(habitualMinutes)}, ` +
    "а в дневнике за сегодня его пока нет. Пришлите фото, опишите текстом или голосом, " +
    "что съели, — я посчитаю КБЖУ."
  );
}

export function buildWeightReminderMessage(daysSinceLastWeight: number | undefined): string {
  const since =
    daysSinceLastWeight === undefined
      ? "Вы ещё ни разу не записывали вес в дневник."
      : `Вес не обновлялся уже ${daysSinceLastWeight} дн.`;
  return (
    `🐱 Мур! ${since} Встаньте на весы (лучше утром, натощак) и пришлите результат — ` +
    "я пересчитаю норму КБЖУ."
  );
}

function weightReminderKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("⚖️ Записать вес", "menu:weight");
}

async function sendReminder(
  api: MessageSender,
  db: Db,
  userId: number,
  kind: ReminderKind,
  now: Date,
  text: string,
  replyMarkup?: InlineKeyboard,
): Promise<void> {
  try {
    await api.sendMessage(userId, text, replyMarkup ? { reply_markup: replyMarkup } : {});
  } catch (err) {
    console.error(`Не удалось отправить напоминание (${kind}) пользователю ${userId}:`, err);
  }
  // Фиксируем даже неудачную отправку: напоминание не критично, а без этого
  // заблокировавшему бота пользователю мы бы стучались каждые 15 минут.
  recordReminder(db, userId, kind, now);
}

function groupByUser(rows: Array<{ userId: number; loggedAt: Date }>): Map<number, Date[]> {
  const byUser = new Map<number, Date[]>();
  for (const { userId, loggedAt } of rows) {
    byUser.set(userId, [...(byUser.get(userId) ?? []), loggedAt]);
  }
  return byUser;
}

// Запускается часто (раз в 15 минут): напоминает о пропущенном обеде/ужине, если
// привычное время прошло больше часа назад, а с начала окна слота ничего не записано.
export async function sendMealReminders(
  api: MessageSender,
  db: Db,
  now: Date,
  timeZone: string,
): Promise<void> {
  const todayYmd = getZonedYmd(now, timeZone);
  const today = getTodayBoundsUtc(now, timeZone);
  const lookbackStart = getDayBoundsUtc(addDays(todayYmd, -HABIT_LOOKBACK_DAYS), timeZone).start;
  const history = groupByUser(getMealTimesBetween(db, lookbackStart, today.start));
  const todayMeals = groupByUser(getMealTimesBetween(db, today.start, today.end));
  const nowMinutes = getZonedMinutesOfDay(now, timeZone);

  for (const [userId, mealTimes] of history) {
    const habits = findHabitualMealTimes(mealTimes, timeZone);

    for (const [slot, habitual] of Object.entries(habits) as Array<[MealSlot, number]>) {
      const due = habitual + MEAL_REMINDER_DELAY_MIN;
      if (nowMinutes < due || nowMinutes >= due + MEAL_REMINDER_WINDOW_MIN) continue;

      const slotStart = MEAL_SLOT_WINDOWS[slot].from;
      const loggedSinceSlotStart = (todayMeals.get(userId) ?? []).some(
        (time) => getZonedMinutesOfDay(time, timeZone) >= slotStart,
      );
      if (loggedSinceSlotStart) continue;

      const lastReminder = getLastReminderAt(db, userId, slot);
      if (lastReminder && lastReminder >= today.start) continue;

      await sendReminder(api, db, userId, slot, now, buildMealReminderMessage(slot, habitual));
    }
  }
}

// Раз в день: напоминает записать вес, если он не обновлялся неделю и больше. Только
// пользователям с профилем (без него вес не записать) и с записями еды за последние
// HABIT_LOOKBACK_DAYS дней — забросивших бота не тревожим. Не чаще раза в неделю.
export async function sendWeightReminders(
  api: MessageSender,
  db: Db,
  now: Date,
  timeZone: string,
): Promise<void> {
  const todayYmd = getZonedYmd(now, timeZone);
  const lookbackStart = getDayBoundsUtc(addDays(todayYmd, -HABIT_LOOKBACK_DAYS), timeZone).start;
  const intervalMs = WEIGHT_REMINDER_INTERVAL_DAYS * DAY_MS;

  for (const userId of getUserIdsWithMealsBetween(db, lookbackStart, now)) {
    if (!getProfileByUserId(db, userId)) continue;

    const lastWeight = getWeightHistory(db, userId, 1)[0];
    if (lastWeight && now.getTime() - lastWeight.loggedAt.getTime() < intervalMs) continue;

    // Запас в час: задача запускается в одно и то же время, и небольшой дрейф запуска
    // не должен откладывать напоминание ещё на сутки.
    const lastReminder = getLastReminderAt(db, userId, "weight");
    if (lastReminder && now.getTime() - lastReminder.getTime() < intervalMs - DAY_MS / 24) {
      continue;
    }

    const days = lastWeight
      ? Math.floor((now.getTime() - lastWeight.loggedAt.getTime()) / DAY_MS)
      : undefined;
    await sendReminder(
      api,
      db,
      userId,
      "weight",
      now,
      buildWeightReminderMessage(days),
      weightReminderKeyboard(),
    );
  }
}
