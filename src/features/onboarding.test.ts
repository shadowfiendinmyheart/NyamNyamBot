import { describe, expect, it } from "vitest";
import {
  ACTIVITY_WORDS,
  GOAL_WORDS,
  matchChoiceText,
  MAX_MOTIVATION_LENGTH,
  normalizeMotivation,
  parseNumberAnswer,
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
});

describe("features/onboarding parseNumberAnswer", () => {
  const height = { min: 100, max: 250, integer: true };
  const weight = { min: 30, max: 300, integer: false };

  it("принимает число с единицами после него", () => {
    expect(parseNumberAnswer("175", height)).toBe(175);
    expect(parseNumberAnswer("175 см", height)).toBe(175);
    expect(parseNumberAnswer("78,5 кг", weight)).toBe(78.5);
    expect(parseNumberAnswer("78.5кг", weight)).toBe(78.5);
  });

  it("отклоняет числа вне диапазона и дробные там, где нужно целое", () => {
    expect(parseNumberAnswer("90", height)).toBeUndefined();
    expect(parseNumberAnswer("175.5", height)).toBeUndefined();
  });

  it("отклоняет текст без числа в начале", () => {
    expect(parseNumberAnswer("рост 175", height)).toBeUndefined();
    expect(parseNumberAnswer("съел яблоко", weight)).toBeUndefined();
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
