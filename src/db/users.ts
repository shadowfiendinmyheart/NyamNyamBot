import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export function getUserByTelegramId(db: Db, telegramId: number) {
  return db.select().from(schema.users).where(eq(schema.users.id, telegramId)).get();
}

export function createUser(db: Db, telegramId: number, username: string | undefined) {
  db.insert(schema.users).values({ id: telegramId, username: username ?? null }).run();
}
