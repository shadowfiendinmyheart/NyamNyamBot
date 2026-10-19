import type { Nutrition } from "../nutrition/calculations.js";
import type { NutritionSource } from "./foodAnalyzer.js";

// Продукт из базы продуктов с КБЖУ на 100 г.
export interface ProductNutrition {
  name: string;
  brand: string;
  per100g: Nutrition;
  source: NutritionSource;
}

// query — «бренд + продукт», как на упаковке; brand — производитель. null — уверенного
// совпадения нет или база недоступна: тогда остаётся оценка ИИ. Не бросает.
export type ProductLookup = (query: string, brand: string) => Promise<ProductNutrition | null>;

// Единственная точка переключения базы продуктов, как analyzeFood в foodAnalyzer.ts.
export { lookupProduct } from "../openfoodfacts/lookup.js";
