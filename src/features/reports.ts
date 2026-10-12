import { sumNutrition, type MealRow } from "../db/meals.js";
import type { DaySummary, DietVerdict, PeriodComment } from "../ai/coach.js";
import type { WeightLogRow } from "../db/weightLog.js";
import { sumBurnedKcal, type WorkoutEntry } from "../db/workouts.js";
import {
  dayKcalTarget,
  type ActivityLevel,
  type NutritionTargets,
} from "../nutrition/calculations.js";
import { parseYmd, weekdayOf, type Ymd } from "../utils/dates.js";
import { MEAL_TYPE_LABEL } from "./mealLogging.js";
import { formatExercise, formatWorkoutLine, workoutNotAddedNote } from "./workoutFormat.js";

export const EMPTY_TODAY_HINT =
  "Записей пока нет. Пришлите фото еды или опишите, что съели, — текстом или голосом, " +
  "а я посчитаю КБЖУ 🐾";

function formatTargets(targets: NutritionTargets): string {
  return (
    `${targets.dailyKcalTarget} ккал | Б ${targets.proteinGTarget.toFixed(1)} ` +
    `Ж ${targets.fatGTarget.toFixed(1)} У ${targets.carbGTarget.toFixed(1)}`
  );
}

export interface DayReportOptions {
  // Нумерация записей («1.», «2.») — для истории, где у каждой записи свои кнопки
  // с этим номером. Тренировки нумеруются после еды.
  numbered?: boolean;
  // Что сказать про день без записей (по умолчанию — подсказка для «сегодня»).
  emptyHint?: string;
}

// targets — обычно профиль целиком: по activityLevel решается, добавлять ли расход
// тренировок к норме (см. workoutKcalBonus).
export function buildTodayReport(
  meals: MealRow[],
  timeZone: string,
  targets?: NutritionTargets & { activityLevel?: ActivityLevel },
  title = "📋 Сегодня",
  workouts: WorkoutEntry[] = [],
  options: DayReportOptions = {},
): string {
  if (meals.length === 0 && workouts.length === 0) {
    const parts = [title, "", options.emptyHint ?? EMPTY_TODAY_HINT];
    if (targets) parts.push("", `Норма на день: ${formatTargets(targets)}`);
    return parts.join("\n");
  }
  const marker = (index: number) => (options.numbered ? `${index + 1}.` : "•");

  const totals = sumNutrition(meals);
  const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });

  const parts = [title, ""];

  if (meals.length > 0) {
    const lines = meals.map((meal, index) => {
      const time = timeFormatter.format(meal.loggedAt);
      return (
        `${marker(index)} ${time} ${MEAL_TYPE_LABEL[meal.mealType]} — ${meal.description}: ${meal.kcal} ккал ` +
        `(Б ${meal.proteinG.toFixed(1)} / Ж ${meal.fatG.toFixed(1)} / У ${meal.carbG.toFixed(1)})`
      );
    });
    parts.push(
      ...lines,
      "",
      `Итого: ${totals.kcal} ккал | Б ${totals.proteinG.toFixed(1)} ` +
        `Ж ${totals.fatG.toFixed(1)} У ${totals.carbG.toFixed(1)}`,
    );
  } else {
    parts.push("Приёмов пищи пока нет.");
  }

  const burnedKcal = sumBurnedKcal(workouts);
  if (workouts.length > 0) {
    parts.push(
      "",
      "🏃 Тренировки:",
      ...workouts.map((workout, index) => {
        const line =
          `${marker(meals.length + index)} ${timeFormatter.format(workout.performedAt)} ${formatWorkoutLine(workout)}: ` +
          `~${workout.kcalBurned} ккал`;
        return workout.exercises.length > 0
          ? `${line}\n   ${workout.exercises.map(formatExercise).join(", ")}`
          : line;
      }),
      `Сожжено на тренировках: ${burnedKcal} ккал`,
    );
  }

  if (targets) {
    const dayTarget = dayKcalTarget(targets.dailyKcalTarget, targets.activityLevel, burnedKcal);
    const bonus = dayTarget - targets.dailyKcalTarget;
    const remainingKcal = dayTarget - totals.kcal;
    if (workouts.length > 0) parts.push("");
    parts.push(`Норма: ${formatTargets(targets)}`);
    if (bonus > 0) {
      parts.push(`Норма с учётом тренировок: ${dayTarget} ккал (+${bonus})`);
    }
    parts.push(
      remainingKcal >= 0
        ? `Осталось: ${remainingKcal} ккал`
        : `Превышение: ${-remainingKcal} ккал`,
    );
    if (burnedKcal > 0 && bonus === 0 && targets.activityLevel) {
      parts.push("", workoutNotAddedNote(targets.activityLevel));
    }
  }

  return parts.join("\n");
}

const VERDICT_EMOJI: Record<DietVerdict, string> = {
  green: "🟢",
  yellow: "🟡",
  red: "🔴",
};

// Оценка Ням-Ням под сводкой и недельным отчётом: светофор по составу рациона и совет.
// Без светофора — записей было мало для оценки.
export function formatPeriodComment(comment: PeriodComment): string {
  const icon = comment.verdict ? VERDICT_EMOJI[comment.verdict] : "🐱";
  const head = `${icon} Ням-Ням: ${comment.summary}`;
  return comment.advice ? `${head}\n💡 ${comment.advice}` : head;
}

const WEEKDAY_SHORT = ["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"];

// «Пн 06.10».
export function formatShortDay(ymd: Ymd): string {
  const dm = `${String(ymd.day).padStart(2, "0")}.${String(ymd.month).padStart(2, "0")}`;
  return `${WEEKDAY_SHORT[weekdayOf(ymd)]} ${dm}`;
}

function formatDayLabel(date: string): string {
  const ymd = parseYmd(date);
  return ymd ? formatShortDay(ymd) : date;
}

function formatSignedKg(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "без изменений";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded)} кг`;
}

// days — все дни недели по порядку (в т.ч. пустые), weights — записи веса за неделю
// по возрастанию времени.
export function buildWeeklyReport(
  days: DaySummary[],
  targets: NutritionTargets | undefined,
  weights: Pick<WeightLogRow, "weightKg">[],
): string {
  const title =
    days.length > 0
      ? `📊 Неделя ${formatDayLabel(days[0].date).slice(3)}–${formatDayLabel(days.at(-1)!.date).slice(3)}`
      : "📊 Неделя";

  const dayLines = days.map((day) => {
    const food =
      day.meals.length > 0
        ? `• ${formatDayLabel(day.date)} — ${day.totals.kcal} ккал`
        : `• ${formatDayLabel(day.date)} — нет записей`;
    return day.workouts.length > 0 ? `${food}, 🏃 ~${day.burnedKcal} ккал` : food;
  });

  const logged = days.filter((day) => day.meals.length > 0);
  const parts = [title, "", ...dayLines, "", `Дней с записями: ${logged.length} из ${days.length}`];

  const workoutCount = days.reduce((sum, day) => sum + day.workouts.length, 0);
  const burnedKcal = days.reduce((sum, day) => sum + day.burnedKcal, 0);
  parts.push(
    workoutCount > 0
      ? `🏃 Тренировок: ${workoutCount}, сожжено ~${burnedKcal} ккал`
      : "🏃 Тренировок за неделю не записано — просто опишите тренировку: «бег 40 минут»",
  );

  if (logged.length > 0) {
    const sum = sumNutrition(logged.map((day) => day.totals));
    const avg = {
      kcal: Math.round(sum.kcal / logged.length),
      proteinG: sum.proteinG / logged.length,
      fatG: sum.fatG / logged.length,
      carbG: sum.carbG / logged.length,
    };
    parts.push(
      `В среднем за день: ${avg.kcal} ккал | Б ${avg.proteinG.toFixed(1)} ` +
        `Ж ${avg.fatG.toFixed(1)} У ${avg.carbG.toFixed(1)}`,
    );
    if (targets) {
      const diff = avg.kcal - targets.dailyKcalTarget;
      parts.push(
        `Норма: ${targets.dailyKcalTarget} ккал | Б ${targets.proteinGTarget.toFixed(1)} ` +
          `Ж ${targets.fatGTarget.toFixed(1)} У ${targets.carbGTarget.toFixed(1)}`,
        diff === 0
          ? "Точно в норму"
          : diff > 0
            ? `В среднем выше нормы на ${diff} ккал в день`
            : `В среднем ниже нормы на ${-diff} ккал в день`,
      );
    }
  }

  parts.push("");
  if (weights.length === 0) {
    parts.push("⚖️ Вес за неделю не записывали — просто пришлите число, например «78.5»");
  } else if (weights.length === 1) {
    parts.push(`⚖️ Вес: ${weights[0].weightKg} кг (одна запись за неделю)`);
  } else {
    const first = weights[0].weightKg;
    const last = weights.at(-1)!.weightKg;
    parts.push(`⚖️ Вес: ${first} → ${last} кг (${formatSignedKg(last - first)})`);
  }

  return parts.join("\n");
}
