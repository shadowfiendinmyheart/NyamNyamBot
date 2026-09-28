import { describe, expect, it } from "vitest";
import type { WorkoutEntry } from "../db/workouts.js";
import { buildWorkoutMessage, parseWorkoutCommand } from "./workout.js";
import { formatExercise } from "./workoutFormat.js";

describe("features/workout parseWorkoutCommand", () => {
  it("вид активности и минуты, интенсивность по умолчанию средняя", () => {
    expect(parseWorkoutCommand("бег 40")).toEqual({
      activityType: "running",
      name: "бег",
      durationMin: 40,
      intensity: "moderate",
    });
  });

  it("понимает часы, слитные единицы и интенсивность в любом месте", () => {
    expect(parseWorkoutCommand("интенсивно плавание 1,5ч")).toEqual({
      activityType: "swimming",
      name: "плавание",
      durationMin: 90,
      intensity: "high",
    });
    expect(parseWorkoutCommand("Пробежка 30 мин легко")).toMatchObject({
      activityType: "running",
      durationMin: 30,
      intensity: "low",
    });
  });

  it("незнакомую активность записывает как «другое» с названием пользователя", () => {
    expect(parseWorkoutCommand("скалолазание 60")).toMatchObject({
      activityType: "other",
      name: "скалолазание",
    });
  });

  it("складывает часы и минуты, числа с другими единицами оставляет в названии", () => {
    expect(parseWorkoutCommand("бег 1 час 30 минут")).toMatchObject({
      name: "бег",
      durationMin: 90,
    });
    expect(parseWorkoutCommand("бег 1ч30м")).toMatchObject({ name: "бег", durationMin: 90 });
    expect(parseWorkoutCommand("бег 5 км 30 минут")).toMatchObject({
      activityType: "running",
      name: "бег 5 км",
      durationMin: 30,
    });
    expect(parseWorkoutCommand("бег 5 км 30")).toMatchObject({
      name: "бег 5 км",
      durationMin: 30,
    });
    expect(parseWorkoutCommand("бег 5 км")).toBeUndefined();
  });

  it("без длительности, без названия или с нереальной длительностью — undefined", () => {
    expect(parseWorkoutCommand("бег")).toBeUndefined();
    expect(parseWorkoutCommand("40")).toBeUndefined();
    expect(parseWorkoutCommand("бег 0")).toBeUndefined();
    expect(parseWorkoutCommand("бег 1000")).toBeUndefined();
  });
});

describe("features/workout buildWorkoutMessage", () => {
  const workout: WorkoutEntry = {
    id: 7,
    userId: 1,
    performedAt: new Date(),
    activityType: "running",
    description: "бег",
    durationMin: 40,
    intensity: "moderate",
    kcalBurned: 523,
    source: "command",
    rawText: "бег 40",
    createdAt: new Date(),
    exercises: [],
  };

  it("при сидячей активности сообщает прибавку к норме", () => {
    const text = buildWorkoutMessage(workout, "sedentary");
    expect(text).toContain("🏃 Бег — 40 мин, средняя интенсивность");
    expect(text).toContain("Сожжено: ~523 ккал");
    expect(text).toContain("+523 ккал к дневной норме");
  });

  it("при другом уровне активности объясняет, что к норме не добавляется", () => {
    expect(buildWorkoutMessage(workout, "moderate")).toContain("к норме не добавляется");
  });

  it("предупреждает об оценённой длительности", () => {
    expect(buildWorkoutMessage(workout, "sedentary", true)).toContain("Длительность не указана");
  });
});

describe("features/workoutFormat formatExercise", () => {
  const base = { name: "подтягивания", sets: null, reps: null, weightKg: null, durationSec: null };

  it("подходы, повторения, вес и статика", () => {
    expect(formatExercise({ ...base, sets: 3, reps: 10 })).toBe("подтягивания 3×10");
    expect(formatExercise({ ...base, name: "жим лёжа", sets: 3, reps: 8, weightKg: 60 })).toBe(
      "жим лёжа 3×8 × 60 кг",
    );
    expect(formatExercise({ ...base, name: "планка", sets: 3, durationSec: 60 })).toBe(
      "планка 3×60 с",
    );
    expect(formatExercise({ ...base, reps: 20 })).toBe("подтягивания 20");
    expect(formatExercise({ ...base, sets: 4 })).toBe("подтягивания 4 подх.");
  });
});
