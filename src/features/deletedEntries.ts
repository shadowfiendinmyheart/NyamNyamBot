import { InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import {
  deleteMealForUser,
  getMealById,
  getMealItemsForMeals,
  restoreMeal,
  type MealItemRow,
  type MealRow,
} from "../db/meals.js";
import {
  deleteWorkoutForUser,
  getWorkoutById,
  restoreWorkout,
  type WorkoutEntry,
} from "../db/workouts.js";

type Db = BetterSQLite3Database<typeof schema>;

export type EntryKind = "meal" | "workout";

export type DeletedEntry =
  | { kind: "meal"; userId: number; meal: MealRow; items: MealItemRow[] }
  | { kind: "workout"; userId: number; workout: WorkoutEntry };

function entryId(entry: DeletedEntry): number {
  return entry.kind === "meal" ? entry.meal.id : entry.workout.id;
}

// Удалённые записи для кнопки «↩️ Вернуть»: копия строки целиком живёт здесь, в памяти
// процесса, не больше maxSize последних удалений; после рестарта бота вернуть уже нельзя.
// Ключ — id записи в БД: id не переиспользуются (AUTOINCREMENT), поэтому старая кнопка
// не вернёт чужую запись.
export class DeletedEntryStore {
  private readonly entries = new Map<string, DeletedEntry>();

  constructor(private readonly maxSize = 500) {}

  add(entry: DeletedEntry): void {
    const key = `${entry.kind}:${entryId(entry)}`;
    this.entries.delete(key);
    this.entries.set(key, entry);
    // Map хранит порядок вставки — первым идёт самое старое удаление.
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  // Одноразово: повторное нажатие «↩️ Вернуть» запись не задвоит.
  take(kind: EntryKind, id: number, userId: number): DeletedEntry | undefined {
    const key = `${kind}:${id}`;
    const entry = this.entries.get(key);
    if (!entry || entry.userId !== userId) return undefined;
    this.entries.delete(key);
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const deletedEntries = new DeletedEntryStore();

// Удаляет запись и запоминает её для «↩️ Вернуть». undefined — записи нет или она чужая.
export function deleteMealWithUndo(
  db: Db,
  store: DeletedEntryStore,
  mealId: number,
  userId: number,
): MealRow | undefined {
  return db.transaction(() => {
    const meal = getMealById(db, mealId, userId);
    if (!meal) return undefined;
    const items = getMealItemsForMeals(db, [meal.id]);
    if (!deleteMealForUser(db, mealId, userId)) return undefined;
    store.add({ kind: "meal", userId, meal, items });
    return meal;
  });
}

export function deleteWorkoutWithUndo(
  db: Db,
  store: DeletedEntryStore,
  workoutId: number,
  userId: number,
): WorkoutEntry | undefined {
  return db.transaction(() => {
    const workout = getWorkoutById(db, workoutId, userId);
    if (!workout) return undefined;
    if (!deleteWorkoutForUser(db, workoutId, userId)) return undefined;
    store.add({ kind: "workout", userId, workout });
    return workout;
  });
}

// Возвращает удалённую запись в дневник. undefined — вернуть нечего: уже вернули,
// бот перезапускался или запись чужая.
export function restoreDeletedEntry(
  db: Db,
  store: DeletedEntryStore,
  kind: EntryKind,
  id: number,
  userId: number,
): DeletedEntry | undefined {
  const entry = store.take(kind, id, userId);
  if (!entry) return undefined;
  try {
    if (entry.kind === "meal") restoreMeal(db, entry.meal, entry.items);
    else restoreWorkout(db, entry.workout);
  } catch (err) {
    // Не вышло — оставляем возможность нажать «↩️ Вернуть» ещё раз.
    store.add(entry);
    throw err;
  }
  return entry;
}

export const UNDO_UNAVAILABLE_TEXT =
  "Вернуть уже не получится — запись удалена давно или бот перезапускался. " +
  "Пришлите её заново.";

// Под сообщением «🗑 Запись удалена» — кнопка «↩️ Вернуть» (обработчик — в features/history.ts).
export function undoDeleteKeyboard(kind: EntryKind, id: number): InlineKeyboard {
  return new InlineKeyboard().text("↩️ Вернуть", `undo:${kind}:${id}`);
}
