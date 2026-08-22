import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import type { AnalyzeFoodInput, AnalyzeFoodResult, FoodItem } from "../ai/foodAnalyzer.js";
import { FOOD_ANALYSIS_TOOL, SYSTEM_PROMPT } from "./prompts.js";

const MODEL = "claude-sonnet-5";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  client ??= new Anthropic({ apiKey: config.anthropicApiKey });
  return client;
}

interface AnalyzeFoodToolItem {
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
  if (!input.imageBase64 && !input.text) {
    throw new Error("analyzeFood: нужно передать imageBase64 или text");
  }
  if (input.imageBase64 && !input.mimeType) {
    throw new Error("analyzeFood: для imageBase64 нужно передать mimeType");
  }

  const content: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> = [];
  if (input.imageBase64 && input.mimeType) {
    content.push({
      type: "image",
      source: {
        type: "base64",
        media_type: input.mimeType,
        data: input.imageBase64,
      },
    });
  }
  if (input.text) {
    content.push({ type: "text", text: input.text });
  }

  const response = await getClient().messages.create({
    model: MODEL,
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    tools: [FOOD_ANALYSIS_TOOL],
    tool_choice: { type: "tool", name: FOOD_ANALYSIS_TOOL.name },
    messages: [{ role: "user", content }],
  });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse) {
    throw new Error("Claude не вернул структурированный ответ через analyze_food");
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

function mapItem(item: AnalyzeFoodToolItem): FoodItem {
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
