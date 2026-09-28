import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal } from "../db/meals.js";
import { createUser } from "../db/users.js";
import { addWeightEntry } from "../db/weightLog.js";
import {
  sendEveningSummaries,
  sendWeeklyReports,
  timeToDailyCron,
  timeToSundayCron,
} from "./scheduler.js";

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

  const comment = vi.fn();

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    createUser(db, 3, "carol");
    comment.mockReset().mockResolvedValue("Отличный день, мур!");
  });

  it("шлёт сводку только пользователям с записями за текущий день", async () => {
    addMeal(db, 1, new Date("2026-08-23T15:00:00Z"));
    addMeal(db, 2, new Date("2026-08-22T15:00:00Z")); // вчера — не в счёт
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow", comment);

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

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow", comment);

    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual([1, 3]);
    consoleError.mockRestore();
  });

  it("добавляет комментарий Ням-Ням с данными дня и кнопку «Обсудить»", async () => {
    addMeal(db, 1, new Date("2026-08-23T15:00:00Z"));
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow", comment);

    expect(comment).toHaveBeenCalledTimes(1);
    const input = comment.mock.calls[0][0];
    expect(input.kind).toBe("day");
    expect(input.summaries).toHaveLength(1);
    expect(input.summaries[0].date).toBe("2026-08-23");
    expect(input.summaries[0].totals.kcal).toBe(220);
    expect(sendMessage.mock.calls[0][1]).toContain("🐱 Ням-Ням: Отличный день, мур!");
    expect(JSON.stringify(sendMessage.mock.calls[0][2])).toContain("coach:discuss");
  });

  it("при ошибке ИИ отправляет сводку без комментария", async () => {
    addMeal(db, 1, new Date("2026-08-23T15:00:00Z"));
    comment.mockRejectedValue(new Error("перегружен"));
    const sendMessage = vi.fn().mockResolvedValue({});
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await sendEveningSummaries({ sendMessage } as never, db, now, "Europe/Moscow", comment);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][1]).toContain("Итого: 220 ккал");
    expect(sendMessage.mock.calls[0][1]).not.toContain("Ням-Ням");
    consoleError.mockRestore();
  });
});

describe("cron/scheduler sendWeeklyReports", () => {
  let db: ReturnType<typeof makeDb>;
  // Воскресенье 2026-08-23, 21:00 в Москве; неделя — 17–23 августа.
  const now = new Date("2026-08-23T18:00:00Z");
  const comment = vi.fn();

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    comment.mockReset().mockResolvedValue("Хорошая неделя!");
  });

  it("шлёт отчёт только пользователям с записями за неделю, с весом и комментарием", async () => {
    addMeal(db, 1, new Date("2026-08-17T09:00:00Z")); // понедельник
    addMeal(db, 1, new Date("2026-08-20T09:00:00Z"));
    addMeal(db, 2, new Date("2026-08-16T09:00:00Z")); // прошлая неделя
    addWeightEntry(db, 1, 80, new Date("2026-08-17T06:00:00Z"));
    addWeightEntry(db, 1, 79.4, new Date("2026-08-23T06:00:00Z"));
    const sendMessage = vi.fn().mockResolvedValue({});

    await sendWeeklyReports({ sendMessage } as never, db, now, "Europe/Moscow", comment);

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage.mock.calls[0][0]).toBe(1);
    const text: string = sendMessage.mock.calls[0][1];
    expect(text).toContain("📊 Неделя 17.08–23.08");
    expect(text).toContain("Дней с записями: 2 из 7");
    expect(text).toContain("⚖️ Вес: 80 → 79.4 кг (−0.6 кг)");
    expect(text).toContain("🐱 Ням-Ням: Хорошая неделя!");

    const input = comment.mock.calls[0][0];
    expect(input.kind).toBe("week");
    expect(input.summaries.map((d: { date: string }) => d.date)).toEqual([
      "2026-08-17",
      "2026-08-18",
      "2026-08-19",
      "2026-08-20",
      "2026-08-21",
      "2026-08-22",
      "2026-08-23",
    ]);
  });
});
