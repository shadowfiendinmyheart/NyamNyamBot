import { describe, expect, it } from "vitest";
import { mealTimeKeyboard } from "./mealTime.js";

describe("features/mealTime mealTimeKeyboard", () => {
  it("offers every meal type and day, marking the current ones", () => {
    const buttons = mealTimeKeyboard(42, "dinner", 1).inline_keyboard.flat();

    expect(buttons.map((b) => b.text)).toEqual([
      "🌅 Завтрак",
      "🍲 Обед",
      "✅ 🌙 Ужин",
      "🍎 Перекус",
      "Сегодня",
      "✅ Вчера",
      "◀️ Готово",
    ]);
    expect(buttons.map((b) => ("callback_data" in b ? b.callback_data : ""))).toEqual([
      "meal_set:42:type:breakfast",
      "meal_set:42:type:lunch",
      "meal_set:42:type:dinner",
      "meal_set:42:type:snack",
      "meal_set:42:day:0",
      "meal_set:42:day:1",
      "meal_time_done:42",
    ]);
  });

  it("marks no day for a meal older than yesterday", () => {
    const days = mealTimeKeyboard(1, "lunch", 3).inline_keyboard[2];
    expect(days?.map((b) => b.text)).toEqual(["Сегодня", "Вчера"]);
  });
});
