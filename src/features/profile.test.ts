import { describe, expect, it } from "vitest";
import { buildProfileMessage } from "./profile.js";
import type { ProfileRow } from "../db/profiles.js";

describe("features/profile buildProfileMessage", () => {
  it("asks to fill in the questionnaire when there is no profile", () => {
    expect(buildProfileMessage(undefined)).toBe(
      "Профиль ещё не заполнен. Пройдите анкету, чтобы рассчитать дневную норму.",
    );
  });

  it("shows questionnaire answers and daily targets", () => {
    const profile: ProfileRow = {
      userId: 1,
      sex: "female",
      age: 30,
      heightCm: 168,
      weightKg: 62.5,
      activityLevel: "moderate",
      goal: "lose",
      dailyKcalTarget: 1820,
      proteinGTarget: 112.5,
      fatGTarget: 55.6,
      carbGTarget: 217,
    };

    expect(buildProfileMessage(profile)).toBe(
      [
        "👤 Ваш профиль",
        "",
        "Пол: Женский",
        "Возраст: 30",
        "Рост: 168 см",
        "Вес: 62.5 кг",
        "Активность: Средняя",
        "Цель: Похудение",
        "",
        "🎯 Дневная норма:",
        "1820 ккал",
        "Б 112.5 / Ж 55.6 / У 217.0",
      ].join("\n"),
    );
  });
});
