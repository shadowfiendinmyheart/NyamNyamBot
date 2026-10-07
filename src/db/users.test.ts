import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { config } from "../config.js";
import {
  createUser,
  getAllUserSchedules,
  getNotificationSettings,
  normalizeSummaryTime,
  updateNotificationSettings,
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
    expect(getAllUserSchedules(db).map(({ userId, timeZone }) => ({ userId, timeZone }))).toEqual([
      { userId: 1, timeZone: config.defaultTimezone },
      { userId: 2, timeZone: "Asia/Yekaterinburg" },
    ]);
  });

  it("returns default notification settings until the user changes them", () => {
    createUser(db, 1, "alice");

    expect(getNotificationSettings(db, 1)).toEqual({
      eveningSummaryTime: config.eveningSummaryTime,
      eveningSummaryEnabled: true,
      weeklyReportEnabled: true,
      remindersEnabled: true,
    });
  });

  it("updates notification settings and normalizes the summary time", () => {
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    updateNotificationSettings(db, 1, { eveningSummaryTime: "9:05", remindersEnabled: false });
    updateNotificationSettings(db, 1, { eveningSummaryEnabled: false });

    expect(getNotificationSettings(db, 1)).toEqual({
      eveningSummaryTime: "09:05",
      eveningSummaryEnabled: false,
      weeklyReportEnabled: true,
      remindersEnabled: false,
    });
    expect(getAllUserSchedules(db)[1]).toMatchObject({ userId: 2, remindersEnabled: true });
    expect(() => updateNotificationSettings(db, 1, { eveningSummaryTime: "25:00" })).toThrow();
  });

  it("normalizes summary time", () => {
    expect(normalizeSummaryTime("21:30")).toBe("21:30");
    expect(normalizeSummaryTime(" 7:00 ")).toBe("07:00");
    expect(normalizeSummaryTime("24:00")).toBeUndefined();
    expect(normalizeSummaryTime("вечером")).toBeUndefined();
  });
});
