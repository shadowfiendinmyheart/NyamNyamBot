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
