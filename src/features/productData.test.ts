import { describe, expect, it, vi } from "vitest";
import type { FoodItem } from "../ai/foodAnalyzer.js";
import type { ProductLookup } from "../ai/productLookup.js";
import { enrichResultWithProductData, enrichWithProductData } from "./productData.js";

// Оценка ИИ из фидбэка: 102 ккал на 116 г при 63 ккал на 100 г по упаковке.
const yogurt: FoodItem = {
  name: "греческий йогурт",
  estimatedWeightG: 116,
  kcal: 102,
  proteinG: 6,
  fatG: 6,
  carbG: 6,
  brand: "Простоквашино",
  searchQuery: "Простоквашино йогурт греческий",
};
const soup: FoodItem = { name: "борщ", estimatedWeightG: 300, kcal: 150, proteinG: 6, fatG: 6, carbG: 18 };

const found: ProductLookup = async () => ({
  name: "Простоквашино ГРЕЧЕСКИЙ ГУСТОЙ ЙОГУРТ",
  brand: "Простоквашино",
  per100g: { kcal: 63, proteinG: 8.7, fatG: 2, carbG: 2.5 },
  source: "openfoodfacts",
});

describe("features/productData enrichWithProductData", () => {
  it("пересчитывает брендовый продукт по базе, вес — как у ИИ", async () => {
    const lookup = vi.fn(found);

    const [enriched, plain] = await enrichWithProductData([yogurt, soup], lookup);

    expect(enriched).toEqual({
      ...yogurt,
      kcal: 73,
      proteinG: 10.1,
      fatG: 2.3,
      carbG: 2.9,
      nutritionSource: "openfoodfacts",
    });
    expect(plain).toBe(soup);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(lookup).toHaveBeenCalledWith("Простоквашино йогурт греческий", "Простоквашино");
  });

  it("нет совпадения или база упала — остаётся оценка ИИ", async () => {
    expect(await enrichWithProductData([yogurt], async () => null)).toEqual([yogurt]);
    const failing: ProductLookup = async () => {
      throw new Error("network");
    };
    expect(await enrichWithProductData([yogurt], failing)).toEqual([yogurt]);
  });

  it("КБЖУ, названные пользователем или с этикетки, в базе не уточняются", async () => {
    const lookup = vi.fn(found);
    const stated = { ...yogurt, statedPer100g: true };

    expect(await enrichWithProductData([stated], lookup)).toEqual([stated]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("без распознанной еды базу не зовёт", async () => {
    const lookup = vi.fn(found);
    const result = { foodDetected: false, items: [], notes: "нет еды" };

    expect(await enrichResultWithProductData(result, lookup)).toBe(result);
    expect(lookup).not.toHaveBeenCalled();
  });
});
