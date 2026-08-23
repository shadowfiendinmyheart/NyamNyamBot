import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { ActivityLevel, Goal, NutritionTargets, Sex } from "../nutrition/calculations.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export interface UpsertProfileInput extends NutritionTargets {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
}

export type ProfileRow = typeof schema.profiles.$inferSelect;

export function upsertProfile(db: Db, userId: number, input: UpsertProfileInput): void {
  const values = {
    userId,
    sex: input.sex,
    age: input.age,
    heightCm: input.heightCm,
    weightKg: input.weightKg,
    activityLevel: input.activityLevel,
    goal: input.goal,
    dailyKcalTarget: input.dailyKcalTarget,
    proteinGTarget: input.proteinGTarget,
    fatGTarget: input.fatGTarget,
    carbGTarget: input.carbGTarget,
  };

  db.insert(schema.profiles)
    .values(values)
    .onConflictDoUpdate({ target: schema.profiles.userId, set: values })
    .run();
}

export function getProfileByUserId(db: Db, userId: number): ProfileRow | undefined {
  return db.select().from(schema.profiles).where(eq(schema.profiles.userId, userId)).get();
}

export function deleteProfile(db: Db, userId: number): boolean {
  const result = db.delete(schema.profiles).where(eq(schema.profiles.userId, userId)).run();
  return result.changes > 0;
}
