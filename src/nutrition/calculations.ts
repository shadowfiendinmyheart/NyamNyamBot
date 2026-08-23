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

export function calculateDailyTargets(input: ProfileInput): NutritionTargets {
  const bmr = calculateBmr(input);
  const tdee = bmr * ACTIVITY_MULTIPLIER[input.activityLevel];
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

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}
