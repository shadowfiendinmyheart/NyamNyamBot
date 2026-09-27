import { and, asc, eq, gte, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type MealType = "breakfast" | "lunch" | "dinner" | "snack";
export type MealSource = "photo" | "text" | "voice";

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
  telegramFileId?: string | null;
  description: string;
  items: MealItemInput[];
  rawClaudeResponse?: unknown;
}

export interface NutritionTotals {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export type MealRow = typeof schema.meals.$inferSelect;

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
        telegramFileId: input.telegramFileId ?? null,
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

export function getMealsForUserOnDate(
  db: Db,
  userId: number,
  start: Date,
  end: Date,
): MealRow[] {
  return db
    .select()
    .from(schema.meals)
    .where(
      and(
        eq(schema.meals.userId, userId),
        gte(schema.meals.loggedAt, start),
        lt(schema.meals.loggedAt, end),
      ),
    )
    .orderBy(asc(schema.meals.loggedAt))
    .all();
}

export function deleteMealForUser(db: Db, mealId: number, userId: number): boolean {
  const result = db
    .delete(schema.meals)
    .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
    .run();
  return result.changes > 0;
}

export function getMealById(db: Db, mealId: number, userId: number): MealRow | undefined {
  return db
    .select()
    .from(schema.meals)
    .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
    .get();
}

export interface UpdateMealInput {
  items: MealItemInput[];
  rawClaudeResponse?: unknown;
}

export function updateMeal(
  db: Db,
  mealId: number,
  userId: number,
  input: UpdateMealInput,
): boolean {
  const totals = sumNutrition(input.items);

  return db.transaction((tx) => {
    const result = tx
      .update(schema.meals)
      .set({ ...totals, rawClaudeResponse: input.rawClaudeResponse ?? null })
      .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
      .run();

    if (result.changes === 0) return false;

    tx.delete(schema.mealItems).where(eq(schema.mealItems.mealId, mealId)).run();

    if (input.items.length > 0) {
      tx.insert(schema.mealItems)
        .values(
          input.items.map((item) => ({
            mealId,
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

    return true;
  });
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
