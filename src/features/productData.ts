import type { AnalyzeFoodResult, FoodItem } from "../ai/foodAnalyzer.js";
import { lookupProduct, type ProductLookup } from "../ai/productLookup.js";
import { portionNutrition } from "../nutrition/calculations.js";

// Брендовые продукты из оценки ИИ уточняются по базе продуктов: КБЖУ на 100 г из базы,
// вес — как оценил ИИ, порция пересчитывается. Нет уверенного совпадения, база
// недоступна или КБЖУ назвал сам пользователь (этикетка) — остаётся оценка ИИ.
export async function enrichWithProductData(
  items: FoodItem[],
  lookup: ProductLookup = lookupProduct,
): Promise<FoodItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (!item.brand || !item.searchQuery || item.statedPer100g || item.nutritionSource) {
        return item;
      }
      const product = await lookup(item.searchQuery, item.brand).catch(() => null);
      if (!product) return item;
      return {
        ...item,
        ...portionNutrition(product.per100g, item.estimatedWeightG, item.name),
        nutritionSource: product.source,
      };
    }),
  );
}

export async function enrichResultWithProductData(
  result: AnalyzeFoodResult,
  lookup: ProductLookup = lookupProduct,
): Promise<AnalyzeFoodResult> {
  if (!result.foodDetected || result.items.length === 0) return result;
  return { ...result, items: await enrichWithProductData(result.items, lookup) };
}
