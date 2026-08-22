import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser } from "./users.js";
import { createMeal, deleteMealForUser } from "./meals.js";

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
