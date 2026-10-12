import { beforeEach, describe, expect, it, vi } from "vitest";

const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create: createMock };
  },
}));

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { analyzeMessage } = await import("./analyzeMessage.js");

function toolUseResponse(input: unknown) {
  return {
    content: [{ type: "tool_use", id: "toolu_1", name: "log_diary_entry", input }],
  };
}

describe("claude/analyzeMessage", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("возвращает и еду, и тренировку из одного сообщения", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [
          { name: "банан", estimated_weight_g: 120, kcal: 107, protein_g: 1.3, fat_g: 0.4, carb_g: 27 },
        ],
        workouts: [
          {
            activity_type: "running",
            name: "бег",
            duration_min: 40,
            duration_estimated: false,
            intensity: "moderate",
          },
        ],
      }),
    );

    const result = await analyzeMessage({ text: "бегал 40 минут, потом съел банан" });

    expect(createMock.mock.calls[0][0].tool_choice).toEqual({
      type: "tool",
      name: "log_diary_entry",
    });
    expect(result.food.items.map((i) => i.name)).toEqual(["банан"]);
    expect(result.workouts).toEqual([
      {
        activityType: "running",
        name: "бег",
        durationMin: 40,
        durationEstimated: false,
        intensity: "moderate",
        exercises: [],
      },
    ]);
  });

  it("неизвестные тип и интенсивность заменяет на other/moderate, минуты округляет", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: false,
        items: [],
        workouts: [
          { activity_type: "climbing", name: "скалодром", duration_min: 89.6, intensity: "extreme" },
        ],
      }),
    );

    const { workouts } = await analyzeMessage({ text: "полтора часа на скалодроме" });

    expect(workouts[0]).toMatchObject({
      activityType: "other",
      intensity: "moderate",
      durationMin: 90,
      durationEstimated: false,
    });
  });

  it("разбирает упражнения силовой тренировки, мусорные числа превращает в null", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: false,
        items: [],
        workouts: [
          {
            activity_type: "strength",
            name: "силовая",
            duration_min: 20,
            duration_estimated: true,
            intensity: "moderate",
            exercises: [
              { name: "Подтягивания", sets: 3, reps: 10 },
              { name: "отжимания", sets: 3, reps: 20, weight_kg: 0 },
              { name: "  " },
            ],
          },
          {
            activity_type: "hiit",
            name: "скакалка",
            duration_min: 15,
            duration_estimated: false,
            intensity: "moderate",
          },
        ],
      }),
    );

    const { workouts } = await analyzeMessage({
      text: "подтягивания 10 раз по 3 подхода и отжимания 20 раз по 3 подхода + скакалка 15 минут",
    });

    expect(workouts).toHaveLength(2);
    expect(workouts[0].exercises).toEqual([
      { name: "подтягивания", sets: 3, reps: 10, weightKg: null, durationSec: null },
      { name: "отжимания", sets: 3, reps: 20, weightKg: null, durationSec: null },
    ]);
    expect(workouts[1]).toMatchObject({ activityType: "hiit", durationMin: 15, exercises: [] });
  });

  it("пропускает некорректные тренировки, но сохраняет еду из того же сообщения", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [
          { name: "банан", estimated_weight_g: 120, kcal: 107, protein_g: 1.3, fat_g: 0.4, carb_g: 27 },
        ],
        workouts: [
          { activity_type: "running", name: "бег", duration_min: 0.3, intensity: "low" },
          { activity_type: "swimming", name: "плавание", duration_min: 900, intensity: "high" },
          { activity_type: "walking", name: "прогулка", duration_min: 30, intensity: "low" },
        ],
      }),
    );

    const { food, workouts } = await analyzeMessage({ text: "банан, бег, плавание, прогулка" });

    expect(food.items).toHaveLength(1);
    expect(workouts).toHaveLength(1);
    expect(workouts[0]).toMatchObject({ activityType: "walking", durationMin: 30 });
  });

  it("без workouts в ответе возвращает пустой список", async () => {
    createMock.mockResolvedValue(toolUseResponse({ food_detected: false, items: [] }));

    const result = await analyzeMessage({ text: "привет" });

    expect(result.workouts).toEqual([]);
    expect(result.food.foodDetected).toBe(false);
  });

  it("возвращает названные день, время и приём пищи", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [{ name: "плов", estimated_weight_g: 300, kcal: 480, protein_g: 15, fat_g: 18, carb_g: 60 }],
        meal_days_ago: 1,
        meal_time: "20:30",
        meal_type: "dinner",
        workouts: [],
      }),
    );

    const { mealTime } = await analyzeMessage({ text: "вчера в полдевятого вечера ел плов" });

    expect(mealTime).toEqual({ daysAgo: 1, minutesOfDay: 20 * 60 + 30, mealType: "dinner" });
  });

  it("отбрасывает некорректные день, время и приём пищи", async () => {
    createMock.mockResolvedValue(
      toolUseResponse({
        food_detected: true,
        items: [],
        meal_days_ago: 40,
        meal_time: "25:00",
        meal_type: "brunch",
      }),
    );

    const { mealTime } = await analyzeMessage({ text: "банан" });

    expect(mealTime).toEqual({ daysAgo: 0, minutesOfDay: null, mealType: null });
  });

  it("сообщает Claude текущее время пользователя в его поясе", async () => {
    createMock.mockResolvedValue(toolUseResponse({ food_detected: false, items: [] }));

    await analyzeMessage({
      text: "вчера на ужин ел плов",
      now: new Date("2026-10-07T18:10:00Z"),
      timeZone: "Europe/Moscow",
    });

    const system = JSON.stringify(createMock.mock.calls[0][0].system);
    expect(system).toContain("среда, 7 октября 2026");
    expect(system).toContain("21:10");
  });

  it("ответ прокси 200 не в формате Anthropic — retryable FoodAnalyzerError, а не TypeError", async () => {
    createMock.mockResolvedValue({ choices: [] });

    await expect(analyzeMessage({ text: "банан" })).rejects.toMatchObject({
      name: "FoodAnalyzerError",
      retryable: true,
    });
  });
});
