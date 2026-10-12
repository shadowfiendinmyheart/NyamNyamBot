import { and, asc, eq, gte, inArray, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export const MEAL_TYPES = ["breakfast", "lunch", "dinner", "snack"] as const;
export type MealType = (typeof MEAL_TYPES)[number];
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
  loggedAt?: Date; // по умолчанию — сейчас
}

export interface NutritionTotals {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export type MealRow = typeof schema.meals.$inferSelect;
export type MealItemRow = typeof schema.mealItems.$inferSelect;

// Фото альбома хранятся в одной колонке telegram_file_id через запятую: в file_id
// Telegram (base64url) запятых не бывает, а отдельная таблица ради этого не нужна.
const FILE_ID_SEPARATOR = ",";

export function joinPhotoFileIds(fileIds: string[]): string | null {
  return fileIds.length > 0 ? fileIds.join(FILE_ID_SEPARATOR) : null;
}

export function mealPhotoFileIds(meal: Pick<MealRow, "telegramFileId">): string[] {
  return (meal.telegramFileId ?? "").split(FILE_ID_SEPARATOR).filter(Boolean);
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
        telegramFileId: input.telegramFileId ?? null,
        description: input.description,
        kcal: totals.kcal,
        proteinG: totals.proteinG,
        fatG: totals.fatG,
        carbG: totals.carbG,
        rawClaudeResponse: input.rawClaudeResponse ?? null,
        ...(input.loggedAt ? { loggedAt: input.loggedAt } : {}),
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

export function updateMealTime(
  db: Db,
  mealId: number,
  userId: number,
  input: { loggedAt: Date; mealType: MealType },
): boolean {
  const result = db
    .update(schema.meals)
    .set(input)
    .where(and(eq(schema.meals.id, mealId), eq(schema.meals.userId, userId)))
    .run();
  return result.changes > 0;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

// Время всех приёмов пищи всех пользователей за период — для эвристики напоминаний.
export function getMealTimesBetween(
  db: Db,
  start: Date,
  end: Date,
): Array<{ userId: number; loggedAt: Date }> {
  return db
    .select({ userId: schema.meals.userId, loggedAt: schema.meals.loggedAt })
    .from(schema.meals)
    .where(and(gte(schema.meals.loggedAt, start), lt(schema.meals.loggedAt, end)))
    .orderBy(asc(schema.meals.loggedAt))
    .all();
}

// Продукты записи из БД — во вход createMeal/updateMeal (без id и meal_id).
export function mealItemRowsToInputs(rows: MealItemRow[]): MealItemInput[] {
  return rows.map(({ name, weightG, kcal, proteinG, fatG, carbG }) => ({
    name,
    weightG,
    kcal,
    proteinG,
    fatG,
    carbG,
  }));
}

export function getMealItemsForMeals(db: Db, mealIds: number[]): MealItemRow[] {
  if (mealIds.length === 0) return [];
  return db
    .select()
    .from(schema.mealItems)
    .where(inArray(schema.mealItems.mealId, mealIds))
    .orderBy(asc(schema.mealItems.id))
    .all();
}

// Возвращает удалённую запись («↩️ Вернуть») с тем же id: кнопки под старыми сообщениями
// об этой записи снова работают. id у meals — AUTOINCREMENT, поэтому за время, пока
// запись была удалена, его не мог занять никто другой.
export function restoreMeal(db: Db, meal: MealRow, items: MealItemRow[]): void {
  db.transaction((tx) => {
    tx.insert(schema.meals).values(meal).run();
    if (items.length > 0) tx.insert(schema.mealItems).values(items).run();
  });
}

// «🔁 Повторить»: та же еда (состав, КБЖУ, описание, фото) новой записью на другое время.
// undefined — исходной записи нет или она чужая.
export function copyMeal(
  db: Db,
  mealId: number,
  userId: number,
  at: { loggedAt: Date; mealType: MealType },
): number | undefined {
  const meal = getMealById(db, mealId, userId);
  if (!meal) return undefined;
  return createMeal(db, {
    userId,
    mealType: at.mealType,
    source: meal.source,
    telegramFileId: meal.telegramFileId,
    description: meal.description,
    items: mealItemRowsToInputs(getMealItemsForMeals(db, [meal.id])),
    rawClaudeResponse: meal.rawClaudeResponse,
    loggedAt: at.loggedAt,
  });
}
