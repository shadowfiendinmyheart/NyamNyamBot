import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../../db/schema.js";
import { createMeal } from "../../db/meals.js";
import { upsertProfile } from "../../db/profiles.js";
import { createUser } from "../../db/users.js";
import { addWeightEntry } from "../../db/weightLog.js";
import { calculateDailyTargets, type ProfileInput } from "../../nutrition/calculations.js";
import { createCoachDataSource } from "./dataSource.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

type Db = ReturnType<typeof makeDb>;

function addMeal(db: Db, userId: number, loggedAt: Date, description = "гречка") {
  const mealId = createMeal(db, {
    userId,
    mealType: "lunch",
    source: "text",
    description,
    items: [
      { name: "гречка", weightG: 200, kcal: 220, proteinG: 6.5, fatG: 2.1, carbG: 41.3 },
      { name: "курица", weightG: 150, kcal: 250, proteinG: 30, fatG: 12, carbG: 0 },
    ],
  });
  db.update(schema.meals).set({ loggedAt }).where(eq(schema.meals.id, mealId)).run();
}

const profile: ProfileInput = {
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "sedentary",
  goal: "lose",
};

describe("features/coach createCoachDataSource", () => {
  let db: Db;
  // 2026-08-23 12:00 в Москве, воскресенье
  const now = new Date("2026-08-23T09:00:00Z");
  const source = () => createCoachDataSource(db, 1, "Europe/Moscow", () => now);

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("снимок содержит профиль с BMR/TDEE, итоги сегодня и вес", () => {
    upsertProfile(db, 1, { ...profile, ...calculateDailyTargets(profile) });
    addMeal(db, 1, new Date("2026-08-23T08:00:00Z"));
    addMeal(db, 1, new Date("2026-08-22T08:00:00Z")); // вчера — не в «сегодня»
    addMeal(db, 2, new Date("2026-08-23T08:00:00Z")); // чужая запись
    addWeightEntry(db, 1, 80, new Date("2026-08-20T06:00:00Z"));

    const snapshot = source().getSnapshot();

    expect(snapshot.now).toContain("2026-08-23");
    expect(snapshot.profile).toMatchObject({ bmrKcal: 1780, tdeeKcal: 2136, goal: "lose" });
    expect(snapshot.today.date).toBe("2026-08-23");
    expect(snapshot.today.totals.kcal).toBe(470);
    expect(snapshot.today.meals).toHaveLength(1);
    expect(snapshot.today.meals[0].time).toBe("11:00");
    expect(snapshot.recentWeights).toEqual([{ date: "2026-08-20", weightKg: 80 }]);
  });

  it("без анкеты profile = null", () => {
    expect(source().getSnapshot().profile).toBeNull();
  });

  it("сводки по дням учитывают таймзону и включают пустые дни", () => {
    // 2026-08-21T22:30Z — это уже 22 августа, 01:30 по Москве
    addMeal(db, 1, new Date("2026-08-21T22:30:00Z"));
    addMeal(db, 1, new Date("2026-08-20T10:00:00Z"));

    const days = source().getDailySummaries("2026-08-20", "2026-08-22");

    expect(days.map((d) => [d.date, d.meals.length])).toEqual([
      ["2026-08-20", 1],
      ["2026-08-21", 0],
      ["2026-08-22", 1],
    ]);
    expect(days[1].totals.kcal).toBe(0);
  });

  it("отклоняет некорректные даты и слишком длинный период", () => {
    expect(() => source().getDailySummaries("20.08.2026", "2026-08-22")).toThrow(/YYYY-MM-DD/);
    expect(() => source().getDailySummaries("2026-08-22", "2026-08-20")).toThrow(/не позже/);
    expect(() => source().getDailySummaries("2026-07-01", "2026-08-22")).toThrow(/31/);
  });

  it("возвращает состав приёмов пищи за день", () => {
    addMeal(db, 1, new Date("2026-08-23T08:00:00Z"), "обед");

    const day = source().getMealItems("2026-08-23");

    expect(day.meals).toHaveLength(1);
    expect(day.meals[0].description).toBe("обед");
    expect(day.meals[0].items.map((i) => i.name)).toEqual(["гречка", "курица"]);
  });

  it("ограничивает limit истории веса", () => {
    for (let i = 0; i < 60; i++) {
      addWeightEntry(db, 1, 80 - i / 10, new Date(Date.UTC(2026, 5, 1 + i)));
    }
    expect(source().getWeightHistory(1000)).toHaveLength(50);
    expect(source().getWeightHistory(0)).toHaveLength(1);
    expect(source().getWeightHistory(3)[0].weightKg).toBe(74.1);
  });
});
