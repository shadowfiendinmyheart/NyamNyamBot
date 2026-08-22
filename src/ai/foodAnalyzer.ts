export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface AnalyzeFoodInput {
  imageBase64?: string;
  mimeType?: ImageMimeType;
  text?: string;
}

export interface FoodItem {
  name: string;
  estimatedWeightG: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export interface AnalyzeFoodResult {
  foodDetected: boolean;
  items: FoodItem[];
  notes: string | null;
}

export type FoodAnalyzer = (input: AnalyzeFoodInput) => Promise<AnalyzeFoodResult>;

// Единственная точка переключения провайдера ИИ: остальной код зовёт analyzeFood
// отсюда, а не из ../claude/analyzeFood.js напрямую. Чтобы сменить ИИ-API — заменить
// эту реализацию на новую, реализующую тот же FoodAnalyzer.
export { analyzeFood } from "../claude/analyzeFood.js";
