import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { config } from "../config.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export function getUserByTelegramId(db: Db, telegramId: number) {
  return db.select().from(schema.users).where(eq(schema.users.id, telegramId)).get();
}

export function createUser(db: Db, telegramId: number, username: string | undefined) {
  db.insert(schema.users).values({ id: telegramId, username: username ?? null }).run();
}

// Пояс пользователя; не выбран (или пользователя нет) — DEFAULT_TIMEZONE.
export function getUserTimeZone(db: Db, userId: number): string {
  const row = db
    .select({ timezone: schema.users.timezone })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .get();
  return row?.timezone ?? config.defaultTimezone;
}

export function setUserTimeZone(db: Db, userId: number, timeZone: string): void {
  db.update(schema.users).set({ timezone: timeZone }).where(eq(schema.users.id, userId)).run();
}

export interface UserTimeZone {
  userId: number;
  timeZone: string;
}


export interface NotificationSettings {
  // «HH:MM» по поясу пользователя.
  eveningSummaryTime: string;
  eveningSummaryEnabled: boolean;
  weeklyReportEnabled: boolean;
  remindersEnabled: boolean;
}

export type NotificationSettingsChanges = Partial<NotificationSettings>;

export interface UserSchedule extends UserTimeZone, NotificationSettings {}

const SUMMARY_TIME_PATTERN = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// «9:05» → «09:05»; не время — undefined.
export function normalizeSummaryTime(time: string): string | undefined {
  const match = SUMMARY_TIME_PATTERN.exec(time.trim());
  return match ? `${match[1].padStart(2, "0")}:${match[2]}` : undefined;
}

type SettingsRow = Pick<
  typeof schema.users.$inferSelect,
  "eveningSummaryTime" | "eveningSummaryEnabled" | "weeklyReportEnabled" | "remindersEnabled"
>;

function toSettings(row: SettingsRow | undefined): NotificationSettings {
  return {
    eveningSummaryTime:
      normalizeSummaryTime(row?.eveningSummaryTime ?? "") ?? config.eveningSummaryTime,
    eveningSummaryEnabled: row?.eveningSummaryEnabled ?? true,
    weeklyReportEnabled: row?.weeklyReportEnabled ?? true,
    remindersEnabled: row?.remindersEnabled ?? true,
  };
}

const settingsColumns = {
  eveningSummaryTime: schema.users.eveningSummaryTime,
  eveningSummaryEnabled: schema.users.eveningSummaryEnabled,
  weeklyReportEnabled: schema.users.weeklyReportEnabled,
  remindersEnabled: schema.users.remindersEnabled,
};

// Настройки уведомлений; время сводки не выбрано — EVENING_SUMMARY_TIME.
export function getNotificationSettings(db: Db, userId: number): NotificationSettings {
  return toSettings(
    db.select(settingsColumns).from(schema.users).where(eq(schema.users.id, userId)).get(),
  );
}

export function updateNotificationSettings(
  db: Db,
  userId: number,
  changes: NotificationSettingsChanges,
): void {
  const { eveningSummaryTime, ...flags } = changes;
  const values: Partial<typeof schema.users.$inferInsert> = { ...flags };
  if (eveningSummaryTime !== undefined) {
    const normalized = normalizeSummaryTime(eveningSummaryTime);
    if (!normalized) throw new Error(`Некорректное время сводки "${eveningSummaryTime}"`);
    values.eveningSummaryTime = normalized;
  }
  if (Object.keys(values).length === 0) return;
  db.update(schema.users).set(values).where(eq(schema.users.id, userId)).run();
}

// Все пользователи с поясами и настройками уведомлений — для рассылок планировщика.
export function getAllUserSchedules(db: Db): UserSchedule[] {
  return db
    .select({ userId: schema.users.id, timezone: schema.users.timezone, ...settingsColumns })
    .from(schema.users)
    .orderBy(schema.users.id)
    .all()
    .map(({ userId, timezone, ...settings }) => ({
      userId,
      timeZone: timezone ?? config.defaultTimezone,
      ...toSettings(settings),
    }));
}
