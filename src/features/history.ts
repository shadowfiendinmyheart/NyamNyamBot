import { Bot, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import {
  FINISH_CONVERSATION_FIRST_TEXT,
  hasActiveConversation,
  type MyContext,
} from "../context.js";
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
import { determineMealType, MAX_MEAL_DAYS_AGO } from "../utils/mealTime.js";
import { isMessageNotModified } from "../utils/telegram.js";
import { shortLabel } from "../utils/text.js";
import {
  deletedEntries,
  deleteMealWithUndo,
  deleteWorkoutWithUndo,
  entryId,
  entryTime,
  isEntryInDiary,
  restoreDeletedEntry,
  UNDO_UNAVAILABLE_TEXT,
  type DeletedEntry,
  type DeletedEntryStore,
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
// Дальше MAX_MEAL_DAYS_AGO еду задним числом не записать — и подсказывать нечего.
export const OLD_DAY_EMPTY_HINT = "В этот день записей нет.";

// Сколько последних удалений дня показывать кнопками «↩️ Вернуть».
const MAX_UNDO_BUTTONS = 3;

export function buildDayTitle(day: Ymd, today: Ymd): string {
  const daysAgo = diffDays(day, today);
  if (daysAgo === 0) return "📋 Сегодня";
  if (daysAgo === 1) return `📋 Вчера, ${formatShortDay(day)}`;
  return `📋 ${formatShortDay(day)}`;
}

// Кнопка «↩️ Вернуть» над записями дня — для удалённой записи, которую ещё можно вернуть.
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
  undo: UndoButton[] = [],
): InlineKeyboard {
  const ymd = formatYmd(day);
  const keyboard = new InlineKeyboard();
  for (const button of undo) {
    keyboard
      .text(`↩️ Вернуть «${button.label}»`, `day_undo:${button.kind}:${button.id}:${ymd}`)
      .row();
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

function undoButton(entry: DeletedEntry): UndoButton {
  const label = entry.kind === "meal" ? entry.meal.description : formatWorkoutLine(entry.workout);
  return { kind: entry.kind, id: entryId(entry), label: shortLabel(label, 24) };
}

// День в поясе пользователя: записи, итог, норма и кнопки. Над записями — «↩️ Вернуть»
// для удалённых в этот день записей (последних MAX_UNDO_BUTTONS), которые ещё можно
// вернуть. Будущие дни не показываем.
export function buildDayView(
  db: Db,
  userId: number,
  requestedDay: Ymd | undefined,
  now: Date,
  store: DeletedEntryStore = deletedEntries,
): DayView {
  const timeZone = getUserTimeZone(db, userId);
  const today = getZonedYmd(now, timeZone);
  const day = requestedDay && diffDays(requestedDay, today) >= 0 ? requestedDay : today;
  const daysAgo = diffDays(day, today);

  const { start, end } = getDayBoundsUtc(day, timeZone);
  const meals = getMealsForUserOnDate(db, userId, start, end);
  const workouts = getWorkoutsBetween(db, userId, start, end);
  const profile = getProfileByUserId(db, userId);
  const undo = store
    .listForUser(userId)
    .filter((entry) => entryTime(entry) >= start && entryTime(entry) < end)
    .slice(0, MAX_UNDO_BUTTONS)
    .map(undoButton);

  return {
    text: buildTodayReport(meals, timeZone, profile, buildDayTitle(day, today), workouts, {
      numbered: true,
      emptyHint:
        daysAgo === 0
          ? undefined
          : daysAgo <= MAX_MEAL_DAYS_AGO
            ? PAST_DAY_EMPTY_HINT
            : OLD_DAY_EMPTY_HINT,
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
    if (isMessageNotModified(err)) return;
    throw err;
  }
}

type RestoreOutcome = "restored" | "alreadyRestored" | "unavailable" | "failed";

// «↩️ Вернуть». Повторное нажатие (запись уже вернули первым) — не ошибка: просить
// прислать запись заново тогда нельзя, получится дубль.
function restoreEntry(
  db: Db,
  kind: EntryKind,
  id: number,
  userId: number,
): { outcome: RestoreOutcome; entry?: DeletedEntry } {
  try {
    const entry = restoreDeletedEntry(db, deletedEntries, kind, id, userId);
    if (entry) return { outcome: "restored", entry };
  } catch (err) {
    console.error("Не удалось вернуть удалённую запись:", err);
    return { outcome: "failed" };
  }
  return { outcome: isEntryInDiary(db, kind, id, userId) ? "alreadyRestored" : "unavailable" };
}

function restoreAnswer(outcome: RestoreOutcome): { text: string; show_alert?: boolean } {
  switch (outcome) {
    case "restored":
      return { text: "↩️ Вернула" };
    case "alreadyRestored":
      return { text: "Запись уже на месте" };
    case "unavailable":
      return { text: UNDO_UNAVAILABLE_TEXT, show_alert: true };
    case "failed":
      return { text: "Не получилось вернуть запись, попробуйте ещё раз.", show_alert: true };
  }
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

    if (hasActiveConversation(ctx)) {
      await ctx.answerCallbackQuery({ text: FINISH_CONVERSATION_FIRST_TEXT, show_alert: true });
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
    const id = Number(ctx.match[2]);
    const deleted =
      ctx.match[1] === "meal"
        ? deleteMealWithUndo(db, deletedEntries, id, userId)
        : deleteWorkoutWithUndo(db, deletedEntries, id, userId);
    if (!deleted) {
      await ctx.answerCallbackQuery({ text: "Запись не найдена.", show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery({ text: "🗑 Удалено" });
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[3]), new Date()));
  });

  bot.callbackQuery(/^day_undo:(meal|workout):(\d+):(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const userId = ctx.from.id;
    const { outcome } = restoreEntry(db, ctx.match[1] as EntryKind, Number(ctx.match[2]), userId);
    await ctx.answerCallbackQuery(restoreAnswer(outcome));
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[3]), new Date()));
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

    await ctx.answerCallbackQuery({ text: "🔁 Записала ещё раз" });
    await showDayView(ctx, buildDayView(db, userId, parseYmd(ctx.match[2]), now));
    await ctx.reply(`🔁 Записала ещё раз:\n\n${buildStoredMealMessage(db, meal, timeZone, now)}`, {
      reply_markup: mealActionsKeyboard(meal.id),
    });
  });

  // «↩️ Вернуть» под сообщением «🗑 Запись удалена» — сообщение снова становится записью.
  bot.callbackQuery(/^undo:(meal|workout):(\d+)$/, async (ctx) => {
    const userId = ctx.from.id;
    const { outcome, entry } = restoreEntry(
      db,
      ctx.match[1] as EntryKind,
      Number(ctx.match[2]),
      userId,
    );
    await ctx.answerCallbackQuery(restoreAnswer(outcome));
    if (outcome === "unavailable") {
      await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    }
    // Уже вернули прошлым нажатием — сообщение и так снова запись с кнопками.
    if (!entry) return;

    if (entry.kind === "meal") {
      await ctx.editMessageText(
        buildStoredMealMessage(db, entry.meal, getUserTimeZone(db, userId)),
        { reply_markup: mealActionsKeyboard(entry.meal.id) },
      );
    } else {
      await ctx.editMessageText(buildStoredWorkoutMessage(db, entry.workout), {
        reply_markup: workoutActionsKeyboard(entry.workout.id),
      });
    }
  });
}
