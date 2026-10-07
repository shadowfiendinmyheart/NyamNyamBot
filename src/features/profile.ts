import { InlineKeyboard } from "grammy";
import type { ProfileRow } from "../db/profiles.js";
import type { ActivityLevel, Goal, Sex } from "../nutrition/calculations.js";
import { formatTimeZone } from "../utils/timezones.js";

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

export const ACTIVITY_QUESTION = [
  "Какой у вас уровень активности?",
  "",
  "Сидячий — мало или совсем нет физической активности",
  "Лёгкая — тренировки 1-3 раза в неделю",
  "Средняя — тренировки 3-5 раз в неделю",
  "Высокая — тренировки 6-7 раз в неделю",
  "Очень высокая — тяжёлый физический труд или спорт каждый день",
].join("\n");

export const GOAL_LABEL: Record<Goal, string> = {
  lose: "Похудение",
  maintain: "Поддержание веса",
  gain: "Набор массы",
};

export const FILL_PROFILE_BUTTON = "📝 Заполнить анкету";
export const FILL_PROFILE_DATA = "profile:fill";
export const RESTART_ONBOARDING_BUTTON = "🔄 Анкета заново";

// Кнопка под сообщениями «сначала заполните анкету».
export function fillProfileKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text(FILL_PROFILE_BUTTON, FILL_PROFILE_DATA);
}

// «Нет профиля»: зачем нужна анкета (reason) — и кнопка, чтобы заполнить её сразу.
export function noProfileReply(reason: string): {
  text: string;
  reply_markup: InlineKeyboard;
} {
  return {
    text: `🐱 ${reason} Нажмите «${FILL_PROFILE_BUTTON}» — это пара минут.`,
    reply_markup: fillProfileKeyboard(),
  };
}

export function buildProfileMessage(profile: ProfileRow | undefined, timeZone?: string): string {
  if (!profile) {
    return (
      "👤 Профиль ещё не заполнен. Ответьте на несколько вопросов анкеты — и я рассчитаю " +
      "вашу дневную норму КБЖУ."
    );
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
    ...(timeZone ? [`Часовой пояс: ${formatTimeZone(timeZone)}`] : []),
    "",
    profile.motivation ? `💭 Зачем мне бот:\n${profile.motivation}` : "💭 Зачем мне бот: не указано",
    "",
    "🎯 Дневная норма:",
    `${profile.dailyKcalTarget} ккал`,
    `Б ${profile.proteinGTarget.toFixed(1)} / Ж ${profile.fatGTarget.toFixed(1)} / ` +
      `У ${profile.carbGTarget.toFixed(1)}`,
  ].join("\n");
}
