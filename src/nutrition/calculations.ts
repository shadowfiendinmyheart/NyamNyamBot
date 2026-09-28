export type Sex = "male" | "female";
export type ActivityLevel = "sedentary" | "light" | "moderate" | "active" | "very_active";
export type Goal = "lose" | "maintain" | "gain";

export interface ProfileInput {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
}

export interface NutritionTargets {
  dailyKcalTarget: number;
  proteinGTarget: number;
  fatGTarget: number;
  carbGTarget: number;
}

const ACTIVITY_MULTIPLIER: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

const GOAL_ADJUSTMENT: Record<Goal, number> = {
  lose: -0.15,
  maintain: 0,
  gain: 0.15,
};

const PROTEIN_G_PER_KG = 1.8;
const FAT_SHARE_OF_KCAL = 0.275;

export function calculateBmr({ sex, age, heightCm, weightKg }: ProfileInput): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === "male" ? base + 5 : base - 161;
}

// Суточный расход энергии с учётом активности (без поправки на цель).
export function calculateTdee(input: ProfileInput): number {
  return calculateBmr(input) * ACTIVITY_MULTIPLIER[input.activityLevel];
}

export function calculateDailyTargets(input: ProfileInput): NutritionTargets {
  const tdee = calculateTdee(input);
  const adjustedKcal = tdee * (1 + GOAL_ADJUSTMENT[input.goal]);

  const proteinGTarget = roundToOneDecimal(input.weightKg * PROTEIN_G_PER_KG);
  const fatGTarget = roundToOneDecimal((adjustedKcal * FAT_SHARE_OF_KCAL) / 9);
  const remainingKcal = Math.max(adjustedKcal - proteinGTarget * 4 - fatGTarget * 9, 0);
  const carbGTarget = roundToOneDecimal(remainingKcal / 4);

  return {
    dailyKcalTarget: Math.round(adjustedKcal),
    proteinGTarget,
    fatGTarget,
    carbGTarget,
  };
}

export const WORKOUT_ACTIVITY_TYPES = [
  "walking",
  "running",
  "cycling",
  "swimming",
  "strength",
  "hiit",
  "yoga",
  "sports",
  "dancing",
  "skiing",
  "other",
] as const;
export type WorkoutActivityType = (typeof WORKOUT_ACTIVITY_TYPES)[number];

export const WORKOUT_INTENSITIES = ["low", "moderate", "high"] as const;
export type WorkoutIntensity = (typeof WORKOUT_INTENSITIES)[number];

// Верхняя граница одной тренировки — общая для /workout и распознавания ИИ: дольше
// скорее ошибка ввода или перепутанные единицы, а не реальная тренировка.
export const MAX_WORKOUT_MIN = 600;

// MET по Compendium of Physical Activities, округлённо: [лёгкая, средняя, высокая].
const WORKOUT_MET: Record<WorkoutActivityType, Record<WorkoutIntensity, number>> = {
  walking: { low: 2.8, moderate: 3.5, high: 5 },
  running: { low: 7, moderate: 9.8, high: 11.5 },
  cycling: { low: 4, moderate: 6.8, high: 10 },
  swimming: { low: 5.8, moderate: 7, high: 9.8 },
  strength: { low: 3.5, moderate: 5, high: 6 },
  hiit: { low: 6, moderate: 8, high: 10 },
  yoga: { low: 2.5, moderate: 3, high: 4 },
  sports: { low: 4, moderate: 7, high: 9 },
  dancing: { low: 4.5, moderate: 5.5, high: 7.8 },
  skiing: { low: 5.3, moderate: 7, high: 9 },
  other: { low: 3, moderate: 4.5, high: 6 },
};

export interface WorkoutInput {
  activityType: WorkoutActivityType;
  intensity: WorkoutIntensity;
  durationMin: number;
  weightKg: number;
}

// ккал = MET × вес_кг × часы, целые ккал.
export function calculateWorkoutKcal({
  activityType,
  intensity,
  durationMin,
  weightKg,
}: WorkoutInput): number {
  return Math.round(WORKOUT_MET[activityType][intensity] * weightKg * (durationMin / 60));
}

// Сколько ккал тренировок добавить к дневной норме. Коэффициент активности всех уровней,
// кроме сидячего, уже закладывает регулярные тренировки — добавлять их расход ещё раз
// значило бы посчитать его дважды. Поэтому расход прибавляется к норме только при
// сидячем уровне; тем, кто записывает каждую тренировку, стоит выбрать именно его.
export function workoutKcalBonus(activityLevel: ActivityLevel, burnedKcal: number): number {
  return activityLevel === "sedentary" ? burnedKcal : 0;
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
