import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser, getUserByTelegramId } from "./users.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("db/users", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
  });

  it("returns undefined for an unknown telegram id", () => {
    expect(getUserByTelegramId(db, 123)).toBeUndefined();
  });

  it("creates a user and finds it afterwards", () => {
    createUser(db, 123, "alice");

    const user = getUserByTelegramId(db, 123);
    expect(user?.id).toBe(123);
    expect(user?.username).toBe("alice");
  });

  it("stores a null username when telegram doesn't provide one", () => {
    createUser(db, 456, undefined);

    const user = getUserByTelegramId(db, 456);
    expect(user?.username).toBeNull();
  });
});
