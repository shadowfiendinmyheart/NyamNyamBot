import { describe, expect, it } from "vitest";
import { buildTodayReport, getTodayBoundsUtc } from "./reports.js";
import type { MealRow } from "../db/meals.js";

describe("features/reports getTodayBoundsUtc", () => {
  it("computes UTC bounds for Europe/Moscow (UTC+3), where local midnight falls on the previous UTC day", () => {
    const now = new Date("2026-08-22T21:30:00Z"); // 2026-08-23T00:30 в Москве
    const { start, end } = getTodayBoundsUtc(now, "Europe/Moscow");
    expect(start).toEqual(new Date("2026-08-22T21:00:00Z"));
    expect(end).toEqual(new Date("2026-08-23T21:00:00Z"));
  });

  it("computes UTC bounds for a negative-offset zone (America/Los_Angeles, PDT UTC-7)", () => {
    const now = new Date("2026-08-23T05:00:00Z"); // 2026-08-22T22:00 в Лос-Анджелесе
    const { start, end } = getTodayBoundsUtc(now, "America/Los_Angeles");
    expect(start).toEqual(new Date("2026-08-22T07:00:00Z"));
    expect(end).toEqual(new Date("2026-08-23T07:00:00Z"));
  });
});

describe("features/reports buildTodayReport", () => {
  const baseMeal: MealRow = {
    id: 1,
    userId: 1,
    loggedAt: new Date("2026-08-23T06:15:00Z"),
    mealType: "breakfast",
    source: "text",
    photoPath: null,
    description: "овсянка с бананом",
    kcal: 320,
    proteinG: 12,
    fatG: 6.5,
    carbG: 45,
    rawClaudeResponse: null,
  };

  it("reports an empty day", () => {
    expect(buildTodayReport([], "Europe/Moscow")).toBe("Сегодня записей о приёмах пищи пока нет.");
  });

  it("lists meals with local time and totals", () => {
    const message = buildTodayReport(
      [
        baseMeal,
        {
          ...baseMeal,
          id: 2,
          mealType: "lunch",
          kcal: 450,
          proteinG: 30,
          fatG: 10,
          carbG: 40,
          loggedAt: new Date("2026-08-23T10:00:00Z"),
        },
      ],
      "Europe/Moscow",
    );

    expect(message).toContain(
      "09:15 🌅 Завтрак — овсянка с бананом: 320 ккал (Б 12.0 / Ж 6.5 / У 45.0)",
    );
    expect(message).toContain("Итого: 770 ккал | Б 42.0 Ж 16.5 У 85.0");
  });
});
