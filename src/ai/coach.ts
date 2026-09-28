import type { MealType, NutritionTotals } from "../db/meals.js";
import type { ActivityLevel, Goal, NutritionTargets, Sex } from "../nutrition/calculations.js";

// Контракт личного коуча Ням-Ням. Как и в foodAnalyzer.ts, остальной код зовёт
// askCoach/commentOnPeriod отсюда и не знает про конкретного ИИ-провайдера, а
// провайдер не знает про БД — данные пользователя он читает через CoachDataSource.

export interface CoachMessage {
  role: "user" | "assistant";
  text: string;
}

export interface CoachMeal {
  time: string; // HH:MM в таймзоне пользователя
  mealType: MealType;
  description: string;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export interface DaySummary {
  date: string; // YYYY-MM-DD в таймзоне пользователя
  totals: NutritionTotals;
  meals: CoachMeal[];
}

export interface CoachMealItem {
  name: string;
  weightG: number;
  kcal: number;
  proteinG: number;
  fatG: number;
  carbG: number;
}

export interface DayMealItems {
  date: string;
  meals: Array<CoachMeal & { items: CoachMealItem[] }>;
}

export interface WeightEntry {
  date: string; // YYYY-MM-DD в таймзоне пользователя
  weightKg: number;
}

export interface CoachProfile {
  sex: Sex;
  age: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: Goal;
  bmrKcal: number;
  tdeeKcal: number;
  targets: NutritionTargets;
}

export interface CoachSnapshot {
  now: string; // локальные дата, время и день недели пользователя
  timeZone: string;
  profile: CoachProfile | null; // null — анкета не заполнена
  today: DaySummary;
  recentWeights: WeightEntry[]; // новые сверху
}

// Чтение данных одного пользователя. Методы бросают Error с понятным текстом на
// некорректные аргументы — провайдер передаёт его модели как ошибку инструмента.
export interface CoachDataSource {
  getSnapshot(): CoachSnapshot;
  getDailySummaries(from: string, to: string): DaySummary[];
  getMealItems(date: string): DayMealItems;
  getWeightHistory(limit: number): WeightEntry[];
}

export interface AskCoachInput {
  history: CoachMessage[];
  question: string;
  // С чего начался разговор (например, текст вечерней сводки из «Обсудить с Ням-Ням»).
  context?: string;
  dataSource: CoachDataSource;
}

export type PeriodKind = "day" | "week";

export interface CommentOnPeriodInput {
  kind: PeriodKind;
  snapshot: CoachSnapshot;
  summaries: DaySummary[];
}

export type AskCoach = (input: AskCoachInput) => Promise<string>;
export type CommentOnPeriod = (input: CommentOnPeriodInput) => Promise<string>;

// Как FoodAnalyzerError: текст для пользователя уже готов на русском.
export class CoachError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "CoachError";
    this.retryable = options.retryable;
  }
}

export { MAX_SUMMARY_DAYS } from "./coachLimits.js";

// Единственная точка переключения провайдера ИИ для коуча.
export { askCoach, commentOnPeriod } from "../claude/coach.js";
