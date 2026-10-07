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

// Все пользователи с их поясами — для рассылок по локальному времени.
export function getAllUserTimeZones(db: Db): UserTimeZone[] {
  return db
    .select({ userId: schema.users.id, timezone: schema.users.timezone })
    .from(schema.users)
    .orderBy(schema.users.id)
    .all()
    .map(({ userId, timezone }) => ({ userId, timeZone: timezone ?? config.defaultTimezone }));
}
