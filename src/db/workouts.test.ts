import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { beforeEach, describe, expect, it } from "vitest";
import * as schema from "./schema.js";
import { createUser } from "./users.js";
import {
  createWorkout,
  deleteWorkoutForUser,
  getExerciseHistory,
  getUserIdsWithWorkoutsBetween,
  getWorkoutsBetween,
  sumBurnedKcal,
  type CreateWorkoutInput,
} from "./workouts.js";

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: "./drizzle" });
  return db;
}

const run = (userId: number, performedAt: Date): CreateWorkoutInput => ({
  userId,
  activityType: "running",
  description: "бег",
  durationMin: 40,
  intensity: "moderate",
  kcalBurned: 523,
  source: "command",
  performedAt,
});

describe("db/workouts", () => {
  let db: ReturnType<typeof makeDb>;

  beforeEach(() => {
    db = makeDb();
    createUser(db, 1, "alice");
    createUser(db, 2, "bob");
  });

  it("выбирает тренировки пользователя за полуинтервал [start, end)", () => {
    createWorkout(db, run(1, new Date("2026-09-01T08:00:00Z")));
    createWorkout(db, run(1, new Date("2026-09-02T00:00:00Z"))); // ровно end — не входит
    createWorkout(db, run(2, new Date("2026-09-01T09:00:00Z")));

    const start = new Date("2026-09-01T00:00:00Z");
    const end = new Date("2026-09-02T00:00:00Z");

    expect(getWorkoutsBetween(db, 1, start, end)).toHaveLength(1);
    expect(getUserIdsWithWorkoutsBetween(db, start, end)).toEqual([1, 2]);
  });

  it("удаляет только свою тренировку", () => {
    const workout = createWorkout(db, run(1, new Date()));

    expect(deleteWorkoutForUser(db, workout.id, 2)).toBe(false);
    expect(deleteWorkoutForUser(db, workout.id, 1)).toBe(true);
    expect(db.select().from(schema.workouts).all()).toEqual([]);
  });

  it("сохраняет упражнения, ищет их историю и удаляет вместе с тренировкой", () => {
    const pullUps = { name: "Подтягивания", sets: 3, reps: 10, weightKg: null, durationSec: null };
    const first = createWorkout(db, {
      ...run(1, new Date("2026-09-01T08:00:00Z")),
      activityType: "strength",
      exercises: [pullUps, { ...pullUps, name: "отжимания", reps: 20 }],
    });
    createWorkout(db, {
      ...run(1, new Date("2026-09-03T08:00:00Z")),
      exercises: [{ ...pullUps, reps: 12 }],
    });
    createWorkout(db, { ...run(2, new Date("2026-09-03T08:00:00Z")), exercises: [pullUps] });

    expect(first.exercises.map((e) => e.name)).toEqual(["подтягивания", "отжимания"]);
    const [workout] = getWorkoutsBetween(
      db,
      1,
      new Date("2026-09-01T00:00:00Z"),
      new Date("2026-09-02T00:00:00Z"),
    );
    expect(workout.exercises).toHaveLength(2);

    const history = getExerciseHistory(db, 1, "подтяг", 10);
    expect(history.map((e) => e.reps)).toEqual([12, 10]);

    deleteWorkoutForUser(db, first.id, 1);
    expect(getExerciseHistory(db, 1, "отжим", 10)).toEqual([]);
  });

  it("суммирует расход", () => {
    expect(sumBurnedKcal([{ kcalBurned: 300 }, { kcalBurned: 223 }])).toBe(523);
    expect(sumBurnedKcal([])).toBe(0);
  });
});
