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

// Норма ккал на день с учётом расхода тренировок (см. workoutKcalBonus). Без уровня
// активности расход к норме не добавляется.
export function dayKcalTarget(
  dailyKcalTarget: number,
  activityLevel: ActivityLevel | undefined,
  burnedKcal: number,
): number {
  return dailyKcalTarget + (activityLevel ? workoutKcalBonus(activityLevel, burnedKcal) : 0);
}

// Расход после правки длительности/интенсивности: старый расход масштабируется по
// MET × время, так что вес остаётся тем, с которым тренировку записали, а не текущим.
export function rescaleWorkoutKcal(
  kcalBurned: number,
  from: Omit<WorkoutInput, "weightKg">,
  to: Omit<WorkoutInput, "weightKg">,
): number {
  const load = ({ activityType, intensity, durationMin }: Omit<WorkoutInput, "weightKg">) =>
    WORKOUT_MET[activityType][intensity] * durationMin;
  return Math.round((kcalBurned * load(to)) / load(from));
}

export interface Nutrition {
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

// Ккал на 100 г, расходящиеся с Б×4 + Ж×9 + У×4 сильнее этой доли, — повод проверить
// оценку. Ккал не пересчитываются: у алкоголя (7 ккал/г) расхождение законное.
const KCAL_MISMATCH_SHARE = 0.25;
// Ниже — почти пустые продукты (чай, вода, специи): там относительное расхождение
// ничего не значит.
const KCAL_MISMATCH_MIN_KCAL = 30;

export function macroKcal({ proteinG, fatG, carbG }: Omit<Nutrition, "kcal">): number {
  return proteinG * 4 + fatG * 9 + carbG * 4;
}

export function kcalMatchesMacros(per100g: Nutrition): boolean {
  const fromMacros = macroKcal(per100g);
  if (Math.max(per100g.kcal, fromMacros) < KCAL_MISMATCH_MIN_KCAL) return true;
  return Math.abs(per100g.kcal - fromMacros) <= KCAL_MISMATCH_SHARE * Math.max(per100g.kcal, fromMacros);
}

// КБЖУ порции из КБЖУ на 100 г: целые ккал, БЖУ с одним знаком после запятой.
export function portionNutrition(per100g: Nutrition, weightG: number, label = ""): Nutrition {
  if (!kcalMatchesMacros(per100g)) {
    console.warn(
      `portionNutrition: ккал не сходятся с БЖУ${label ? ` у «${label}»` : ""}: ` +
        `${per100g.kcal} ккал при Б×4 + Ж×9 + У×4 = ${Math.round(macroKcal(per100g))} на 100 г`,
    );
  }
  const scale = weightG / 100;
  return {
    kcal: Math.round(per100g.kcal * scale),
    proteinG: roundToOneDecimal(per100g.proteinG * scale),
    fatG: roundToOneDecimal(per100g.fatG * scale),
    carbG: roundToOneDecimal(per100g.carbG * scale),
  };
}

// Обратно: КБЖУ на 100 г из сохранённой порции (для правки записи в разговоре с Ням-Ням).
export function per100gNutrition(portion: Nutrition, weightG: number): Nutrition {
  if (weightG <= 0) return { kcal: 0, proteinG: 0, fatG: 0, carbG: 0 };
  const scale = 100 / weightG;
  return {
    kcal: Math.round(portion.kcal * scale),
    proteinG: roundToOneDecimal(portion.proteinG * scale),
    fatG: roundToOneDecimal(portion.fatG * scale),
    carbG: roundToOneDecimal(portion.carbG * scale),
  };
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
