import { describe, expect, it } from "vitest";
import type { ProfileRow } from "../db/profiles.js";
import {
  buildActivityChangedMessage,
  buildWeightHistoryMessage,
  buildWeightLoggedMessage,
  parseWeight,
} from "./weight.js";

const before: ProfileRow = {
  userId: 1,
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "sedentary",
  goal: "maintain",
  dailyKcalTarget: 2136,
  proteinGTarget: 144,
  fatGTarget: 65.3,
  carbGTarget: 218.7,
};

describe("features/weight parseWeight", () => {
  it("принимает десятичную запятую и округляет до 0.1", () => {
    expect(parseWeight(" 78,46 ")).toBe(78.5);
    expect(parseWeight("80")).toBe(80);
  });

  it("отклоняет не-числа и значения вне диапазона", () => {
    expect(parseWeight("много")).toBeUndefined();
    expect(parseWeight("")).toBeUndefined();
    expect(parseWeight("29")).toBeUndefined();
    expect(parseWeight("301")).toBeUndefined();
  });
});

describe("features/weight buildWeightLoggedMessage", () => {
  it("показывает изменение веса и нормы и предлагает обновить активность", () => {
    const after: ProfileRow = {
      ...before,
      weightKg: 78.5,
      dailyKcalTarget: 2118,
      proteinGTarget: 141.3,
      fatGTarget: 64.7,
      carbGTarget: 213.7,
    };

    expect(buildWeightLoggedMessage({ before, after })).toBe(
      [
        "⚖️ Вес записан: 78.5 кг (−1.5 кг)",
        "",
        "🎯 Дневная норма:",
        "2136 → 2118 ккал (−18)",
        "Б 141.3 / Ж 64.7 / У 213.7",
        "",
        "Активность: Сидячий. Если начали тренироваться или стали двигаться меньше — " +
          "обновите её, и норма пересчитается.",
      ].join("\n"),
    );
  });

  it("пишет «без изменений», если вес тот же", () => {
    const message = buildWeightLoggedMessage({ before, after: before });
    expect(message).toContain("Вес записан: 80 кг (без изменений)");
    expect(message).toContain("2136 ккал (без изменений)");
  });
});

describe("features/weight buildActivityChangedMessage", () => {
  it("показывает переход с сидячего образа жизни на тренировки", () => {
    const after: ProfileRow = {
      ...before,
      activityLevel: "moderate",
      dailyKcalTarget: 2759,
      fatGTarget: 84.3,
      carbGTarget: 356.2,
    };

    expect(buildActivityChangedMessage({ before, after })).toBe(
      [
        "🏃 Активность: Сидячий → Средняя",
        "",
        "🎯 Дневная норма:",
        "2136 → 2759 ккал (+623)",
        "Б 144.0 / Ж 84.3 / У 356.2",
      ].join("\n"),
    );
  });

  it("сообщает, если выбран тот же уровень", () => {
    expect(buildActivityChangedMessage({ before, after: before })).toBe(
      "Уровень активности не изменился: Сидячий.",
    );
  });
});

describe("features/weight buildWeightHistoryMessage", () => {
  it("без истории показывает только текущий вес", () => {
    expect(buildWeightHistoryMessage(before, [], "Europe/Moscow")).toBe("Текущий вес в профиле: 80 кг");
  });

  it("с историей перечисляет последние записи", () => {
    const message = buildWeightHistoryMessage(before, [
      // 22:30 UTC 7 сентября — уже 8 сентября в Москве
      { id: 2, userId: 1, weightKg: 79.2, loggedAt: new Date("2026-09-07T22:30:00Z") },
    ], "Europe/Moscow");
    expect(message).toBe(
      ["Текущий вес в профиле: 80 кг", "", "Последние записи:", "08.09.2026 — 79.2 кг"].join("\n"),
    );
  });
});
