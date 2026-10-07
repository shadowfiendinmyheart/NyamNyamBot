import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WORDS,
  GOAL_WORDS,
  isInRange,
  matchChoiceText,
  MAX_MOTIVATION_LENGTH,
  normalizeMotivation,
  parseNumberText,
  SEX_WORDS,
} from "./onboarding.js";
import { ACTIVITY_LABEL, GOAL_LABEL, SEX_LABEL } from "./profile.js";

describe("features/onboarding matchChoiceText", () => {
  it("узнаёт пол словами", () => {
    expect(matchChoiceText("мужской", SEX_LABEL, SEX_WORDS)).toBe("male");
    expect(matchChoiceText("Женщина", SEX_LABEL, SEX_WORDS)).toBe("female");
    expect(matchChoiceText("м", SEX_LABEL, SEX_WORDS)).toBe("male");
    expect(matchChoiceText("ж.", SEX_LABEL, SEX_WORDS)).toBe("female");
  });

  it("короткое слово не совпадает с началом другого ответа", () => {
    expect(matchChoiceText("мне 30", SEX_LABEL, SEX_WORDS)).toBeUndefined();
  });

  it("узнаёт вариант по номеру", () => {
    expect(matchChoiceText("2", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe("light");
    expect(matchChoiceText("9", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBeUndefined();
  });

  it("«очень высокая» и «высокая» — разные уровни активности", () => {
    expect(matchChoiceText("Очень высокая", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe("very_active");
    expect(matchChoiceText("очень высокий", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe("very_active");
    expect(matchChoiceText("я мужчина", SEX_LABEL, SEX_WORDS)).toBe("male");
    expect(matchChoiceText("высокая", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe("active");
    expect(matchChoiceText("легкая", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe("light");
  });

  it("узнаёт цель по смыслу", () => {
    expect(matchChoiceText("хочу похудеть", GOAL_LABEL, GOAL_WORDS)).toBe("lose");
    expect(matchChoiceText("похудеть", GOAL_LABEL, GOAL_WORDS)).toBe("lose");
    expect(matchChoiceText("набор массы", GOAL_LABEL, GOAL_WORDS)).toBe("gain");
    expect(matchChoiceText("поддерживать вес", GOAL_LABEL, GOAL_WORDS)).toBe("maintain");
  });

  it("непонятный ответ — undefined", () => {
    expect(matchChoiceText("не знаю", GOAL_LABEL, GOAL_WORDS)).toBeUndefined();
    expect(matchChoiceText("   ", GOAL_LABEL, GOAL_WORDS)).toBeUndefined();
  });

  it("не путает ответ с противоположным вариантом", () => {
    expect(matchChoiceText("очень мало двигаюсь", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe(
      "sedentary",
    );
    expect(matchChoiceText("тяжёлый физический труд", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBe(
      "very_active",
    );
  });

  it("с отрицанием или несколькими вариантами сразу — не угадывает", () => {
    expect(matchChoiceText("не очень активный", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBeUndefined();
    expect(matchChoiceText("не высокая", ACTIVITY_LABEL, ACTIVITY_WORDS)).toBeUndefined();
    expect(matchChoiceText("массу сбросить", GOAL_LABEL, GOAL_WORDS)).toBeUndefined();
    expect(matchChoiceText("не мужчина", SEX_LABEL, SEX_WORDS)).toBeUndefined();
  });
});

describe("features/onboarding parseNumberText", () => {
  it("принимает число с единицами и словами вокруг", () => {
    expect(parseNumberText("175")).toBe(175);
    expect(parseNumberText("175 см")).toBe(175);
    expect(parseNumberText("78,5 кг")).toBe(78.5);
    expect(parseNumberText("78.5кг.")).toBe(78.5);
    expect(parseNumberText("мне 30")).toBe(30);
    expect(parseNumberText("30 лет мне")).toBe(30);
    expect(parseNumberText("75 кг примерно")).toBe(75);
    expect(parseNumberText("рост 175")).toBe(175);
    expect(parseNumberText("где-то 80")).toBe(80);
    expect(parseNumberText("40 минут")).toBe(40);
  });

  it("несколько чисел или посторонние слова — не ответ", () => {
    expect(parseNumberText("78 кг 500 г")).toBeUndefined();
    expect(parseNumberText("съел 2 яблока")).toBeUndefined();
    expect(parseNumberText("съел яблоко")).toBeUndefined();
    expect(parseNumberText("")).toBeUndefined();
  });
});

describe("features/onboarding isInRange", () => {
  const height = { min: 100, max: 250, integer: true };

  it("проверяет границы и целое", () => {
    expect(isInRange(175, height)).toBe(true);
    expect(isInRange(90, height)).toBe(false);
    expect(isInRange(175.5, height)).toBe(false);
    expect(isInRange(78.5, { min: 30, max: 300, integer: false })).toBe(true);
  });
});

describe("features/onboarding normalizeMotivation", () => {
  it("обрезает пробелы по краям", () => {
    expect(normalizeMotivation("  Хочу похудеть к лету \n")).toBe("Хочу похудеть к лету");
  });

  it("пустой ответ — null", () => {
    expect(normalizeMotivation("   ")).toBeNull();
  });

  it("слишком длинный ответ обрезается с многоточием", () => {
    const result = normalizeMotivation("а".repeat(MAX_MOTIVATION_LENGTH + 100));
    expect(result).toHaveLength(MAX_MOTIVATION_LENGTH + 1);
    expect(result?.endsWith("…")).toBe(true);
  });
});
