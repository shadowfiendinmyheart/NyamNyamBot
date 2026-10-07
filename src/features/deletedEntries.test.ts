import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal, getMealById, getMealItemsForMeals } from "../db/meals.js";
import { createUser } from "../db/users.js";
import { createWorkout, getWorkoutById } from "../db/workouts.js";
import {
  DeletedEntryStore,
  deleteMealWithUndo,
  deleteWorkoutWithUndo,
  entryId,
  isEntryInDiary,
  restoreDeletedEntry,
} from "./deletedEntries.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

describe("features/deletedEntries", () => {
  let db: ReturnType<typeof makeDb>;
  let store: DeletedEntryStore;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    store = new DeletedEntryStore();
  });

  const addMeal = () =>
    createMeal(db, {
      userId: 1,
      mealType: "lunch",
      source: "photo",
      telegramFileId: "AgAC",
      description: "суп",
      items: [
        { name: "суп", weightG: 300, kcal: 150, proteinG: 5, fatG: 4, carbG: 20 },
        { name: "хлеб", weightG: 30, kcal: 75, proteinG: 2.5, fatG: 1, carbG: 15 },
      ],
      rawClaudeResponse: { foodDetected: true, notes: "примерно", items: [] },
      loggedAt: new Date("2026-10-07T10:00:00Z"),
    });

  it("возвращает удалённую еду с тем же id, временем и составом — один раз", () => {
    const mealId = addMeal();
    const before = getMealById(db, mealId, 1);

    expect(deleteMealWithUndo(db, store, mealId, 2)).toBeUndefined();
    expect(deleteMealWithUndo(db, store, mealId, 1)?.description).toBe("суп");
    expect(getMealById(db, mealId, 1)).toBeUndefined();

    expect(restoreDeletedEntry(db, store, "meal", mealId, 2)).toBeUndefined();
    expect(restoreDeletedEntry(db, store, "meal", mealId, 1)?.kind).toBe("meal");
    expect(getMealById(db, mealId, 1)).toEqual(before);
    expect(getMealItemsForMeals(db, [mealId]).map((item) => item.name)).toEqual(["суп", "хлеб"]);

    expect(restoreDeletedEntry(db, store, "meal", mealId, 1)).toBeUndefined();
    // Второе нажатие «↩️ Вернуть» отличает уже возвращённую запись от потерянной.
    expect(isEntryInDiary(db, "meal", mealId, 1)).toBe(true);
    expect(isEntryInDiary(db, "meal", mealId, 2)).toBe(false);
  });

  it("listForUser — только свои удаления, новые первыми", () => {
    const first = addMeal();
    const second = addMeal();
    deleteMealWithUndo(db, store, first, 1);
    deleteMealWithUndo(db, store, second, 1);

    expect(store.listForUser(1).map(entryId)).toEqual([second, first]);
    expect(store.listForUser(2)).toEqual([]);
  });

  it("возвращает тренировку вместе с упражнениями", () => {
    const workout = createWorkout(db, {
      userId: 1,
      activityType: "strength",
      description: "силовая",
      durationMin: 45,
      intensity: "high",
      kcalBurned: 350,
      source: "text",
      exercises: [{ name: "подтягивания", sets: 3, reps: 10, weightKg: null, durationSec: null }],
    });

    expect(deleteWorkoutWithUndo(db, store, workout.id, 1)?.id).toBe(workout.id);
    expect(getWorkoutById(db, workout.id, 1)).toBeUndefined();

    restoreDeletedEntry(db, store, "workout", workout.id, 1);
    expect(getWorkoutById(db, workout.id, 1)).toEqual(workout);
  });

  it("хранит не больше maxSize последних удалений", () => {
    const small = new DeletedEntryStore(2);
    const ids = [addMeal(), addMeal(), addMeal()];
    for (const id of ids) deleteMealWithUndo(db, small, id, 1);

    expect(small.size).toBe(2);
    expect(restoreDeletedEntry(db, small, "meal", ids[0], 1)).toBeUndefined();
    expect(restoreDeletedEntry(db, small, "meal", ids[2], 1)).toBeDefined();
  });
});
