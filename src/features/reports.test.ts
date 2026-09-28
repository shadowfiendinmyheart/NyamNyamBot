import { describe, expect, it } from "vitest";
import { buildTodayReport, buildWeeklyReport } from "./reports.js";
import type { DaySummary } from "../ai/coach.js";
import type { MealRow } from "../db/meals.js";

describe("features/reports buildTodayReport", () => {
  const baseMeal: MealRow = {
    id: 1,
    userId: 1,
    loggedAt: new Date("2026-08-23T06:15:00Z"),
    mealType: "breakfast",
    source: "text",
    telegramFileId: null,
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

  it("без профиля не показывает норму", () => {
    const message = buildTodayReport([baseMeal], "Europe/Moscow");
    expect(message).not.toContain("Норма:");
  });

  it("с профилем показывает норму и остаток", () => {
    const message = buildTodayReport([baseMeal], "Europe/Moscow", {
      dailyKcalTarget: 2000,
      proteinGTarget: 120,
      fatGTarget: 60,
      carbGTarget: 220,
    });

    expect(message).toContain("Норма: 2000 ккал | Б 120.0 Ж 60.0 У 220.0");
    expect(message).toContain("Осталось: 1680 ккал");
  });

  it("при превышении нормы показывает превышение", () => {
    const message = buildTodayReport([baseMeal], "Europe/Moscow", {
      dailyKcalTarget: 200,
      proteinGTarget: 20,
      fatGTarget: 10,
      carbGTarget: 20,
    });

    expect(message).toContain("Превышение: 120 ккал");
  });
});

describe("features/reports buildWeeklyReport", () => {
  const day = (date: string, kcal: number): DaySummary => ({
    date,
    totals: { kcal, proteinG: 100, fatG: 60, carbG: 200 },
    meals:
      kcal > 0
        ? [{ time: "12:00", mealType: "lunch", description: "обед", kcal, proteinG: 100, fatG: 60, carbG: 200 }]
        : [],
  });
  const days = [day("2026-09-21", 1800), day("2026-09-22", 0), day("2026-09-23", 2200)];

  it("средние считаются только по дням с записями и сравниваются с нормой", () => {
    const text = buildWeeklyReport(
      days,
      { dailyKcalTarget: 1900, proteinGTarget: 144, fatGTarget: 58, carbGTarget: 200 },
      [],
    );
    expect(text).toContain("📊 Неделя 21.09–23.09");
    expect(text).toContain("• Пн 21.09 — 1800 ккал");
    expect(text).toContain("• Вт 22.09 — нет записей");
    expect(text).toContain("Дней с записями: 2 из 3");
    expect(text).toContain("В среднем за день: 2000 ккал | Б 100.0 Ж 60.0 У 200.0");
    expect(text).toContain("В среднем выше нормы на 100 ккал в день");
    expect(text).toContain("Вес за неделю не записывали");
  });

  it("без анкеты не показывает норму; одна запись веса", () => {
    const text = buildWeeklyReport(days, undefined, [{ weightKg: 80 }]);
    expect(text).not.toContain("Норма");
    expect(text).toContain("⚖️ Вес: 80 кг (одна запись за неделю)");
  });
});
