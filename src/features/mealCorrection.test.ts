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
  withoutUndoButton,
  type AppliedCorrection,
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

  function apply(sourceMessageId: number | null = 42): AppliedCorrection {
    const applied = applyMealCorrection(db, store, {
      userId: 1,
      mealId,
      result: corrected,
      sourceMessageId,
    });
    if (!applied || applied === "unchanged") throw new Error("правка не применилась");
    return applied;
  }

  it("сохраняет новый состав и показывает, как изменились калории", () => {
    const applied = apply();

    expect(getMealById(db, mealId, 1)?.kcal).toBe(500);
    expect(getMealItemsForMeals(db, [mealId])).toMatchObject([{ name: "пельмени", weightG: 200 }]);
    expect(applied.cardText.startsWith("✅ Обновила запись: было 250 ккал, стало 500\n\n")).toBe(true);
    expect(applied.cardText).toContain(applied.entryText);
    expect(applied.entryText).toContain("пельмени — 200 г: 500 ккал");
  });

  it("продукт из базы, который правка не задела, сохраняет 📦; изменённый — теряет", () => {
    const yogurt = { name: "йогурт", weightG: 116, kcal: 73, proteinG: 10.1, fatG: 2.3, carbG: 2.9 };
    const yogurtMealId = createMeal(db, {
      userId: 1,
      mealType: "breakfast",
      source: "text",
      description: "йогурт и банан",
      items: [
        { ...yogurt, nutritionSource: "openfoodfacts" },
        { name: "банан", weightG: 120, kcal: 107, proteinG: 1.3, fatG: 0.4, carbG: 27 },
      ],
    });
    const fix = (yogurtWeightG: number, yogurtKcal: number) =>
      applyMealCorrection(db, store, {
        userId: 1,
        mealId: yogurtMealId,
        sourceMessageId: null,
        result: {
          foodDetected: true,
          notes: null,
          items: [
            { ...yogurt, estimatedWeightG: yogurtWeightG, kcal: yogurtKcal },
            { name: "банан", estimatedWeightG: 150, kcal: 134, proteinG: 1.7, fatG: 0.5, carbG: 33.8 },
          ],
        },
      });

    fix(116, 73);
    expect(getMealItemsForMeals(db, [yogurtMealId]).map((item) => item.nutritionSource)).toEqual([
      "openfoodfacts",
      null,
    ]);
    // 200 г при тех же 63 ккал на 100 г — тот же продукт.
    fix(200, 126);
    expect(getMealItemsForMeals(db, [yogurtMealId])[0].nutritionSource).toBe("openfoodfacts");
    // Другие ккал на 100 г — ИИ оценил продукт заново.
    fix(200, 180);
    expect(getMealItemsForMeals(db, [yogurtMealId])[0].nutritionSource).toBeNull();
  });

  it("чужую запись не трогает", () => {
    expect(
      applyMealCorrection(db, store, { userId: 2, mealId, result: corrected, sourceMessageId: null }),
    ).toBeUndefined();
    expect(getMealById(db, mealId, 1)?.kcal).toBe(250);
    expect(store.size).toBe(0);
  });

  it("тот же состав — «unchanged»: без записи, карточки и отмены", () => {
    apply();
    const sizeAfterFirst = store.size;

    expect(
      applyMealCorrection(db, store, { userId: 1, mealId, result: corrected, sourceMessageId: null }),
    ).toBe("unchanged");
    expect(store.size).toBe(sizeAfterFirst);
  });

  it("«↩️ Отменить правку» возвращает прежний состав и прежний ответ ИИ", () => {
    const applied = apply();

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
    const applied = apply(null);
    expect(undoMealCorrection(db, store, applied.undoId, 2)).toEqual({ outcome: "unavailable" });

    updateMeal(db, mealId, 1, {
      items: [{ name: "пельмени", weightG: 300, kcal: 750, proteinG: 30, fatG: 37.5, carbG: 75 }],
    });

    expect(undoMealCorrection(db, store, applied.undoId, 1)).toEqual({ outcome: "changed" });
    expect(getMealById(db, mealId, 1)?.kcal).toBe(750);
  });

  it("заголовок без «было → стало», если калории не изменились", () => {
    expect(buildCorrectionHeader(300, 300)).toBe("✅ Обновила запись:");
  });

  it("под обновлённой записью — кнопки записи и «↩️ Отменить правку», её можно убрать", () => {
    const keyboard = correctionCardKeyboard(7, 123);
    const data = (markup: { inline_keyboard: Array<Array<object>> }) =>
      markup.inline_keyboard.flat().map((b) => ("callback_data" in b ? b.callback_data : undefined));

    expect(data(keyboard)).toEqual(["meal_time:7", "delete_meal:7", "coach:meal:7", "undo_fix:123"]);
    const stripped = withoutUndoButton(keyboard);
    expect(data(stripped)).toEqual(["meal_time:7", "delete_meal:7", "coach:meal:7"]);
    expect(stripped.inline_keyboard).toHaveLength(2);
  });
});
