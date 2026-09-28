import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { FoodAnalyzerError } from "../ai/foodAnalyzer.js";
import type { AnalyzeFoodInput, AnalyzeFoodResult, FoodItem } from "../ai/foodAnalyzer.js";
import { FOOD_ANALYSIS_TOOL, SYSTEM_PROMPT } from "./prompts.js";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl,
    // При работе через сторонний прокси (ANTHROPIC_BASE_URL) официальный
    // User-Agent SDK ("Anthropic/JS ...") блокируется файрволом прокси (Cloudflare
    // 403 "Your request was blocked") — с прямым api.anthropic.com такой проблемы нет.
    ...(config.anthropicBaseUrl
      ? { defaultHeaders: { "User-Agent": "food-calculator-bot/1.0", "Authorization": `Bearer ${config.anthropicApiKey}` } }
      : {}),
  });
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

  const response = await getClient()
    .messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system: SYSTEM_PROMPT,
      tools: [FOOD_ANALYSIS_TOOL],
      tool_choice: { type: "tool", name: FOOD_ANALYSIS_TOOL.name },
      messages: [{ role: "user", content }],
      // Прокси может подменить модель (например, на claude-opus-4-8) и сам включить
      // thinking — тогда модель тратит весь max_tokens на рассуждения и не успевает
      // вызвать analyze_food. Отключаем явно; в типах SDK 0.32 этого поля ещё нет.
      ...({ thinking: { type: "disabled" } } as object),
    })
    .catch((err: unknown) => {
      throw toFoodAnalyzerError(err);
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
    console.error("DEBUG raw response:", JSON.stringify(response, null, 2));
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

// Прокси (ANTHROPIC_BASE_URL) время от времени не укладывается в свой собственный
// Cloudflare-таймаут на медленных vision-запросах (524 и подобные) — это внешняя
// перегрузка, а не баг в коде, и такие ошибки стоит явно помечать как временные,
// чтобы пользователь получил внятное "попробуйте чуть позже", а не сырой stack trace.
function toFoodAnalyzerError(err: unknown): FoodAnalyzerError {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError) {
    return new FoodAnalyzerError(
      "Сервис распознавания еды сейчас перегружен или недоступен. Попробуйте отправить фото ещё раз через пару минут.",
      { retryable: true, cause: err },
    );
  }
  if (err instanceof Anthropic.APIError && (err.status === undefined || err.status >= 500)) {
    return new FoodAnalyzerError(
      "Сервис распознавания еды не успел ответить вовремя (перегружен). Попробуйте отправить фото ещё раз через пару минут.",
      { retryable: true, cause: err },
    );
  }
  return new FoodAnalyzerError(
    "Не получилось получить ответ от сервиса распознавания еды. Попробуйте другое фото или описание.",
    { retryable: false, cause: err },
  );
}
