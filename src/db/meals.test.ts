import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser } from "./users.js";
import {
  createMeal,
  deleteMealForUser,
  getMealById,
  getMealsForUserOnDate,
  updateMeal,
} from "./meals.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("db/meals", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("creates a meal with summed, rounded totals and its items", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "lunch",
      source: "text",
      description: "гречка с курицей",
      items: [
        { name: "гречка", weightG: 200, kcal: 220, proteinG: 6.5, fatG: 2.1, carbG: 41.3 },
        { name: "курица", weightG: 150, kcal: 250, proteinG: 30.05, fatG: 12.05, carbG: 0 },
      ],
    });

    const meal = db.select().from(schema.meals).where(eq(schema.meals.id, mealId)).get();
    expect(meal?.kcal).toBe(470);
    expect(meal?.proteinG).toBeCloseTo(36.6, 5);
    expect(meal?.fatG).toBeCloseTo(14.2, 5);
    expect(meal?.carbG).toBeCloseTo(41.3, 5);

    const items = db
      .select()
      .from(schema.mealItems)
      .where(eq(schema.mealItems.mealId, mealId))
      .all();
    expect(items).toHaveLength(2);
  });

  it("stores the Telegram file_id of a photo meal", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "dinner",
      source: "photo",
      telegramFileId: "AgACAgIAAxkBAAIB",
      description: "паста",
      items: [{ name: "паста", weightG: 300, kcal: 450, proteinG: 15, fatG: 10, carbG: 70 }],
    });

    expect(getMealById(db, mealId, 1)?.telegramFileId).toBe("AgACAgIAAxkBAAIB");
  });

  it("deletes a meal (and its items via cascade) only for the owning user", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "snack",
      source: "text",
      description: "яблоко",
      items: [{ name: "яблоко", weightG: 150, kcal: 80, proteinG: 0.4, fatG: 0.2, carbG: 19 }],
    });

    expect(deleteMealForUser(db, mealId, 2)).toBe(false);
    expect(deleteMealForUser(db, mealId, 1)).toBe(true);

    const meal = db.select().from(schema.meals).where(eq(schema.meals.id, mealId)).get();
    expect(meal).toBeUndefined();

    const items = db
      .select()
      .from(schema.mealItems)
      .where(eq(schema.mealItems.mealId, mealId))
      .all();
    expect(items).toHaveLength(0);
  });
});

describe("db/meals getMealById", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("returns the meal for its owning user", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "snack",
      source: "text",
      description: "яблоко",
      items: [{ name: "яблоко", weightG: 150, kcal: 80, proteinG: 0.4, fatG: 0.2, carbG: 19 }],
    });

    const meal = getMealById(db, mealId, 1);
    expect(meal?.id).toBe(mealId);
  });

  it("returns undefined for a different user or a nonexistent meal", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "snack",
      source: "text",
      description: "яблоко",
      items: [{ name: "яблоко", weightG: 150, kcal: 80, proteinG: 0.4, fatG: 0.2, carbG: 19 }],
    });

    expect(getMealById(db, mealId, 2)).toBeUndefined();
    expect(getMealById(db, mealId + 1000, 1)).toBeUndefined();
  });
});

describe("db/meals updateMeal", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("recomputes totals and replaces meal_items", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "lunch",
      source: "text",
      description: "гречка",
      items: [{ name: "гречка", weightG: 200, kcal: 220, proteinG: 6.5, fatG: 2.1, carbG: 41.3 }],
    });

    const updated = updateMeal(db, mealId, 1, {
      items: [
        { name: "гречка", weightG: 300, kcal: 330, proteinG: 9.75, fatG: 3.15, carbG: 61.95 },
      ],
      rawClaudeResponse: { foodDetected: true, items: [], notes: null },
    });
    expect(updated).toBe(true);

    const meal = getMealById(db, mealId, 1);
    expect(meal?.kcal).toBe(330);
    expect(meal?.proteinG).toBeCloseTo(9.8, 5);

    const items = db
      .select()
      .from(schema.mealItems)
      .where(eq(schema.mealItems.mealId, mealId))
      .all();
    expect(items).toHaveLength(1);
    expect(items[0]?.weightG).toBe(300);
  });

  it("returns false and leaves the meal untouched for the wrong user", () => {
    const mealId = createMeal(db, {
      userId: 1,
      mealType: "lunch",
      source: "text",
      description: "гречка",
      items: [{ name: "гречка", weightG: 200, kcal: 220, proteinG: 6.5, fatG: 2.1, carbG: 41.3 }],
    });

    const updated = updateMeal(db, mealId, 2, {
      items: [{ name: "рис", weightG: 100, kcal: 130, proteinG: 2.7, fatG: 0.3, carbG: 28 }],
    });
    expect(updated).toBe(false);

    const meal = getMealById(db, mealId, 1);
    expect(meal?.kcal).toBe(220);
  });
});

function insertMeal(db: ReturnType<typeof makeDb>, userId: number, loggedAt: Date) {
  db.insert(schema.meals)
    .values({
      userId,
      loggedAt,
      mealType: "snack",
      source: "text",
      description: "тест",
      kcal: 100,
      proteinG: 1,
      fatG: 1,
      carbG: 1,
    })
    .run();
}

describe("db/meals getMealsForUserOnDate", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("returns only the given user's meals within [start, end), ordered by loggedAt", () => {
    insertMeal(db, 1, new Date("2026-08-22T23:59:59Z")); // до окна
    insertMeal(db, 1, new Date("2026-08-23T00:00:00Z")); // включительно start
    insertMeal(db, 1, new Date("2026-08-23T12:00:00Z"));
    insertMeal(db, 1, new Date("2026-08-24T00:00:00Z")); // исключительно end
    insertMeal(db, 2, new Date("2026-08-23T06:00:00Z")); // другой пользователь

    const start = new Date("2026-08-23T00:00:00Z");
    const end = new Date("2026-08-24T00:00:00Z");
    const meals = getMealsForUserOnDate(db, 1, start, end);

    expect(meals).toHaveLength(2);
    expect(meals[0]?.loggedAt).toEqual(start);
    expect(meals[1]?.loggedAt).toEqual(new Date("2026-08-23T12:00:00Z"));
  });
});
