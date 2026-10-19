import type Anthropic from "@anthropic-ai/sdk";
import { classifyApiError, createMessage } from "./client.js";
import { FoodAnalyzerError } from "../ai/foodAnalyzer.js";
import type { AnalyzeFoodInput, AnalyzeFoodResult, FoodItem } from "../ai/foodAnalyzer.js";
import { portionNutrition } from "../nutrition/calculations.js";
import { FOOD_ANALYSIS_TOOL, SYSTEM_PROMPT } from "./prompts.js";

export interface AnalyzeFoodToolItem {
  name: string;
  estimated_weight_g: number;
  kcal_100g: number;
  protein_100g: number;
  fat_100g: number;
  carb_100g: number;
  brand?: string;
  search_query?: string;
}

interface AnalyzeFoodToolInput {
  food_detected: boolean;
  items?: AnalyzeFoodToolItem[];
  notes?: string;
}

export async function analyzeFood(input: AnalyzeFoodInput): Promise<AnalyzeFoodResult> {
  const images = input.images ?? [];
  if (images.length === 0 && !input.text) {
    throw new Error("analyzeFood: нужно передать фото или text");
  }

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = images.map(
    (image) => ({
      type: "image",
      source: { type: "base64", media_type: image.mimeType, data: image.imageBase64 },
    }),
  );
  if (input.text) {
    content.push({ type: "text", text: input.text });
  }

  const response = await createMessage({
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    tools: [FOOD_ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: FOOD_ANALYSIS_TOOL.name },
    messages: [{ role: "user", content }],
  }).catch((err: unknown) => {
    throw toFoodAnalyzerError(err, "photo");
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse && response.stop_reason === "max_tokens") {
    throw new FoodAnalyzerError(
      "Сервис распознавания еды не успел сформировать ответ. Попробуйте ещё раз.",
      { retryable: true },
    );
  }
  if (!toolUse) {
    throw new Error(
      `Claude не вернул структурированный ответ через analyze_food (stop_reason: ${response.stop_reason})`,
    );
  }

  return mapToolInput(toolUse.input as AnalyzeFoodToolInput);
}

function mapToolInput(raw: AnalyzeFoodToolInput): AnalyzeFoodResult {
  return {
    foodDetected: raw.food_detected,
    items: (raw.items ?? []).map(mapItem),
    notes: raw.notes ?? null,
  };
}

// Модель отдаёт КБЖУ на 100 г, порцию по весу считает бот (portionNutrition).
export function mapItem(item: AnalyzeFoodToolItem): FoodItem {
  const per100g = {
    kcal: item.kcal_100g,
    proteinG: item.protein_100g,
    fatG: item.fat_100g,
    carbG: item.carb_100g,
  };
  if (
    typeof item.name !== "string" ||
    !Number.isFinite(item.estimated_weight_g) ||
    item.estimated_weight_g < 0 ||
    !Object.values(per100g).every((value) => Number.isFinite(value) && value >= 0)
  ) {
    throw new Error(
      `analyzeFood: Claude вернул некорректный продукт: ${JSON.stringify(item)}`,
    );
  }

  const brand = nonEmptyString(item.brand);
  const searchQuery = nonEmptyString(item.search_query);
  return {
    name: item.name,
    estimatedWeightG: item.estimated_weight_g,
    ...portionNutrition(per100g, item.estimated_weight_g, item.name),
    ...(brand ? { brand, searchQuery: searchQuery ?? `${brand} ${item.name}` } : {}),
  };
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// Что распознавали — от этого зависит, что предложить отправить заново: фото еды или
// текст/голос, где могут быть и еда, и тренировки.
export type AnalyzedInput = "photo" | "message";

const RETRY_HINT: Record<AnalyzedInput, string> = {
  photo: "Попробуйте отправить фото ещё раз через пару минут.",
  message: "Попробуйте отправить сообщение ещё раз через пару минут.",
};

export function toFoodAnalyzerError(err: unknown, input: AnalyzedInput): FoodAnalyzerError {
  switch (classifyApiError(err)) {
    case "unavailable":
      return new FoodAnalyzerError(
        `Сервис распознавания сейчас перегружен или недоступен. ${RETRY_HINT[input]}`,
        { retryable: true, cause: err },
      );
    case "timeout":
      // Сюда попадают и таймауты, и любые 5xx — это сбой на стороне сервиса.
      return new FoodAnalyzerError(
        `Сервис распознавания не ответил — похоже, он перегружен. ${RETRY_HINT[input]}`,
        { retryable: true, cause: err },
      );
    default:
      return new FoodAnalyzerError(
        input === "photo"
          ? "Не получилось получить ответ от сервиса распознавания. Попробуйте другое фото или описание."
          : "Не получилось получить ответ от сервиса распознавания. Попробуйте описать иначе.",
        { retryable: false, cause: err },
      );
  }
}
