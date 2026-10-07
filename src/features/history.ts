import { Bot, GrammyError, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { copyMeal, getMealById, getMealsForUserOnDate } from "../db/meals.js";
import { getProfileByUserId } from "../db/profiles.js";
import { getUserTimeZone } from "../db/users.js";
import { getWorkoutById, getWorkoutsBetween } from "../db/workouts.js";
import {
  addDays,
  diffDays,
  formatYmd,
  getDayBoundsUtc,
  getZonedYmd,
  parseYmd,
  type Ymd,
} from "../utils/dates.js";
import { determineMealType } from "../utils/mealTime.js";
import { shortLabel } from "../utils/text.js";
import {
  deletedEntries,
  deleteMealWithUndo,
  deleteWorkoutWithUndo,
  restoreDeletedEntry,
  UNDO_UNAVAILABLE_TEXT,
  type EntryKind,
} from "./deletedEntries.js";
import { buildStoredMealMessage, mealActionsKeyboard } from "./mealLogging.js";
import { buildTodayReport, formatShortDay } from "./reports.js";
import { buildStoredWorkoutMessage, workoutActionsKeyboard } from "./workout.js";
import { formatWorkoutLine } from "./workoutFormat.js";

type Db = BetterSQLite3Database<typeof schema>;

// История: «📋 Сегодня» и любой прошлый день кнопками ◀️ / ▶️. У каждой записи — свои
// кнопки с её номером в списке: ✏️ правка, 🗑 удаление (с «↩️ Вернуть»), 🔁 повтор еды.

export const PAST_DAY_EMPTY_HINT =
  "В этот день записей нет. Забыли что-то записать? Напишите, когда ели: «вчера на ужин " +
  "был плов».";

export function buildDayTitle(day: Ymd, today: Ymd): string {
  const daysAgo = diffDays(day, today);
  if (daysAgo === 0) return "📋 Сегодня";
  if (daysAgo === 1) return `📋 Вчера, ${formatShortDay(day)}`;
  return `📋 ${formatShortDay(day)}`;
}

// Кнопка «↩️ Вернуть» над записями — сразу после удаления из истории.
export interface UndoButton {
  kind: EntryKind;
  id: number;
  label: string;
}

export function dayViewKeyboard(
  day: Ymd,
  today: Ymd,
  mealIds: number[],
  workoutIds: number[],
  undo?: UndoButton,
): InlineKeyboard {
  const ymd = formatYmd(day);
  const keyboard = new InlineKeyboard();
  if (undo) {
    keyboard.text(`↩️ Вернуть «${undo.label}»`, `day_undo:${undo.kind}:${undo.id}:${ymd}`).row();
  }

  // Номера — как в тексте отчёта: сначала еда, потом тренировки.
  mealIds.forEach((id, index) => {
    const n = index + 1;
    keyboard
      .text(`✏️ ${n}`, `day_edit:meal:${id}`)
      .text(`🗑 ${n}`, `day_del:meal:${id}:${ymd}`)
      .text(`🔁 ${n}`, `day_rep:${id}:${ymd}`)
      .row();
  });
  workoutIds.forEach((id, index) => {
    const n = mealIds.length + index + 1;
    keyboard
      .text(`✏️ ${n}`, `day_edit:workout:${id}`)
      .text(`🗑 ${n}`, `day_del:workout:${id}:${ymd}`)
      .row();
  });

  const prev = addDays(day, -1);
  keyboard.text(`◀️ ${formatShortDay(prev)}`, `day:${formatYmd(prev)}`);
  const daysAgo = diffDays(day, today);
  if (daysAgo > 0) {
    const next = addDays(day, 1);
    keyboard.text(`${formatShortDay(next)} ▶️`, `day:${formatYmd(next)}`);
  }
  if (daysAgo > 1) keyboard.text("📋 Сегодня", `day:${formatYmd(today)}`);
  return keyboard;
}

export interface DayView {
  text: string;
  keyboard: InlineKeyboard;
}

// День в поясе пользователя: записи, итог, норма и кнопки. Будущие дни не показываем.
export function buildDayView(
  db: Db,
  userId: number,
  requestedDay: Ymd | undefined,
  now: Date,
  undo?: UndoButton,
): DayView {
  const timeZone = getUserTimeZone(db, userId);
  const today = getZonedYmd(now, timeZone);
  const day = requestedDay && diffDays(requestedDay, today) >= 0 ? requestedDay : today;

  const { start, end } = getDayBoundsUtc(day, timeZone);
  const meals = getMealsForUserOnDate(db, userId, start, end);
  const workouts = getWorkoutsBetween(db, userId, start, end);
  const profile = getProfileByUserId(db, userId);
  const isToday = diffDays(day, today) === 0;

  return {
    text: buildTodayReport(meals, timeZone, profile, buildDayTitle(day, today), workouts, {
      numbered: true,
      emptyHint: isToday ? undefined : PAST_DAY_EMPTY_HINT,
    }),
    keyboard: dayViewKeyboard(
      day,
      today,
      meals.map((meal) => meal.id),
      workouts.map((workout) => workout.id),
      undo,
    ),
  };
}

export async function sendDayView(ctx: MyContext, db: Db): Promise<void> {
  if (!ctx.from) return;
  const view = buildDayView(db, ctx.from.id, undefined, new Date());
  await ctx.reply(view.text, { reply_markup: view.keyboard });
}

// Повторное нажатие той же кнопки даёт «message is not modified» — это не ошибка.
async function showDayView(ctx: MyContext, view: DayView): Promise<void> {
  try {
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  } catch (err) {
    if (err instanceof GrammyError && err.description.includes("message is not modified")) return;
    throw err;
  }
}

function hasActiveConversation(ctx: MyContext): boolean {
  return Object.keys(ctx.conversation.active()).length > 0;
}

export function registerHistory(bot: Bot<MyContext>, db: Db): void {
  bot.command("today", async (ctx) => {
    await sendDayView(ctx, db);
  });

  bot.callbackQuery(/^day:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    await showDayView(ctx, buildDayView(db, ctx.from.id, parseYmd(ctx.match[1]), new Date()));
    await ctx.answerCallbackQuery();
  });

  // ✏️ из истории: присылаем запись отдельным сообщением с её обычными кнопками и сразу
  // начинаем правку — результат правки обновит это сообщение, а не историю.
  bot.callbackQuery(/^day_edit:(meal|workout):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const kind = ctx.match[1] as EntryKind;
    const id = Number(ctx.match[2]);

    // Любой идущий диалог перехватит ответ раньше правки — сначала его нужно закончить.
    if (hasActiveConversation(ctx)) {
      await ctx.answerCallbackQuery({
        text: "Сначала закончите текущий диалог или отправьте /cancel.",
        show_alert: true,
      });
      return;
    }

    if (kind === "meal") {
      const meal = getMealById(db, id, userId);
      if (!meal) {
        await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
        return;
      }
      await ctx.answerCallbackQuery();
      const card = await ctx.reply(
        buildStoredMealMessage(db, meal, getUserTimeZone(db, userId)),
        { reply_markup: mealActionsKeyboard(id) },
      );
      await ctx.conversation.enter("correction", id, card.chat.id, card.message_id);
      return;
    }

    const workout = getWorkoutById(db, id, userId);
    if (!workout) {
      await ctx.answerCallbackQuery({ text: "Тренировка не найдена.", show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    const card = await ctx.reply(buildStoredWorkoutMessage(db, workout), {
      reply_markup: workoutActionsKeyboard(id),
    });
    await ctx.conversation.enter("workoutEdit", id, card.chat.id, card.message_id);
  });

  bot.callbackQuery(/^day_del:(meal|workout):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from.id;
    const kind = ctx.match[1] as EntryKind;
    const id = Number(ctx.match[2]);

    const label =
      kind === "meal"
        ? deleteMealWithUndo(db, deletedEntries, id, userId)?.description
        : (() => {
            const workout = deleteWorkoutWithUndo(db, deletedEntries, id, userId);
            return workout ? formatWorkoutLine(workout) : undefined;
          })();
    if (label === undefined) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    const undo = { kind, id, label: shortLabel(label, 24) };
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[3]), new Date(), undo));
    await ctx.answerCallbackQuery({ text: "🗑 Удалено" });
  });

  bot.callbackQuery(/^day_undo:(meal|workout):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from.id;
    const restored = restoreDeletedEntry(
      db,
      deletedEntries,
      ctx.match[1] as EntryKind,
      Number(ctx.match[2]),
      userId,
    );
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[3]), new Date()));
    await ctx.answerCallbackQuery(
      restored ? { text: "↩️ Вернул" } : { text: UNDO_UNAVAILABLE_TEXT, show_alert: true },
    );
  });

  // 🔁 — та же еда ещё раз, сейчас: тип приёма пищи — по текущему времени.
  bot.callbackQuery(/^day_rep:(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from.id;
    const now = new Date();
    const timeZone = getUserTimeZone(db, userId);
    const newId = copyMeal(db, Number(ctx.match[1]), userId, {
      loggedAt: now,
      mealType: determineMealType(now, timeZone),
    });
    const meal = newId === undefined ? undefined : getMealById(db, newId, userId);
    if (!meal) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "🔁 Записал ещё раз" });
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[2]), now));
    await ctx.reply(`🔁 Записал ещё раз:\n\n${buildStoredMealMessage(db, meal, timeZone, now)}`, {
      reply_markup: mealActionsKeyboard(meal.id),
    });
  });

  // «↩️ Вернуть» под сообщением «🗑 Запись удалена» — сообщение снова становится записью.
  bot.callbackQuery(/^undo:(meal|workout):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const restored = restoreDeletedEntry(
      db,
      deletedEntries,
      ctx.match[1] as EntryKind,
      Number(ctx.match[2]),
      userId,
    );
    if (!restored) {
      await ctx.answerCallbackQuery({ text: UNDO_UNAVAILABLE_TEXT, show_alert: true });
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
      return;
    }

    if (restored.kind === "meal") {
      await ctx.editMessageText(
        buildStoredMealMessage(db, restored.meal, getUserTimeZone(db, userId)),
        { reply_markup: mealActionsKeyboard(restored.meal.id) },
      );
    } else {
      await ctx.editMessageText(buildStoredWorkoutMessage(db, restored.workout), {
        reply_markup: workoutActionsKeyboard(restored.workout.id),
      });
    }
    await ctx.answerCallbackQuery({ text: "↩️ Вернул" });
  });
}
