import { and, asc, desc, eq, gte, inArray, like, lt } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { WorkoutActivityType, WorkoutIntensity } from "../nutrition/calculations.js";
import * as schema from "./schema.js";

type Db = BetterSQLite3Database<typeof schema>;

export type WorkoutSource = "command" | "text" | "voice";
export type WorkoutRow = typeof schema.workouts.$inferSelect;
export type WorkoutExerciseRow = typeof schema.workoutExercises.$inferSelect;
export type WorkoutEntry = WorkoutRow & { exercises: WorkoutExerciseRow[] };

export interface ExerciseInput {
  name: string;
  sets: number | null;
  reps: number | null;
  weightKg: number | null;
  durationSec: number | null;
}

export interface CreateWorkoutInput {
  userId: number;
  activityType: WorkoutActivityType;
  description: string;
  durationMin: number;
  intensity: WorkoutIntensity;
  kcalBurned: number;
  source: WorkoutSource;
  rawText?: string | null;
  performedAt?: Date;
  exercises?: ExerciseInput[];
}

export function createWorkout(db: Db, input: CreateWorkoutInput): WorkoutEntry {
  return db.transaction((tx) => {
    const workout = tx
      .insert(schema.workouts)
      .values({
        userId: input.userId,
        activityType: input.activityType,
        description: input.description,
        durationMin: input.durationMin,
        intensity: input.intensity,
        kcalBurned: input.kcalBurned,
        source: input.source,
        rawText: input.rawText ?? null,
        performedAt: input.performedAt ?? new Date(),
      })
      .returning()
      .get();

    const exercises =
      input.exercises && input.exercises.length > 0
        ? tx
            .insert(schema.workoutExercises)
            .values(
              input.exercises.map((exercise) => ({
                ...exercise,
                workoutId: workout.id,
                name: exercise.name.trim().toLowerCase(),
              })),
            )
            .returning()
            .all()
        : [];

    return { ...workout, exercises };
  });
}

function withExercises(db: Db, workouts: WorkoutRow[]): WorkoutEntry[] {
  if (workouts.length === 0) return [];
  const exercises = db
    .select()
    .from(schema.workoutExercises)
    .where(
      inArray(
        schema.workoutExercises.workoutId,
        workouts.map((workout) => workout.id),
      ),
    )
    .orderBy(asc(schema.workoutExercises.id))
    .all();
  return workouts.map((workout) => ({
    ...workout,
    exercises: exercises.filter((exercise) => exercise.workoutId === workout.id),
  }));
}

export function getWorkoutsBetween(
  db: Db,
  userId: number,
  start: Date,
  end: Date,
): WorkoutEntry[] {
  const workouts = db
    .select()
    .from(schema.workouts)
    .where(
      and(
        eq(schema.workouts.userId, userId),
        gte(schema.workouts.performedAt, start),
        lt(schema.workouts.performedAt, end),
      ),
    )
    .orderBy(asc(schema.workouts.performedAt), asc(schema.workouts.id))
    .all();
  return withExercises(db, workouts);
}

// Последние подходы упражнения, в названии которого есть `query` (без учёта регистра):
// «подтяг» найдёт и «подтягивания», и «подтягивания с весом». Новые первыми.
export function getExerciseHistory(
  db: Db,
  userId: number,
  query: string,
  limit: number,
): Array<WorkoutExerciseRow & { performedAt: Date }> {
  const pattern = `%${query.trim().toLowerCase().replace(/[%_]/g, "")}%`;
  return db
    .select({
      exercise: schema.workoutExercises,
      performedAt: schema.workouts.performedAt,
    })
    .from(schema.workoutExercises)
    .innerJoin(schema.workouts, eq(schema.workouts.id, schema.workoutExercises.workoutId))
    .where(and(eq(schema.workouts.userId, userId), like(schema.workoutExercises.name, pattern)))
    .orderBy(desc(schema.workouts.performedAt), asc(schema.workoutExercises.id))
    .limit(limit)
    .all()
    .map((row) => ({ ...row.exercise, performedAt: row.performedAt }));
}

export function getUserIdsWithWorkoutsBetween(db: Db, start: Date, end: Date): number[] {
  return db
    .selectDistinct({ userId: schema.workouts.userId })
    .from(schema.workouts)
    .where(and(gte(schema.workouts.performedAt, start), lt(schema.workouts.performedAt, end)))
    .orderBy(asc(schema.workouts.userId))
    .all()
    .map((row) => row.userId);
}

export function deleteWorkoutForUser(db: Db, workoutId: number, userId: number): boolean {
  const result = db
    .delete(schema.workouts)
    .where(and(eq(schema.workouts.id, workoutId), eq(schema.workouts.userId, userId)))
    .run();
  return result.changes > 0;
}

export function sumBurnedKcal(workouts: Array<Pick<WorkoutRow, "kcalBurned">>): number {
  return workouts.reduce((sum, workout) => sum + workout.kcalBurned, 0);
}
