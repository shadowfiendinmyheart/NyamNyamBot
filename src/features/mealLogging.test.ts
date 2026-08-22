import { describe, expect, it } from "vitest";
import { buildMealMessage, determineMealType } from "./mealLogging.js";

describe("features/mealLogging determineMealType", () => {
  const tz = "Europe/Moscow";

  it("classifies morning hours as breakfast", () => {
    expect(determineMealType(new Date("2026-08-22T05:00:00Z"), tz)).toBe("breakfast");
  });

  it("classifies midday hours as lunch", () => {
    expect(determineMealType(new Date("2026-08-22T09:30:00Z"), tz)).toBe("lunch");
  });

  it("classifies evening hours as dinner", () => {
    expect(determineMealType(new Date("2026-08-22T15:00:00Z"), tz)).toBe("dinner");
  });

  it("classifies night hours as snack", () => {
    expect(determineMealType(new Date("2026-08-22T22:30:00Z"), tz)).toBe("snack");
  });

  it("uses the given timezone rather than the server's local time", () => {
    // 06:00 UTC is 09:00 in Europe/Moscow (breakfast) but still 23:00 the previous
    // day in America/Los_Angeles (snack).
    const date = new Date("2026-08-22T06:00:00Z");
    expect(determineMealType(date, "Europe/Moscow")).toBe("breakfast");
    expect(determineMealType(date, "America/Los_Angeles")).toBe("snack");
  });
});

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
