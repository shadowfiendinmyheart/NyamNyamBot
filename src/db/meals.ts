import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";
export type MealSource = "photo" | "text";

export interface MealItemInput {
  name: string;
  weightG: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export interface CreateMealInput {
  userId: number;
  mealType: MealType;
  source: MealSource;
  description: string;
  photoPath?: string | null;
  items: MealItemInput[];
  rawClaudeResponse?: unknown;
}

export interface NutritionTotals {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export function sumNutrition(
  items: Array<{ kcal: number; proteinG: number; fatG: number; carbG: number }>,
): NutritionTotals {
  const totals = items.reduce(
    (acc, item) => ({
      kcal: acc.kcal + item.kcal,
      proteinG: acc.proteinG + item.proteinG,
      fatG: acc.fatG + item.fatG,
      carbG: acc.carbG + item.carbG,
    }),
    { kcal: 0, proteinG: 0, fatG: 0, carbG: 0 },
  );

  return {
    kcal: Math.round(totals.kcal),
    proteinG: roundToOneDecimal(totals.proteinG),
    fatG: roundToOneDecimal(totals.fatG),
    carbG: roundToOneDecimal(totals.carbG),
  };
}

export function createMeal(db: Db, input: CreateMealInput): number {
  const totals = sumNutrition(input.items);

  return db.transaction((tx) => {
    const meal = tx
      .insert(schema.meals)
      .values({
        userId: input.userId,
        mealType: input.mealType,
        source: input.source,
        photoPath: input.photoPath ?? null,
        description: input.description,
        kcal: totals.kcal,
        proteinG: totals.proteinG,
        fatG: totals.fatG,
        carbG: totals.carbG,
        rawClaudeResponse: input.rawClaudeResponse ?? null,
      })
      .returning({ id: schema.meals.id })
      .get();

    if (input.items.length > 0) {
      tx.insert(schema.mealItems)
        .values(
          input.items.map((item) => ({
            mealId: meal.id,
            name: item.name,
            weightG: item.weightG,
            kcal: item.kcal,
            proteinG: item.proteinG,
            fatG: item.fatG,
            carbG: item.carbG,
          })),
        )
        .run();
    }

    return meal.id;
  });
}

export function deleteMealForUser(db: Db, mealId: number, userId: number): boolean {
  const result = db
    .delete(schema.meals)
    .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
    .run();
  return result.changes > 0;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
