import { describe, expect, it } from "vitest";
import { buildMealMessage, buildNotRecognizedMessage, buildPer100gBlock } from "./mealLogging.js";
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

  it("puts the day progress right under the totals, before notes", () => {
    const lines = buildMealMessage(
      "dinner",
      items,
      "порция на глаз",
      null,
      "📊 За день: 1240 / 2100 ккал, осталось 860",
    ).split("\n");
    const totalsIndex = lines.findIndex((line) => line.startsWith("Итого:"));
    expect(lines[totalsIndex + 1]).toBe("📊 За день: 1240 / 2100 ккал, осталось 860");
    expect(lines.at(-1)).toBe("⚠️ порция на глаз");
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

describe("features/mealLogging buildPer100gBlock", () => {
  it("пересчитывает сохранённые порции на 100 г", () => {
    const items = [
      { name: "пельмени", estimatedWeightG: 200, kcal: 500, proteinG: 20, fatG: 25, carbG: 50 },
    ];
    expect(buildPer100gBlock(items)).toBe("На 100 г:\n• пельмени: 250 ккал (Б 10 / Ж 12.5 / У 25)");
  });
});

describe("features/mealLogging buildMealMessage product data", () => {
  it("помечает продукты из базы 📦 и добавляет сноску", () => {
    const message = buildMealMessage("breakfast", [
      {
        name: "греческий йогурт",
        estimatedWeightG: 116,
        kcal: 73,
        proteinG: 10.1,
        fatG: 2.3,
        carbG: 2.9,
        nutritionSource: "openfoodfacts",
      },
      { name: "банан", estimatedWeightG: 120, kcal: 107, proteinG: 1.3, fatG: 0.4, carbG: 27 },
    ], null);

    expect(message).toContain("• греческий йогурт — 116 г: 73 ккал (Б 10.1 / Ж 2.3 / У 2.9) 📦");
    expect(message).toContain("• банан — 120 г: 107 ккал (Б 1.3 / Ж 0.4 / У 27)\n");
    expect(message).toContain("📦 — КБЖУ на 100 г из базы Open Food Facts");
  });

  it("без продуктов из базы сноски нет", () => {
    const message = buildMealMessage("breakfast", [
      { name: "банан", estimatedWeightG: 120, kcal: 107, proteinG: 1.3, fatG: 0.4, carbG: 27 },
    ], null);

    expect(message).not.toContain("📦");
  });

  it("показывает пользу для цели строкой 🎯 перед ⚠️", () => {
    const lines = buildMealMessage(
      "lunch",
      [{ name: "гречка", estimatedWeightG: 200, kcal: 220, proteinG: 8, fatG: 2, carbG: 42 }],
      "жирность неясна",
      null,
      null,
      "Сытно и без лишнего жира.",
    ).split("\n");

    const tip = lines.indexOf("🎯 Сытно и без лишнего жира.");
    expect(tip).toBeGreaterThan(0);
    expect(lines.indexOf("⚠️ жирность неясна")).toBeGreaterThan(tip);
  });
});
