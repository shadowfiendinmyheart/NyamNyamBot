import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal } from "../db/meals.js";
import { createUser } from "../db/users.js";
import { sendEveningSummaries, timeToDailyCron } from "./scheduler.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

function addMeal(db: ReturnType<typeof makeDb>, userId: number, loggedAt: Date) {
  const mealId = createMeal(db, {
    userId,
    mealType: "dinner",
    source: "text",
    description: "гречка",
    items: [{ name: "гречка", weightG: 200, kcal: 220, proteinG: 6.5, fatG: 2.1, carbG: 41.3 }],
  });
  db.update(schema.meals).set({ loggedAt }).where(eq(schema.meals.id, mealId)).run();
}

describe("cron/scheduler timeToDailyCron", () => {
  it("переводит HH:MM в ежедневное cron-выражение", () => {
    expect(timeToDailyCron("23:30")).toBe("30 23 * * *");
    expect(timeToDailyCron("9:05")).toBe("5 9 * * *");
  });

  it("отклоняет некорректное время", () => {
    expect(() => timeToDailyCron("24:00")).toThrow();
    expect(() => timeToDailyCron("23:60")).toThrow();
    expect(() => timeToDailyCron("вечером")).toThrow();
  });
});

describe("cron/scheduler sendEveningSummaries", () => {
  let db: ReturnType<typeof makeDb>;
  // 2026-08-23T23:30 в Москве
  const now = new Date("2026-08-23T20:30:00Z");

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    createUser(db, 3, "carol");
  });

  it("шлёт сводку только пользователям с записями за текущий день", async () => {
    addMeal(db, 1, new Date("2026-08-23T15:00:00Z"));
    addMeal(db, 2, new Date("2026-08-22T15:00:00Z")); // вчера — не в счёт
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(1);
    expect(sendMessage.mock.calls[0][1]).toContain("🌙 Итоги дня");
    expect(sendMessage.mock.calls[0][1]).toContain("Итого: 220 ккал");
  });

  it("ошибка отправки одному пользователю не мешает остальным", async () => {
    addMeal(db, 1, new Date("2026-08-23T10:00:00Z"));
    addMeal(db, 3, new Date("2026-08-23T11:00:00Z"));
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error("Forbidden: bot was blocked by the user"))
      .mockResolvedValue({});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow");

    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([1, 3]);
    consoleError.mockRestore();
  });
});
