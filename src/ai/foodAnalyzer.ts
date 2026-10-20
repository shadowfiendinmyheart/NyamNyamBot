export type ImageMimeType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface FoodImage {
  imageBase64: string;
  mimeType: ImageMimeType;
}

// images — фото одного приёма пищи (альбом — несколько фото, например суп и второе).
export interface AnalyzeFoodInput {
  images?: FoodImage[];
  text?: string;
  // Зачем пользователь ведёт дневник (profiles.motivation) — для goalTip.
  motivation?: string;
}

export interface FoodItem {
  name: string;
  estimatedWeightG: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
  // Производитель и запрос для поиска продукта в базе (только у продуктов с брендом) —
  // по ним уточняются КБЖУ на 100 г. В БД не хранятся.
  brand?: string;
  searchQuery?: string;
  // КБЖУ на 100 г назвал пользователь или они видны на этикетке — в базе не уточняются.
  statedPer100g?: boolean;
  // Откуда КБЖУ на 100 г; нет — оценка ИИ.
  nutritionSource?: NutritionSource;
}

export type NutritionSource = "openfoodfacts";

export interface AnalyzeFoodResult {
  foodDetected: boolean;
  items: FoodItem[];
  notes: string | null;
  // Одна короткая фраза о пользе приёма пищи для цели пользователя; нет — цель не
  // задана (или запись старше этой фичи, или состав поправлен в разговоре с Ням-Ням).
  goalTip?: string;
}

export type FoodAnalyzer = (input: AnalyzeFoodInput) => Promise<AnalyzeFoodResult>;

// Провайдер-независимая ошибка анализа еды: reply-текст для пользователя уже готов
// на русском, а `retryable` подсказывает, стоит ли предложить повторить попытку.
// Позволяет остальному коду не знать про конкретные классы ошибок Anthropic SDK.
export class FoodAnalyzerError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "FoodAnalyzerError";
    this.retryable = options.retryable;
  }
}

// Единственная точка переключения провайдера ИИ: остальной код зовёт analyzeFood
// отсюда, а не из ../claude/analyzeFood.js напрямую. Чтобы сменить ИИ-API — заменить
// эту реализацию на новую, реализующую тот же FoodAnalyzer.
export { analyzeFood } from "../claude/analyzeFood.js";
