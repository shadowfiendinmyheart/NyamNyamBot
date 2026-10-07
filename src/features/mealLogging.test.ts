import { describe, expect, it } from "vitest";
import { buildMealMessage, buildNotRecognizedMessage } from "./mealLogging.js";
describe("features/mealLogging buildMealMessage", () => {
  it("lists items and totals, and appends notes when present", () => {
    const message = buildMealMessage(
      "lunch",
      [
        {
          name: "гречка",
          estimatedWeightG: 200,
          kcal: 220,
          proteinG: 6.5,
          fatG: 2.1,
          carbG: 41.3,
        },
        { name: "курица", estimatedWeightG: 150, kcal: 250, proteinG: 30, fatG: 12, carbG: 0 },
      ],
      "вес приблизительный",
    );

    expect(message).toContain("🍲 Обед");
    expect(message).toContain("• гречка — 200 г: 220 ккал (Б 6.5 / Ж 2.1 / У 41.3)");
    expect(message).toContain("Итого: 470 ккал | Б 36.5 Ж 14.1 У 41.3");
    expect(message).toContain("⚠️ вес приблизительный");
  });

  it("omits the notes line when there are none", () => {
    const message = buildMealMessage(
      "snack",
      [{ name: "яблоко", estimatedWeightG: 150, kcal: 80, proteinG: 0.4, fatG: 0.2, carbG: 19 }],
      null,
    );

    expect(message).not.toContain("⚠️");
  });
});

describe("features/mealLogging buildMealMessage day label", () => {
  const items = [
    { name: "плов", estimatedWeightG: 300, kcal: 480, proteinG: 15, fatG: 18, carbG: 60 },
  ];

  it("adds the day to the header for a meal that is not from today", () => {
    expect(buildMealMessage("dinner", items, null, "вчера").split("\n")[0]).toBe("🌙 Ужин · вчера");
  });

  it("keeps the plain header for today", () => {
    expect(buildMealMessage("dinner", items, null).split("\n")[0]).toBe("🌙 Ужин");
  });
});

describe("features/mealLogging buildNotRecognizedMessage", () => {
  it("короткий ответ с подсказкой и пояснением ИИ", () => {
    const message = buildNotRecognizedMessage("text", "Похоже на вопрос.");
    expect(message).toContain("Не нашла тут ни еды, ни тренировки. Похоже на вопрос.");
    expect(message).toContain("пришлите фото");
    expect(message).not.toContain("/workout");
  });

  it("для голосового упоминает голосовое, без пояснения — без хвоста", () => {
    expect(buildNotRecognizedMessage("voice", null)).toMatch(
      /^🤔 Не нашла в голосовом ни еды, ни тренировки\.\n/,
    );
  });
});
