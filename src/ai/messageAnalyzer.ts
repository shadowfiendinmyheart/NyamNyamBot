import type { WorkoutActivityType, WorkoutIntensity } from "../nutrition/calculations.js";
import type { AnalyzeFoodResult } from "./foodAnalyzer.js";

// Контракт разбора текстового/голосового сообщения для дневника: в одном сообщении
// может быть еда, тренировка или и то и другое («бегал 40 минут, потом съел банан»).
// Ошибки — FoodAnalyzerError из ./foodAnalyzer.js.

// Упражнение силовой тренировки; null — пользователь этого не назвал.
export interface ExerciseEstimate {
  name: string; // «подтягивания», в нижнем регистре
  sets: number | null;
  reps: number | null; // повторений в подходе
  weightKg: number | null; // рабочий вес; null — свой вес
  durationSec: number | null; // для статики: планка 3×60 с
}

export interface WorkoutEstimate {
  activityType: WorkoutActivityType;
  name: string; // как назвать активность пользователю: «бег», «теннис»
  durationMin: number; // целые минуты, > 0
  durationEstimated: boolean; // true — длительность не названа и оценена ИИ
  intensity: WorkoutIntensity;
  exercises: ExerciseEstimate[]; // пусто для кардио без упражнений
}

export interface AnalyzeMessageResult {
  food: AnalyzeFoodResult;
  workouts: WorkoutEstimate[];
}

export type MessageAnalyzer = (input: { text: string }) => Promise<AnalyzeMessageResult>;

// Единственная точка переключения провайдера ИИ, как в foodAnalyzer.ts.
export { analyzeMessage } from "../claude/analyzeMessage.js";
