import type { ExerciseInput, WorkoutRow } from "../db/workouts.js";
import {
  workoutKcalBonus,
  type ActivityLevel,
  type WorkoutActivityType,
  type WorkoutIntensity,
} from "../nutrition/calculations.js";
import { ACTIVITY_LABEL } from "./profile.js";

export const WORKOUT_TYPE_EMOJI: Record<WorkoutActivityType, string> = {
  walking: "🚶",
  running: "🏃",
  cycling: "🚴",
  swimming: "🏊",
  strength: "🏋️",
  hiit: "🔥",
  yoga: "🧘",
  sports: "⚽",
  dancing: "💃",
  skiing: "⛷",
  other: "🤸",
};

export const WORKOUT_TYPE_NAME: Record<WorkoutActivityType, string> = {
  walking: "ходьба",
  running: "бег",
  cycling: "велосипед",
  swimming: "плавание",
  strength: "силовая",
  hiit: "интервальная",
  yoga: "йога / растяжка",
  sports: "игровой спорт",
  dancing: "танцы",
  skiing: "лыжи / коньки",
  other: "другое",
};

export const INTENSITY_LABEL: Record<WorkoutIntensity, string> = {
  low: "Лёгкая",
  moderate: "Средняя",
  high: "Высокая",
};

export function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function formatWorkoutLine(
  workout: Pick<WorkoutRow, "activityType" | "description" | "durationMin" | "intensity">,
): string {
  return (
    `${WORKOUT_TYPE_EMOJI[workout.activityType]} ${capitalize(workout.description)} — ` +
    `${workout.durationMin} мин, ${INTENSITY_LABEL[workout.intensity].toLowerCase()} интенсивность`
  );
}

// «подтягивания 3×10», «жим лёжа 3×8 × 60 кг», «планка 3×60 с», «отжимания 20».
export function formatExercise(exercise: ExerciseInput): string {
  const volume = exercise.reps ?? (exercise.durationSec ? `${exercise.durationSec} с` : null);
  const parts = [exercise.name];
  if (volume !== null) parts.push(exercise.sets ? `${exercise.sets}×${volume}` : `${volume}`);
  else if (exercise.sets) parts.push(`${exercise.sets} подх.`);
  if (exercise.weightKg) parts.push(`× ${exercise.weightKg} кг`);
  return parts.join(" ");
}

// Почему расход тренировок не добавлен к норме (см. workoutKcalBonus).
export function workoutNotAddedNote(activityLevel: ActivityLevel): string {
  return (
    "Расход тренировок к норме не добавляется: они уже заложены в уровень активности " +
    `«${ACTIVITY_LABEL[activityLevel]}». Если записываете каждую тренировку — выберите ` +
    "«Сидячий» (/activity), тогда расход будет прибавляться к норме."
  );
}

export function workoutBonusNote(activityLevel: ActivityLevel, burnedKcal: number): string {
  const bonus = workoutKcalBonus(activityLevel, burnedKcal);
  return bonus > 0 ? `+${bonus} ккал к дневной норме` : workoutNotAddedNote(activityLevel);
}
