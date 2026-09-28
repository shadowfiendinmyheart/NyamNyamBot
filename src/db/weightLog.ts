import { desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { updateProfileMetrics, type ProfileUpdateResult } from "./profiles.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WeightLogRow = typeof schema.weightLog.$inferSelect;

export function addWeightEntry(
  db: Db,
  userId: number,
  weightKg: number,
  loggedAt: Date = new Date(),
): void {
  db.insert(schema.weightLog).values({ userId, weightKg, loggedAt }).run();
}

// Записывает вес в журнал и пересчитывает норму в профиле. Без профиля ничего не пишет.
export function logWeight(
  db: Db,
  userId: number,
  weightKg: number,
  loggedAt: Date = new Date(),
): ProfileUpdateResult | undefined {
  // better-sqlite3 синхронный и работает через одно соединение, поэтому запросы через
  // `db` внутри колбэка выполняются в этой же транзакции.
  return db.transaction(() => {
    const result = updateProfileMetrics(db, userId, { weightKg });
    if (!result) return undefined;
    addWeightEntry(db, userId, weightKg, loggedAt);
    return result;
  });
}

export function getWeightHistory(db: Db, userId: number, limit: number): WeightLogRow[] {
  return db
    .select()
    .from(schema.weightLog)
    .where(eq(schema.weightLog.userId, userId))
    .orderBy(desc(schema.weightLog.loggedAt), desc(schema.weightLog.id))
    .limit(limit)
    .all();
}
