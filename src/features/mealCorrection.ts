import { Bot, InlineKeyboard, type Api } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import type { AnalyzeFoodResult } from "../ai/foodAnalyzer.js";
import {
  getMealById,
  getMealItemsForMeals,
  updateMeal,
  type MealItemInput,
  mealItemRowsToInputs,
} from "../db/meals.js";
import { getUserTimeZone } from "../db/users.js";
import { buildStoredMealMessage, mealActionsKeyboard, toMealItemInputs } from "./mealLogging.js";

type Db = BetterSQLite3Database<typeof schema>;

// Правка записи еды новым составом — общая для диалога «✏️ Изменить» (correction.ts) и
// разговора с Ням-Ням о записи (coach/coach.ts). Бот показывает, как изменились
// калории, и даёт «↩️ Отменить правку»: ИИ мог понять сообщение не так.

interface CorrectionUndo {
  userId: number;
  mealId: number;
  previous: { items: MealItemInput[]; rawClaudeResponse: unknown };
  // Состав сразу после правки: отменить можно, только пока запись не меняли снова,
  // иначе отмена затёрла бы более позднюю правку.
  applied: MealItemInput[];
  // Сообщение с записью, из которого начали правку, — после отмены его тоже обновляем.
  sourceMessageId: number | null;
}

// Прежние составы для «↩️ Отменить правку»: в памяти процесса, не больше maxSize
// последних правок; после рестарта бота кнопка устаревает. Номера начинаются с
// текущего времени, чтобы кнопка, выданная до рестарта, не совпала с новой правкой.
export class CorrectionUndoStore {
  private readonly entries = new Map<number, CorrectionUndo>();
  private nextId: number;

  constructor(
    private readonly maxSize = 500,
    firstId = Date.now(),
  ) {
    this.nextId = firstId;
  }

  add(entry: CorrectionUndo): number {
    const id = this.nextId++;
    this.entries.set(id, entry);
    // Map хранит порядок вставки — первой идёт самая старая правка.
    while (this.entries.size > this.maxSize) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    return id;
  }

  // Одноразово: повторное нажатие (или чужая кнопка) ничего не вернёт.
  take(id: number, userId: number): CorrectionUndo | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.userId !== userId) return undefined;
    this.entries.delete(id);
    return entry;
  }

  get size(): number {
    return this.entries.size;
  }
}

export const correctionUndos = new CorrectionUndoStore();

// Только простые значения: из диалога (@grammyjs/conversations) функция зовётся через
// conversation.external, а его результат сохраняется для переигрывания.
export interface AppliedCorrection {
  mealId: number;
  // Запись после правки — текст исходного сообщения.
  entryText: string;
  // «✅ Обновила запись: было … ккал, стало …» и запись — отдельное сообщение.
  cardText: string;
  undoId: number;
}

function currentItems(db: Db, mealId: number): MealItemInput[] {
  return mealItemRowsToInputs(getMealItemsForMeals(db, [mealId]));
}

function sameItems(a: MealItemInput[], b: MealItemInput[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// Продукт, который правка не задела (то же название и те же ккал на 100 г), сохраняет
// источник КБЖУ: ИИ переносит его из записи без бренда, и повторно в базе он не ищется.
function keepNutritionSource(items: MealItemInput[], previous: MealItemInput[]): MealItemInput[] {
  const kcalPer100g = (item: MealItemInput) =>
    item.weightG > 0 ? (item.kcal * 100) / item.weightG : item.kcal;
  return items.map((item) => {
    if (item.nutritionSource) return item;
    const same = previous.find(
      (old) =>
        old.nutritionSource &&
        old.name.trim().toLowerCase() === item.name.trim().toLowerCase() &&
        Math.abs(kcalPer100g(old) - kcalPer100g(item)) <= 1,
    );
    return same ? { ...item, nutritionSource: same.nutritionSource } : item;
  });
}

export function buildCorrectionHeader(beforeKcal: number, afterKcal: number): string {
  return beforeKcal === afterKcal
    ? "✅ Обновила запись:"
    : `✅ Обновила запись: было ${beforeKcal} ккал, стало ${afterKcal}`;
}

// Сохраняет новый состав записи. undefined — записи нет (удалили) или она чужая;
// "unchanged" — состав тот же, что уже записан: сообщать и отменять нечего.
export function applyMealCorrection(
  db: Db,
  store: CorrectionUndoStore,
  input: {
    userId: number;
    mealId: number;
    result: AnalyzeFoodResult;
    sourceMessageId: number | null;
  },
): AppliedCorrection | "unchanged" | undefined {
  const { userId, mealId, result, sourceMessageId } = input;
  const changed = db.transaction(() => {
    const before = getMealById(db, mealId, userId);
    if (!before) return undefined;
    const previousItems = currentItems(db, mealId);
    const items = keepNutritionSource(toMealItemInputs(result.items), previousItems);
    if (sameItems(previousItems, items)) return "unchanged" as const;
    if (!updateMeal(db, mealId, userId, { items, rawClaudeResponse: result })) return undefined;
    const after = getMealById(db, mealId, userId);
    if (!after) return undefined;
    return { before, previousItems, after, appliedItems: currentItems(db, mealId) };
  });
  if (!changed || changed === "unchanged") return changed;

  const undoId = store.add({
    userId,
    mealId,
    previous: { items: changed.previousItems, rawClaudeResponse: changed.before.rawClaudeResponse },
    applied: changed.appliedItems,
    sourceMessageId,
  });
  // Из БД, а не из result: тип и день могли поменять кнопкой «🕐 Время», пока шла правка.
  const entryText = buildStoredMealMessage(db, changed.after, getUserTimeZone(db, userId));
  return {
    mealId,
    entryText,
    cardText: `${buildCorrectionHeader(changed.before.kcal, changed.after.kcal)}\n\n${entryText}`,
    undoId,
  };
}

export function correctionCardKeyboard(mealId: number, undoId: number): InlineKeyboard {
  return mealActionsKeyboard(mealId).row().text("↩️ Отменить правку", `undo_fix:${undoId}`);
}

// Обновляет исходное сообщение с записью и присылает обновлённую запись отдельным
// сообщением: исходное может быть далеко вверху чата, а результат должен быть виден сразу.
export async function publishMealCorrection(
  api: Api,
  chatId: number,
  applied: AppliedCorrection,
  sourceMessageId: number | null,
): Promise<void> {
  if (sourceMessageId !== null) {
    await api
      .editMessageText(chatId, sourceMessageId, applied.entryText, {
        reply_markup: mealActionsKeyboard(applied.mealId),
      })
      .catch((err: unknown) => console.error("Не удалось обновить исходное сообщение:", err));
  }
  await api.sendMessage(chatId, applied.cardText, {
    reply_markup: correctionCardKeyboard(applied.mealId, applied.undoId),
  });
}

export type UndoCorrectionResult =
  | { outcome: "undone"; mealId: number; entryText: string; sourceMessageId: number | null }
  // Запись меняли после этой правки — отмена затёрла бы более позднее изменение.
  | { outcome: "changed" }
  // Бот перезапускался, кнопку уже нажимали или запись удалили.
  | { outcome: "unavailable" };

export function undoMealCorrection(
  db: Db,
  store: CorrectionUndoStore,
  undoId: number,
  userId: number,
): UndoCorrectionResult {
  const entry = store.take(undoId, userId);
  if (!entry) return { outcome: "unavailable" };
  const { mealId } = entry;

  const restored = db.transaction(() => {
    if (!getMealById(db, mealId, userId)) return "unavailable" as const;
    if (!sameItems(currentItems(db, mealId), entry.applied)) return "changed" as const;
    if (!updateMeal(db, mealId, userId, entry.previous)) return "unavailable" as const;
    return getMealById(db, mealId, userId) ?? ("unavailable" as const);
  });

  if (restored === "unavailable") return { outcome: "unavailable" };
  if (restored === "changed") return { outcome: "changed" };
  return {
    outcome: "undone",
    mealId,
    entryText: buildStoredMealMessage(db, restored, getUserTimeZone(db, userId)),
    sourceMessageId: entry.sourceMessageId,
  };
}

export function withoutUndoButton(markup: InlineKeyboardMarkup): InlineKeyboardMarkup {
  return {
    inline_keyboard: markup.inline_keyboard
      .map((row) =>
        row.filter(
          (button) => !("callback_data" in button && button.callback_data.startsWith("undo_fix:")),
        ),
      )
      .filter((row) => row.length > 0),
  };
}

export const UNDO_CORRECTION_UNAVAILABLE_TEXT =
  "Отменить уже не получится — запись удалена, правка была давно или я перезапускалась.";
export const UNDO_CORRECTION_CHANGED_TEXT =
  "Запись уже меняли после этой правки — отменять не буду, чтобы не затереть новое. " +
  "Поправьте её ещё раз.";

export function registerMealCorrection(bot: Bot<MyContext>, db: Db): void {
  bot.callbackQuery(/^undo_fix:(\d+)$/, async (ctx) => {
    const result = undoMealCorrection(db, correctionUndos, Number(ctx.match[1]), ctx.from.id);
    if (result.outcome !== "undone") {
      await ctx.answerCallbackQuery({
        text:
          result.outcome === "changed"
            ? UNDO_CORRECTION_CHANGED_TEXT
            : UNDO_CORRECTION_UNAVAILABLE_TEXT,
        show_alert: true,
      });
      // Кнопка отмены больше не сработает (запись в хранилище уже израсходована) —
      // убираем её, остальные кнопки оставляем.
      const markup = ctx.callbackQuery.message?.reply_markup;
      if (markup) {
        await ctx
          .editMessageReplyMarkup({ reply_markup: withoutUndoButton(markup) })
          .catch(() => {});
      }
      return;
    }

    await ctx.answerCallbackQuery();
    const keyboard = { reply_markup: mealActionsKeyboard(result.mealId) };
    await ctx
      .editMessageText(`↩️ Вернула, как было:\n\n${result.entryText}`, keyboard)
      .catch((err: unknown) => console.error("Не удалось показать отменённую правку:", err));

    const chatId = ctx.chat?.id;
    const cardId = ctx.callbackQuery.message?.message_id;
    if (chatId !== undefined && result.sourceMessageId !== null && result.sourceMessageId !== cardId) {
      await ctx.api
        .editMessageText(chatId, result.sourceMessageId, result.entryText, keyboard)
        .catch((err: unknown) => console.error("Не удалось обновить исходное сообщение:", err));
    }
  });
}
