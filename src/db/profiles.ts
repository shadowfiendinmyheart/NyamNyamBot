import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import {
  calculateDailyTargets,
  type ActivityLevel,
  type Goal,
  type NutritionTargets,
  type Sex,
} from "../nutrition/calculations.js";
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

export interface ProfileMetricsChanges {
  weightKg?: number;
  activityLevel?: ActivityLevel;
}

export interface ProfileUpdateResult {
  before: ProfileRow;
  after: ProfileRow;
}

// Меняет вес и/или активность и пересчитывает дневную норму по остальным полям анкеты.
export function updateProfileMetrics(
  db: Db,
  userId: number,
  changes: ProfileMetricsChanges,
): ProfileUpdateResult | undefined {
  const before = getProfileByUserId(db, userId);
  if (!before) return undefined;

  const weightKg = changes.weightKg ?? before.weightKg;
  const activityLevel = changes.activityLevel ?? before.activityLevel;
  const targets = calculateDailyTargets({
    sex: before.sex,
    age: before.age,
    heightCm: before.heightCm,
    weightKg,
    activityLevel,
    goal: before.goal,
  });

  const after: ProfileRow = { ...before, weightKg, activityLevel, ...targets };
  db.update(schema.profiles)
    .set({ weightKg, activityLevel, ...targets })
    .where(eq(schema.profiles.userId, userId))
    .run();

  return { before, after };
}
