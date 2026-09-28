import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type ReminderKind = "lunch" | "dinner" | "weight";

export function recordReminder(db: Db, userId: number, kind: ReminderKind, sentAt: Date): void {
  db.insert(schema.reminders).values({ userId, kind, sentAt }).run();
}

export function getLastReminderAt(db: Db, userId: number, kind: ReminderKind): Date | undefined {
  return db
    .select({ sentAt: schema.reminders.sentAt })
    .from(schema.reminders)
    .where(and(eq(schema.reminders.userId, userId), eq(schema.reminders.kind, kind)))
    .orderBy(desc(schema.reminders.sentAt))
    .limit(1)
    .get()?.sentAt;
}
