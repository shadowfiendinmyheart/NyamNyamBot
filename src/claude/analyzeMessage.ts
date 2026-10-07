import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { FoodAnalyzerError } from "../ai/foodAnalyzer.js";
import type {
  AnalyzeMessageInput,
  AnalyzeMessageResult,
  ExerciseEstimate,
  WorkoutEstimate,
} from "../ai/messageAnalyzer.js";
import { MEAL_TYPES, type MealType } from "../db/meals.js";
import { normalizeDaysAgo } from "../utils/mealTime.js";
import {
  MAX_WORKOUT_MIN,
  WORKOUT_ACTIVITY_TYPES,
  WORKOUT_INTENSITIES,
  type WorkoutActivityType,
  type WorkoutIntensity,
} from "../nutrition/calculations.js";
import { getClient, THINKING_DISABLED } from "./client.js";
import { mapItem, toFoodAnalyzerError, type AnalyzeFoodToolItem } from "./analyzeFood.js";
import { DIARY_ENTRY_SYSTEM_PROMPT, DIARY_ENTRY_TOOL } from "./prompts.js";

interface DiaryEntryToolExercise {
  name: string;
  sets?: number;
  reps?: number;
  weight_kg?: number;
  duration_sec?: number;
}

interface DiaryEntryToolWorkout {
  activity_type: string;
  name: string;
  duration_min: number;
  duration_estimated?: boolean;
  intensity: string;
  exercises?: DiaryEntryToolExercise[];
}

interface DiaryEntryToolInput {
  food_detected: boolean;
  items?: AnalyzeFoodToolItem[];
  notes?: string;
  meal_days_ago?: number;
  meal_time?: string;
  meal_type?: string;
  workouts?: DiaryEntryToolWorkout[];
}

export async function analyzeMessage({
  text,
  now,
  timeZone,
}: AnalyzeMessageInput): Promise<AnalyzeMessageResult> {
  const system: Anthropic.TextBlockParam[] = [{ type: "text", text: DIARY_ENTRY_SYSTEM_PROMPT }];
  if (now && timeZone) {
    system.push({ type: "text", text: `Сейчас у пользователя: ${formatLocalNow(now, timeZone)}.` });
  }

  const response = await getClient()
    .messages.create({
      model: config.anthropicModel,
      max_tokens: 16000,
      system,
      tools: [DIARY_ENTRY_TOOL],
      tool_choice: { type: "tool", name: DIARY_ENTRY_TOOL.name },
      messages: [{ role: "user", content: text }],
      ...THINKING_DISABLED,
    })
    .catch((err: unknown) => {
      throw toFoodAnalyzerError(err, "message");
    });

  const toolUse = response.content.find(
    (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
  );
  if (!toolUse && response.stop_reason === "max_tokens") {
    throw new FoodAnalyzerError(
      "Сервис распознавания не успел сформировать ответ. Попробуйте ещё раз.",
      { retryable: true },
    );
  }
  if (!toolUse) {
    throw new Error("Claude не вернул структурированный ответ через log_diary_entry");
  }

  const raw = toolUse.input as DiaryEntryToolInput;
  return {
    food: {
      foodDetected: raw.food_detected,
      items: (raw.items ?? []).map(mapItem),
      notes: raw.notes ?? null,
    },
    mealTime: {
      daysAgo: normalizeDaysAgo(raw.meal_days_ago),
      minutesOfDay: parseClockTime(raw.meal_time),
      mealType: MEAL_TYPES.includes(raw.meal_type as MealType) ? (raw.meal_type as MealType) : null,
    },
    workouts: (raw.workouts ?? []).flatMap((workout) => {
      const mapped = mapWorkout(workout);
      return mapped ? [mapped] : [];
    }),
  };
}

// «вторник, 7 октября 2026 г., 21:10»
function formatLocalNow(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
}

// "09:00" → 540; некорректное время — null (запись встанет на время по умолчанию).
export function parseClockTime(value: unknown): number | null {
  const match = typeof value === "string" ? /^(\d{1,2}):(\d{2})$/.exec(value.trim()) : null;
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}

// Некорректная тренировка пропускается, а не роняет весь разбор: еда из того же
// сообщения всё равно должна записаться.
function mapWorkout(workout: DiaryEntryToolWorkout): WorkoutEstimate | undefined {
  const durationMin = Math.round(workout.duration_min);
  if (
    typeof workout.name !== "string" ||
    !workout.name.trim() ||
    !Number.isFinite(durationMin) ||
    durationMin < 1 ||
    durationMin > MAX_WORKOUT_MIN
  ) {
    console.warn(
      `analyzeMessage: пропускаю некорректную тренировку от Claude: ${JSON.stringify(workout)}`,
    );
    return undefined;
  }

  return {
    activityType: WORKOUT_ACTIVITY_TYPES.includes(workout.activity_type as WorkoutActivityType)
      ? (workout.activity_type as WorkoutActivityType)
      : "other",
    name: workout.name.trim(),
    durationMin,
    durationEstimated: workout.duration_estimated === true,
    intensity: WORKOUT_INTENSITIES.includes(workout.intensity as WorkoutIntensity)
      ? (workout.intensity as WorkoutIntensity)
      : "moderate",
    exercises: (workout.exercises ?? [])
      .filter((exercise) => typeof exercise.name === "string" && exercise.name.trim())
      .map(mapExercise),
  };
}

// Неправдоподобные или отсутствующие числа — null, а не ошибка: упражнение всё равно
// стоит сохранить хотя бы по названию.
function positiveOrNull(value: unknown, round: (n: number) => number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? round(value) : null;
}

function mapExercise(exercise: DiaryEntryToolExercise): ExerciseEstimate {
  return {
    name: exercise.name.trim().toLowerCase(),
    sets: positiveOrNull(exercise.sets, Math.round),
    reps: positiveOrNull(exercise.reps, Math.round),
    weightKg: positiveOrNull(exercise.weight_kg, (n) => Math.round(n * 10) / 10),
    durationSec: positiveOrNull(exercise.duration_sec, Math.round),
  };
}
