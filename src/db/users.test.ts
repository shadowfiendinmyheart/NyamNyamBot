import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { config } from "../config.js";
import {
  createUser,
  getAllUserTimeZones,
  getUserByTelegramId,
  getUserTimeZone,
  setUserTimeZone,
} from "./users.js";

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

  it("falls back to DEFAULT_TIMEZONE until the user picks a time zone", () => {
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    setUserTimeZone(db, 2, "Asia/Yekaterinburg");

    expect(getUserTimeZone(db, 1)).toBe(config.defaultTimezone);
    expect(getUserTimeZone(db, 2)).toBe("Asia/Yekaterinburg");
    expect(getUserTimeZone(db, 999)).toBe(config.defaultTimezone);
    expect(getAllUserTimeZones(db)).toEqual([
      { userId: 1, timeZone: config.defaultTimezone },
      { userId: 2, timeZone: "Asia/Yekaterinburg" },
    ]);
  });
});
