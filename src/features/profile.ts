import type { ProfileRow } from "../db/profiles.js";
import type { ActivityLevel, Goal, Sex } from "../nutrition/calculations.js";

export const SEX_LABEL: Record<Sex, string> = {
  male: "Мужской",
  female: "Женский",
};

export const ACTIVITY_LABEL: Record<ActivityLevel, string> = {
  sedentary: "Сидячий",
  light: "Лёгкая",
  moderate: "Средняя",
  active: "Высокая",
  very_active: "Очень высокая",
};

export const GOAL_LABEL: Record<Goal, string> = {
  lose: "Похудение",
  maintain: "Поддержание веса",
  gain: "Набор массы",
};

export function buildProfileMessage(profile: ProfileRow | undefined): string {
  if (!profile) {
    return "Профиль ещё не заполнен. Пройдите анкету, чтобы рассчитать дневную норму.";
  }

  return [
    "👤 Ваш профиль",
    "",
    `Пол: ${SEX_LABEL[profile.sex]}`,
    `Возраст: ${profile.age}`,
    `Рост: ${profile.heightCm} см`,
    `Вес: ${profile.weightKg} кг`,
    `Активность: ${ACTIVITY_LABEL[profile.activityLevel]}`,
    `Цель: ${GOAL_LABEL[profile.goal]}`,
    "",
    "🎯 Дневная норма:",
    `${profile.dailyKcalTarget} ккал`,
    `Б ${profile.proteinGTarget.toFixed(1)} / Ж ${profile.fatGTarget.toFixed(1)} / ` +
      `У ${profile.carbGTarget.toFixed(1)}`,
  ].join("\n");
}
