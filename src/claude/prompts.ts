import type Anthropic from "@anthropic-ai/sdk";
import { WORKOUT_ACTIVITY_TYPES, WORKOUT_INTENSITIES } from "../nutrition/calculations.js";

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

export const DIARY_ENTRY_SYSTEM_PROMPT = `Ты — опытный нутрициолог-диетолог и фитнес-тренер. Пользователь
присылает текстовое (или расшифрованное голосовое) сообщение для дневника. В нём может
быть съеденная еда, физическая активность (тренировка, прогулка, спорт) или и то и другое.

Еда:
- Определи состав и оцени для каждого продукта/блюда вес порции (в граммах) и КБЖУ.
- Если вес порции не указан явно, оценивай его по типичным порциям для описанного блюда.
- Учитывай реалистичный способ приготовления (жарка на масле, соус и т.п.).
- Если еды в сообщении нет, верни food_detected: false и пустой items. Не упоминай в
  notes отсутствие еды, если в сообщении есть тренировка.

Тренировки:
- Каждую упомянутую активность верни отдельным элементом workouts. Калории НЕ считай —
  их посчитает бот по MET-таблице. Нужны только вид, длительность и интенсивность.
- activity_type: walking — ходьба, прогулка; running — бег; cycling — велосипед,
  велотренажёр; swimming — плавание; strength — силовая, тренажёрный зал; hiit —
  интервальная, кроссфит, круговая; yoga — йога, пилатес, растяжка; sports — игровые
  виды (футбол, баскетбол, теннис, единоборства); dancing — танцы; skiing — лыжи,
  коньки, сноуборд; other — всё остальное.
- intensity: low — легко, спокойно; moderate — обычный темп (по умолчанию); high —
  интенсивно, быстро, «выложился».
- Силовые упражнения одного сообщения (подтягивания, отжимания, приседания, жим,
  планка и т.п.) объединяй в ОДНУ тренировку strength (или hiit, если это круговая) и
  перечисли их в exercises: название в нижнем регистре, подходы, повторения в подходе,
  рабочий вес в кг (только если назван; для своего веса — не указывай), время для
  статики в секундах. «10 раз по 3 подхода» и «3×10» — это sets: 3, reps: 10. Если
  подходы не названы — sets не указывай.
- Кардио (бег, скакалка, велосипед и т.п.) — отдельными тренировками без exercises,
  даже если в том же сообщении есть силовые. Скакалка — hiit.
- Если длительность не названа, оцени типичную для такой активности и поставь
  duration_estimated: true. Для силовой считай ~2–3 минуты на подход с отдыхом.
- Планы и намерения («завтра пойду в зал») — не тренировка.

Верни результат строго через инструмент log_diary_entry, без текста вне вызова инструмента.`;

export const DIARY_ENTRY_TOOL: Anthropic.Tool = {
  name: "log_diary_entry",
  description:
    "Возвращает съеденную еду с оценкой КБЖУ и физическую активность из сообщения пользователя.",
  input_schema: {
    type: "object",
    properties: {
      ...(FOOD_ANALYSIS_TOOL.input_schema.properties as Record<string, unknown>),
      workouts: {
        type: "array",
        description: "Физическая активность из сообщения; пустой массив, если её нет",
        items: {
          type: "object",
          properties: {
            activity_type: { type: "string", enum: [...WORKOUT_ACTIVITY_TYPES] },
            name: {
              type: "string",
              description: "Короткое название по-русски, как у пользователя: «бег», «теннис»",
            },
            duration_min: { type: "number", description: "Длительность, минуты" },
            duration_estimated: {
              type: "boolean",
              description: "true, если длительность не названа и оценена",
            },
            intensity: { type: "string", enum: [...WORKOUT_INTENSITIES] },
            exercises: {
              type: "array",
              description: "Упражнения силовой тренировки; пусто для кардио",
              items: {
                type: "object",
                properties: {
                  name: { type: "string", description: "Название в нижнем регистре" },
                  sets: { type: "number", description: "Подходы" },
                  reps: { type: "number", description: "Повторений в подходе" },
                  weight_kg: { type: "number", description: "Рабочий вес, кг" },
                  duration_sec: { type: "number", description: "Время подхода для статики, с" },
                },
                required: ["name"],
              },
            },
          },
          required: ["activity_type", "name", "duration_min", "duration_estimated", "intensity"],
        },
      },
    },
    required: ["food_detected", "items", "workouts"],
  },
};
