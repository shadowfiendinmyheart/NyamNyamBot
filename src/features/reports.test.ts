import { describe, expect, it } from "vitest";
import { buildTodayReport, buildWeeklyReport } from "./reports.js";
import type { DaySummary } from "../ai/coach.js";
import type { MealRow } from "../db/meals.js";
import type { WorkoutEntry } from "../db/workouts.js";

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

  const workout: WorkoutEntry = {
    id: 1,
    userId: 1,
    performedAt: new Date("2026-08-23T15:00:00Z"),
    activityType: "running",
    description: "бег",
    durationMin: 40,
    intensity: "moderate",
    kcalBurned: 523,
    source: "text",
    rawText: "бегал 40 минут",
    createdAt: new Date("2026-08-23T15:00:00Z"),
    exercises: [],
  };
  const targets = { dailyKcalTarget: 2000, proteinGTarget: 120, fatGTarget: 60, carbGTarget: 220 };

  it("при сидячей активности добавляет расход тренировок к норме", () => {
    const message = buildTodayReport(
      [baseMeal],
      "Europe/Moscow",
      { ...targets, activityLevel: "sedentary" },
      undefined,
      [workout],
    );

    expect(message).toContain("• 18:00 🏃 Бег — 40 мин, средняя интенсивность: ~523 ккал");
    expect(message).toContain("Сожжено на тренировках: 523 ккал");
    expect(message).toContain("Норма с учётом тренировок: 2523 ккал (+523)");
    expect(message).toContain("Осталось: 2203 ккал");
  });

  it("при высокой активности не добавляет расход и объясняет почему", () => {
    const message = buildTodayReport(
      [baseMeal],
      "Europe/Moscow",
      { ...targets, activityLevel: "active" },
      undefined,
      [workout],
    );

    expect(message).not.toContain("Норма с учётом тренировок");
    expect(message).toContain("Осталось: 1680 ккал");
    expect(message).toContain("уже заложены в уровень активности «Высокая»");
  });

  it("показывает упражнения силовой тренировки под строкой тренировки", () => {
    const strength: WorkoutEntry = {
      ...workout,
      activityType: "strength",
      description: "силовая",
      exercises: [
        { id: 1, workoutId: 1, name: "подтягивания", sets: 3, reps: 10, weightKg: null, durationSec: null },
        { id: 2, workoutId: 1, name: "жим лёжа", sets: 3, reps: 8, weightKg: 60, durationSec: null },
      ],
    };
    const message = buildTodayReport([], "Europe/Moscow", undefined, undefined, [strength]);

    expect(message).toContain("   подтягивания 3×10, жим лёжа 3×8 × 60 кг");
  });

  it("день только с тренировкой — не пустой отчёт", () => {
    const message = buildTodayReport([], "Europe/Moscow", undefined, undefined, [workout]);

    expect(message).toContain("Приёмов пищи пока нет.");
    expect(message).toContain("Сожжено на тренировках: 523 ккал");
  });
});

describe("features/reports buildWeeklyReport", () => {
  const day = (date: string, kcal: number, burnedKcal = 0): DaySummary => ({
    date,
    totals: { kcal, proteinG: 100, fatG: 60, carbG: 200 },
    meals:
      kcal > 0
        ? [{ time: "12:00", mealType: "lunch", description: "обед", kcal, proteinG: 100, fatG: 60, carbG: 200 }]
        : [],
    workouts:
      burnedKcal > 0
        ? [
            {
              time: "18:00",
              activityType: "running",
              description: "бег",
              durationMin: 40,
              intensity: "moderate",
              kcalBurned: burnedKcal,
              exercises: [],
            },
          ]
        : [],
    burnedKcal,
  });
  const days = [day("2026-09-21", 1800), day("2026-09-22", 0), day("2026-09-23", 2200)];

  it("показывает тренировки по дням и итог за неделю", () => {
    const text = buildWeeklyReport(
      [day("2026-09-21", 1800, 500), day("2026-09-22", 0, 300), day("2026-09-23", 2200)],
      undefined,
      [],
    );
    expect(text).toContain("• Пн 21.09 — 1800 ккал, 🏃 ~500 ккал");
    expect(text).toContain("• Вт 22.09 — нет записей, 🏃 ~300 ккал");
    expect(text).toContain("🏃 Тренировок: 2, сожжено ~800 ккал");
  });

  it("без тренировок подсказывает /workout", () => {
    expect(buildWeeklyReport(days, undefined, [])).toContain(
      "Тренировок за неделю не записано — /workout",
    );
  });

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
