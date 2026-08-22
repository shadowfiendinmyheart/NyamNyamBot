import type Anthropic from "@anthropic-ai/sdk";

export const SYSTEM_PROMPT = `Ты — опытный нутрициолог-диетолог. Пользователь присылает фото еды и/или
текстовое описание того, что он съел. Твоя задача — определить состав приёма пищи и оценить
для каждого продукта/блюда вес порции (в граммах) и КБЖУ (калории, белки, жиры, углеводы).

Правила:
- Если вес порции не указан явно, оценивай его на глаз по фото или по типичным порциям для
  описанного блюда.
- Учитывай реалистичный способ приготовления (жарка на масле, соус и т.п.), если это видно
  на фото или следует из описания.
- Если на фото нет еды или текст не описывает еду, верни food_detected: false и объясни
  почему в notes.
- Верни результат строго через инструмент analyze_food, без текста вне вызова инструмента.`;

export const FOOD_ANALYSIS_TOOL: Anthropic.Tool = {
  name: "analyze_food",
  description:
    "Возвращает структурированную оценку состава и КБЖУ приёма пищи по фото и/или текстовому описанию.",
  input_schema: {
    type: "object",
    properties: {
      food_detected: {
        type: "boolean",
        description: "true, если на фото или в тексте есть еда, которую можно оценить",
      },
      items: {
        type: "array",
        description: "Список распознанных продуктов/блюд",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Название продукта или блюда" },
            estimated_weight_g: {
              type: "number",
              description: "Оценка веса порции в граммах",
            },
            kcal: { type: "number", description: "Калорийность порции, ккал" },
            protein_g: { type: "number", description: "Белки, г" },
            fat_g: { type: "number", description: "Жиры, г" },
            carb_g: { type: "number", description: "Углеводы, г" },
          },
          required: ["name", "estimated_weight_g", "kcal", "protein_g", "fat_g", "carb_g"],
        },
      },
      notes: {
        type: "string",
        description:
          "Комментарий: почему еда не распознана, либо на что стоит обратить внимание в оценке",
      },
    },
    required: ["food_detected", "items"],
  },
};
