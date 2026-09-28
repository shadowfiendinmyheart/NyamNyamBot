import { describe, expect, it } from "vitest";
import {
  calculateBmr,
  calculateDailyTargets,
  calculateWorkoutKcal,
  workoutKcalBonus,
  type ProfileInput,
} from "./calculations.js";

const baseMale: ProfileInput = {
  sex: "male",
  age: 30,
  heightCm: 180,
  weightKg: 80,
  activityLevel: "sedentary",
  goal: "maintain",
};

const baseFemale: ProfileInput = {
  sex: "female",
  age: 30,
  heightCm: 165,
  weightKg: 60,
  activityLevel: "sedentary",
  goal: "maintain",
};

describe("calculateBmr", () => {
  it("считает BMR для мужчины по формуле Миффлина-Сан Жеора", () => {
    // 10*80 + 6.25*180 - 5*30 + 5 = 800 + 1125 - 150 + 5 = 1780
    expect(calculateBmr(baseMale)).toBe(1780);
  });

  it("считает BMR для женщины по формуле Миффлина-Сан Жеора", () => {
    // 10*60 + 6.25*165 - 5*30 - 161 = 600 + 1031.25 - 150 - 161 = 1320.25
    expect(calculateBmr(baseFemale)).toBeCloseTo(1320.25, 5);
  });
});

describe("calculateDailyTargets", () => {
  it("для maintain даёт kcal ≈ BMR * коэффициент активности", () => {
    const targets = calculateDailyTargets(baseMale);
    // 1780 * 1.2 = 2136
    expect(targets.dailyKcalTarget).toBe(2136);
  });

  it("lose уменьшает норму примерно на 15% от maintain", () => {
    const maintain = calculateDailyTargets(baseMale);
    const lose = calculateDailyTargets({ ...baseMale, goal: "lose" });
    expect(lose.dailyKcalTarget).toBeLessThan(maintain.dailyKcalTarget);
    expect(lose.dailyKcalTarget).toBeCloseTo(maintain.dailyKcalTarget * 0.85, 0);
  });

  it("gain увеличивает норму примерно на 15% от maintain", () => {
    const maintain = calculateDailyTargets(baseMale);
    const gain = calculateDailyTargets({ ...baseMale, goal: "gain" });
    expect(gain.dailyKcalTarget).toBeGreaterThan(maintain.dailyKcalTarget);
    expect(gain.dailyKcalTarget).toBeCloseTo(maintain.dailyKcalTarget * 1.15, 0);
  });

  it("более высокая активность увеличивает норму", () => {
    const sedentary = calculateDailyTargets(baseMale);
    const active = calculateDailyTargets({ ...baseMale, activityLevel: "very_active" });
    expect(active.dailyKcalTarget).toBeGreaterThan(sedentary.dailyKcalTarget);
  });

  it("белок пропорционален весу тела (1.8 г/кг)", () => {
    const targets = calculateDailyTargets(baseFemale);
    expect(targets.proteinGTarget).toBeCloseTo(60 * 1.8, 5);
  });

  it("kcal целое, граммы БЖУ с одним знаком после запятой", () => {
    const targets = calculateDailyTargets(baseFemale);
    expect(Number.isInteger(targets.dailyKcalTarget)).toBe(true);
    for (const value of [targets.proteinGTarget, targets.fatGTarget, targets.carbGTarget]) {
      expect(Math.round(value * 10) / 10).toBe(value);
    }
  });

  it("углеводы не уходят в минус даже при экстремальном наборе БЖУ", () => {
    const targets = calculateDailyTargets({
      sex: "male",
      age: 80,
      heightCm: 150,
      weightKg: 200,
      activityLevel: "sedentary",
      goal: "lose",
    });
    expect(targets.carbGTarget).toBeGreaterThanOrEqual(0);
  });

  it("белки + жиры + углеводы (в ккал) примерно равны дневной норме", () => {
    const targets = calculateDailyTargets(baseMale);
    const kcalFromMacros =
      targets.proteinGTarget * 4 + targets.fatGTarget * 9 + targets.carbGTarget * 4;
    expect(kcalFromMacros).toBeCloseTo(targets.dailyKcalTarget, 0);
  });
});

describe("calculateWorkoutKcal", () => {
  it("считает ккал = MET × вес × часы", () => {
    // бег средней интенсивности: 9.8 * 80 * (40 / 60) = 522.67
    expect(
      calculateWorkoutKcal({ activityType: "running", intensity: "moderate", durationMin: 40, weightKg: 80 }),
    ).toBe(523);
  });

  it("интенсивность и вес увеличивают расход", () => {
    const base = { activityType: "cycling", durationMin: 60, weightKg: 70 } as const;
    const low = calculateWorkoutKcal({ ...base, intensity: "low" });
    const high = calculateWorkoutKcal({ ...base, intensity: "high" });
    const heavier = calculateWorkoutKcal({ ...base, intensity: "low", weightKg: 90 });
    expect(low).toBe(280);
    expect(high).toBeGreaterThan(low);
    expect(heavier).toBeGreaterThan(low);
  });
});

describe("workoutKcalBonus", () => {
  it("добавляет расход к норме только при сидячем уровне активности", () => {
    expect(workoutKcalBonus("sedentary", 500)).toBe(500);
    expect(workoutKcalBonus("light", 500)).toBe(0);
    expect(workoutKcalBonus("very_active", 500)).toBe(0);
  });
});
