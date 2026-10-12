import type Anthropic from "@anthropic-ai/sdk";
import { classifyApiError, createMessage } from "./client.js";
import { FoodAnalyzerError } from "../ai/foodAnalyzer.js";
import type { AnalyzeFoodInput, AnalyzeFoodResult, FoodItem } from "../ai/foodAnalyzer.js";
import { FOOD_ANALYSIS_TOOL, SYSTEM_PROMPT } from "./prompts.js";

export interface AnalyzeFoodToolItem {
  name: string;
  estimated_weight_g: number;
  kcal: number;
  protein_g: number;
  fat_g: number;
  carb_g: number;
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

export function mapItem(item: AnalyzeFoodToolItem): FoodItem {
  if (
    typeof item.name !== "string" ||
    !Number.isFinite(item.estimated_weight_g) ||
    !Number.isFinite(item.kcal) ||
    !Number.isFinite(item.protein_g) ||
    !Number.isFinite(item.fat_g) ||
    !Number.isFinite(item.carb_g)
  ) {
    throw new Error(
      `analyzeFood: Claude вернул некорректный продукт: ${JSON.stringify(item)}`,
    );
  }

  return {
    name: item.name,
    estimatedWeightG: item.estimated_weight_g,
    kcal: Math.round(item.kcal),
    proteinG: roundToOneDecimal(item.protein_g),
    fatG: roundToOneDecimal(item.fat_g),
    carbG: roundToOneDecimal(item.carb_g),
  };
}

function roundToOneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
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
