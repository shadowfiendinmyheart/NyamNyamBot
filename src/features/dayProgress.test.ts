import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal } from "../db/meals.js";
import { upsertProfile } from "../db/profiles.js";
import { createUser } from "../db/users.js";
import { createWorkout } from "../db/workouts.js";
import { buildDayProgressLine, formatDayProgress } from "./dayProgress.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("features/dayProgress formatDayProgress", () => {
  it("съедено, норма и остаток", () => {
    expect(formatDayProgress(1240, 2100)).toBe("📊 За день: 1240 / 2100 ккал, осталось 860");
  });

  it("перебор нормы", () => {
    expect(formatDayProgress(2300, 2100)).toBe(
      "📊 За день: 2300 / 2100 ккал, сверх нормы 200",
    );
  });

  it("без профиля — только съеденное; запись за вчера — подписана днём", () => {
    expect(formatDayProgress(500, undefined)).toBe("📊 За день: 500 ккал");
    expect(formatDayProgress(500, 2000, "вчера")).toBe(
      "📊 За вчера: 500 / 2000 ккал, осталось 1500",
    );
  });
});

describe("features/dayProgress buildDayProgressLine", () => {
  const timeZone = "Europe/Moscow";
  const now = new Date("2026-10-08T12:00:00Z"); // 15:00 МСК
  let db: ReturnType<typeof makeDb>;

  const item = (kcal: number) => ({
    name: "еда",
    weightG: 100,
    kcal,
    proteinG: 1,
    fatG: 1,
    carbG: 1,
  });

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createMeal(db, {
      userId: 1,
      mealType: "breakfast",
      source: "text",
      description: "каша",
      items: [item(400)],
      loggedAt: new Date("2026-10-08T05:00:00Z"),
    });
    createMeal(db, {
      userId: 1,
      mealType: "lunch",
      source: "text",
      description: "суп",
      items: [item(600)],
      loggedAt: new Date("2026-10-08T10:00:00Z"),
    });
    // Вчерашний ужин в 23:30 МСК — в сегодняшний день не попадает.
    createMeal(db, {
      userId: 1,
      mealType: "dinner",
      source: "text",
      description: "плов",
      items: [item(900)],
      loggedAt: new Date("2026-10-07T20:30:00Z"),
    });
  });

  it("без профиля — только сумма за день пользователя", () => {
    expect(buildDayProgressLine(db, 1, now, timeZone)).toBe("📊 За день: 1000 ккал");
  });

  it("норма с расходом тренировок при сидячем уровне", () => {
    upsertProfile(db, 1, {
      sex: "female",
      age: 30,
      heightCm: 165,
      weightKg: 60,
      activityLevel: "sedentary",
      goal: "maintain",
      dailyKcalTarget: 1800,
      proteinGTarget: 90,
      fatGTarget: 60,
      carbGTarget: 220,
    });
    createWorkout(db, {
      userId: 1,
      activityType: "running",
      description: "бег",
      durationMin: 30,
      intensity: "moderate",
      kcalBurned: 300,
      source: "command",
      performedAt: new Date("2026-10-08T07:00:00Z"),
    });

    expect(buildDayProgressLine(db, 1, now, timeZone)).toBe(
      "📊 За день: 1000 / 2100 ккал, осталось 1100",
    );
    expect(
      buildDayProgressLine(db, 1, new Date("2026-10-07T20:30:00Z"), timeZone, "вчера"),
    ).toBe("📊 За вчера: 900 / 1800 ккал, осталось 900");
  });
});
