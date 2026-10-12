import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "../db/schema.js";
import { createMeal, getMealById, getMealItemsForMeals, updateMeal } from "../db/meals.js";
import { createUser } from "../db/users.js";
import type { AnalyzeFoodResult } from "../ai/foodAnalyzer.js";
import {
  applyMealCorrection,
  buildCorrectionHeader,
  correctionCardKeyboard,
  CorrectionUndoStore,
  undoMealCorrection,
} from "./mealCorrection.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

const corrected: AnalyzeFoodResult = {
  foodDetected: true,
  notes: null,
  items: [
    { name: "пельмени", estimatedWeightG: 200, kcal: 500, proteinG: 20, fatG: 25, carbG: 50 },
  ],
};

describe("features/mealCorrection", () => {
  let db: ReturnType<typeof makeDb>;
  let store: CorrectionUndoStore;
  let mealId: number;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
    store = new CorrectionUndoStore();
    mealId = createMeal(db, {
      userId: 1,
      mealType: "dinner",
      source: "text",
      description: "пельмени",
      items: [{ name: "пельмени", weightG: 100, kcal: 250, proteinG: 10, fatG: 12.5, carbG: 25 }],
      rawClaudeResponse: { foodDetected: true, notes: "вес примерно", items: [] },
      loggedAt: new Date("2026-10-11T17:00:00Z"),
    });
  });

  it("сохраняет новый состав и показывает, как изменились калории", () => {
    const applied = applyMealCorrection(db, store, {
      userId: 1,
      mealId,
      result: corrected,
      sourceMessageId: 42,
    });

    expect(applied).toBeDefined();
    expect(getMealById(db, mealId, 1)?.kcal).toBe(500);
    expect(getMealItemsForMeals(db, [mealId])).toMatchObject([{ name: "пельмени", weightG: 200 }]);
    expect(applied!.cardText.startsWith("✅ Обновила запись: было 250 ккал, стало 500\n\n")).toBe(true);
    expect(applied!.cardText).toContain(applied!.entryText);
    expect(applied!.entryText).toContain("пельмени — 200 г: 500 ккал");
  });

  it("чужую или удалённую запись не трогает", () => {
    expect(
      applyMealCorrection(db, store, { userId: 2, mealId, result: corrected, sourceMessageId: null }),
    ).toBeUndefined();
    expect(getMealById(db, mealId, 1)?.kcal).toBe(250);
    expect(store.size).toBe(0);
  });

  it("«↩️ Отменить правку» возвращает прежний состав и прежний ответ ИИ", () => {
    const applied = applyMealCorrection(db, store, {
      userId: 1,
      mealId,
      result: corrected,
      sourceMessageId: 42,
    })!;

    const result = undoMealCorrection(db, store, applied.undoId, 1);

    expect(result).toMatchObject({ outcome: "undone", mealId, sourceMessageId: 42 });
    const meal = getMealById(db, mealId, 1)!;
    expect(meal.kcal).toBe(250);
    expect(meal.rawClaudeResponse).toEqual({ foodDetected: true, notes: "вес примерно", items: [] });
    expect(getMealItemsForMeals(db, [mealId])).toMatchObject([{ weightG: 100, fatG: 12.5 }]);
    // Одноразово.
    expect(undoMealCorrection(db, store, applied.undoId, 1)).toEqual({ outcome: "unavailable" });
  });

  it("не отменяет, если запись меняли после правки, и не отдаёт отмену чужому", () => {
    const applied = applyMealCorrection(db, store, {
      userId: 1,
      mealId,
      result: corrected,
      sourceMessageId: null,
    })!;
    expect(undoMealCorrection(db, store, applied.undoId, 2)).toEqual({ outcome: "unavailable" });

    updateMeal(db, mealId, 1, {
      items: [{ name: "пельмени", weightG: 300, kcal: 750, proteinG: 30, fatG: 37.5, carbG: 75 }],
    });

    expect(undoMealCorrection(db, store, applied.undoId, 1)).toEqual({ outcome: "changed", mealId });
    expect(getMealById(db, mealId, 1)?.kcal).toBe(750);
  });

  it("заголовок без «было → стало», если калории не изменились", () => {
    expect(buildCorrectionHeader(300, 300)).toBe("✅ Обновила запись:");
  });

  it("под обновлённой записью — кнопки записи и «↩️ Отменить правку»", () => {
    const data = correctionCardKeyboard(7, 123).inline_keyboard.flat().map((b) =>
      "callback_data" in b ? b.callback_data : undefined,
    );
    expect(data).toEqual(["meal_time:7", "delete_meal:7", "coach:meal:7", "undo_fix:123"]);
  });
});
