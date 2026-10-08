import path from "node:path";
import { Bot, InlineKeyboard, type Api } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { getUserTimeZone } from "../db/users.js";
import type { MyContext } from "../context.js";
import {
  analyzeFood,
  FoodAnalyzerError,
  type AnalyzeFoodResult,
  type FoodImage,
  type FoodItem,
  type ImageMimeType,
} from "../ai/foodAnalyzer.js";
import { analyzeMessage } from "../ai/messageAnalyzer.js";
import { transcribeAudio, TranscriberError } from "../ai/transcriber.js";
import {
  createMeal,
  getMealItemsForMeals,
  joinPhotoFileIds,
  sumNutrition,
  type MealItemInput,
  type MealItemRow,
  type MealRow,
  type MealType,
} from "../db/meals.js";
import { determineMealType, formatMealDay, resolveMealTime } from "../utils/mealTime.js";
import { MediaGroupBuffer } from "../utils/mediaGroupBuffer.js";
import { downloadTelegramFile } from "../utils/telegram.js";
import { withChatAction } from "../utils/chatAction.js";
import { buildDayProgressLine } from "./dayProgress.js";
import { deleteMealWithUndo, deletedEntries, undoDeleteKeyboard } from "./deletedEntries.js";
import { shortLabel } from "../utils/text.js";
import { smallTalkReply } from "./smallTalk.js";
import { replyRecognizedWorkouts, saveRecognizedWorkouts } from "./workout.js";
import {
  buildVoiceConfirmMessage,
  COPY_TRANSCRIPT_HINT,
  settleVoiceConfirmation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
  type VoiceConfirmAction,
} from "./voiceConfirm.js";

const MIME_BY_EXT: Record<string, ImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function mimeTypeForFilePath(filePath: string): ImageMimeType {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? "image/jpeg";
}

type Db = BetterSQLite3Database<typeof schema>;

export const MEAL_TYPE_LABEL: Record<MealType, string> = {
  breakfast: "🌅 Завтрак",
  lunch: "🍲 Обед",
  dinner: "🌙 Ужин",
  snack: "🍎 Перекус",
};

// dayLabel — подпись дня для записи не за сегодня («вчера»), см. formatMealDay;
// progressLine — сколько съедено за день и сколько осталось (см. buildDayProgressLine).
export function buildMealMessage(
  mealType: MealType,
  items: FoodItem[],
  notes: string | null,
  dayLabel: string | null = null,
  progressLine: string | null = null,
): string {
  const totals = sumNutrition(items);

  const lines = items.map(
    (item) =>
      `• ${item.name} — ${item.estimatedWeightG} г: ${item.kcal} ккал ` +
      `(Б ${item.proteinG} / Ж ${item.fatG} / У ${item.carbG})`,
  );

  const parts = [
    dayLabel ? `${MEAL_TYPE_LABEL[mealType]} · ${dayLabel}` : MEAL_TYPE_LABEL[mealType],
    "",
    ...lines,
    "",
    `Итого: ${totals.kcal} ккал | Б ${totals.proteinG.toFixed(1)} ` +
      `Ж ${totals.fatG.toFixed(1)} У ${totals.carbG.toFixed(1)}`,
  ];

  if (progressLine) parts.push(progressLine);

  if (notes) {
    parts.push("", `⚠️ ${notes}`);
  }

  return parts.join("\n");
}

// Сообщение для сохранённой записи — сразу после записи, после смены времени или правки.
// Прогресс — за день записи: после переноса на вчера он считается по вчерашнему дню.
export function buildStoredMealMessage(
  db: Db,
  meal: MealRow,
  timeZone: string,
  now: Date = new Date(),
): string {
  const items = toFoodItems(getMealItemsForMeals(db, [meal.id]));
  const notes = (meal.rawClaudeResponse as { notes?: string | null } | null)?.notes ?? null;
  const dayLabel = formatMealDay(meal.loggedAt, now, timeZone);
  return buildMealMessage(
    meal.mealType,
    items,
    notes,
    dayLabel,
    buildDayProgressLine(db, meal.userId, meal.loggedAt, timeZone, dayLabel),
  );
}

interface LoggedMeal {
  mealId: number;
  userId: number;
  mealType: MealType;
  loggedAt: Date;
  result: AnalyzeFoodResult;
}

// Ответ на новую запись еды: оценка, прогресс за день записи и кнопки действий.
// Подпись дня — относительно момента ответа, а не исходного сообщения.
async function replyLoggedMeal(
  db: Db,
  ctx: MyContext,
  timeZone: string,
  meal: LoggedMeal,
): Promise<void> {
  const dayLabel = formatMealDay(meal.loggedAt, new Date(), timeZone);
  const progress = buildDayProgressLine(db, meal.userId, meal.loggedAt, timeZone, dayLabel);
  await ctx.reply(
    buildMealMessage(meal.mealType, meal.result.items, meal.result.notes, dayLabel, progress),
    { reply_markup: mealActionsKeyboard(meal.mealId) },
  );
}

// Скачивает фото из Telegram по file_id (фото не храним у себя).
export async function downloadPhoto(api: Api, fileId: string): Promise<FoodImage> {
  const file = await api.getFile(fileId);
  if (!file.file_path) {
    throw new Error("Telegram не вернул file_path для фото");
  }
  const buffer = await downloadTelegramFile(file.file_path);
  return { imageBase64: buffer.toString("base64"), mimeType: mimeTypeForFilePath(file.file_path) };
}

interface IncomingPhoto {
  messageId: number;
  fileId: string;
  caption: string | undefined;
}

// Фото (или альбом — несколько фото одного приёма пищи) → одна запись в дневнике.
async function logPhotoMeal(db: Db, ctx: MyContext, photos: IncomingPhoto[]): Promise<void> {
  if (!ctx.from || photos.length === 0) return;
  const userId = ctx.from.id;
  const ordered = [...photos].sort((a, b) => a.messageId - b.messageId);

  try {
    console.log(`[${userId}] Начало обработки фото (${ordered.length}) в ${new Date().toISOString()}`);
    await withChatAction(ctx, "typing", async () => {
      const images = await Promise.all(ordered.map((photo) => downloadPhoto(ctx.api, photo.fileId)));
      // У альбома подпись обычно у первого фото, но может быть у любого.
      const caption = ordered
        .map((photo) => photo.caption?.trim())
        .filter(Boolean)
        .join("\n");

      const result = await analyzeFood({ images, text: caption || undefined });
      if (!result.foodDetected || result.items.length === 0) {
        await ctx.reply(
          `Не получилось распознать еду на фото.${result.notes ? ` ${result.notes}` : ""} ` +
            "Пришлите другое фото или опишите текстом.",
        );
        return;
      }

      const timeZone = getUserTimeZone(db, userId);
      const loggedAt = new Date();
      const mealType = determineMealType(loggedAt, timeZone);
      const mealId = createMeal(db, {
        userId,
        mealType,
        source: "photo",
        telegramFileId: joinPhotoFileIds(ordered.map((photo) => photo.fileId)),
        description: caption || result.items.map((item) => item.name).join(", "),
        items: toMealItemInputs(result.items),
        rawClaudeResponse: result,
        loggedAt,
      });

      await replyLoggedMeal(db, ctx, timeZone, { mealId, userId, mealType, loggedAt, result });
      console.log(`[${userId}] Фото обработано успешно в ${new Date().toISOString()}`);
    });
  } catch (err) {
    console.error("Не удалось обработать фото еды:", err);
    await ctx
      .reply(replyMessageForError(err, "Не получилось обработать фото, попробуйте ещё раз."))
      .catch((replyErr: unknown) => console.error("Не удалось ответить на фото:", replyErr));
  }
}

// Части альбома приходят отдельными обновлениями почти одновременно — ждём паузу.
const ALBUM_COLLECT_DELAY_MS = 1500;

export function mealActionsKeyboard(mealId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Изменить", `correct:${mealId}`)
    // Обработчик — в features/mealTime.ts.
    .text("🕐 Время", `meal_time:${mealId}`)
    .text("🗑 Удалить", `delete_meal:${mealId}`)
    .row()
    // Обработчик — в features/coach: текст сообщения с оценкой становится контекстом разговора.
    .text("💬 Обсудить с Ням-Ням", "coach:discuss");
}

export function toMealItemInputs(items: FoodItem[]): MealItemInput[] {
  return items.map((item) => ({
    name: item.name,
    weightG: item.estimatedWeightG,
    kcal: item.kcal,
    proteinG: item.proteinG,
    fatG: item.fatG,
    carbG: item.carbG,
  }));
}

export function toFoodItems(rows: MealItemRow[]): FoodItem[] {
  return rows.map((row) => ({
    name: row.name,
    estimatedWeightG: row.weightG,
    kcal: row.kcal,
    proteinG: row.proteinG,
    fatG: row.fatG,
    carbG: row.carbG,
  }));
}

export function replyMessageForError(err: unknown, fallback: string): string {
  return err instanceof FoodAnalyzerError ? err.message : fallback;
}

export function replyMessageForTranscriberError(err: unknown, fallback: string): string {
  return err instanceof TranscriberError ? err.message : fallback;
}

// Скачивает голосовое сообщение и расшифровывает его в текст. При понятных
// пользователю проблемах (слишком длинное, не распознано) сам отвечает и возвращает
// undefined; прочие ошибки пробрасывает.
export async function transcribeVoiceMessage(ctx: MyContext): Promise<string | undefined> {
  const voice = ctx.message?.voice;
  if (!voice) return undefined;

  // Whisper API ограничен 25MB
  const maxSizeBytes = 25 * 1024 * 1024;
  if (voice.file_size && voice.file_size > maxSizeBytes) {
    await ctx.reply(
      "Голосовое сообщение слишком длинное (больше 25MB). Попробуйте записать короче или напишите текстом.",
    );
    return undefined;
  }

  const file = await ctx.getFile();
  if (!file.file_path) {
    throw new Error("Telegram не вернул file_path для голосового сообщения");
  }

  const buffer = await downloadTelegramFile(file.file_path);

  try {
    return await transcribeAudio({
      audioBuffer: buffer,
      mimeType: "audio/ogg",
      filename: path.basename(file.file_path),
    });
  } catch (err) {
    console.error("Не удалось распознать голосовое сообщение:", err);
    await ctx.reply(
      replyMessageForTranscriberError(
        err,
        "Не получилось распознать голосовое сообщение, попробуйте ещё раз или напишите текстом.",
      ),
    );
    return undefined;
  }
}

// Ответ, когда в тексте/голосовом не нашлось ни еды, ни тренировки: коротко, с примером.
export function buildNotRecognizedMessage(
  source: "text" | "voice",
  notes: string | null,
): string {
  const subject = source === "voice" ? "в голосовом" : "тут";
  return [
    `🤔 Не нашла ${subject} ни еды, ни тренировки.${notes ? ` ${notes}` : ""}`,
    "Напишите, что съели («овсянка с бананом»), или пришлите фото 🐾",
  ].join("\n");
}

// Разбирает описание еды/тренировки (текст или расшифровку голосового) и пишет в
// дневник. Также зовётся из разговора с Ням-Ням — кнопкой «📝 Записать в дневник»;
// тогда sentAt — время исходного сообщения: «на ужин был борщ» в 23:50 должен попасть
// в тот день, даже если кнопку нажали после полуночи.
export async function logDescribedMeal(
  db: Db,
  ctx: MyContext,
  text: string,
  source: "text" | "voice",
  sentAt: Date = new Date(),
): Promise<void> {
  if (!ctx.from) return;

  try {
    const userId = ctx.from.id;
    const now = sentAt;
    const timeZone = getUserTimeZone(db, userId);
    const {
      food: result,
      mealTime,
      workouts,
    } = await analyzeMessage({ text, now, timeZone });
    const hasFood = result.foodDetected && result.items.length > 0;
    const { loggedAt, mealType } = resolveMealTime(mealTime, now, timeZone);

    // Тренировки и еду пишем одной транзакцией и только потом отвечаем: если запись
    // упадёт, в дневнике не останется половины сообщения и повтор ничего не задвоит.
    const { savedWorkouts, mealId } = db.transaction(() => ({
      savedWorkouts: saveRecognizedWorkouts(db, userId, workouts, source, text),
      mealId: hasFood
        ? createMeal(db, {
            userId,
            mealType,
            source,
            description: text,
            items: toMealItemInputs(result.items),
            rawClaudeResponse: result,
            loggedAt,
          })
        : undefined,
    }));

    if (workouts.length > 0) await replyRecognizedWorkouts(ctx, savedWorkouts);

    if (mealId === undefined) {
      if (workouts.length > 0) return;
      await ctx.reply(buildNotRecognizedMessage(source, result.notes));
      return;
    }

    await replyLoggedMeal(db, ctx, timeZone, { mealId, userId, mealType, loggedAt, result });
  } catch (err) {
    console.error("Не удалось обработать описание еды:", err);
    await ctx.reply(
      replyMessageForError(err, "Не получилось обработать сообщение, попробуйте ещё раз."),
    );
  }
}

export function registerMealLogging(bot: Bot<MyContext>, db: Db): void {
  bot.on("message:text", async (ctx) => {
    const text = ctx.message.text.trim();
    if (!text || text.startsWith("/")) return;

    // «Привет», «спасибо», «ок» — без запроса к ИИ.
    const smallTalk = smallTalkReply(text);
    if (smallTalk) {
      await ctx.reply(smallTalk);
      return;
    }

    await withChatAction(ctx, "typing", async () => {
      await logDescribedMeal(db, ctx, text, "text");
    });
  });

  // Голосовое с едой не уходит в ИИ сразу: показываем расшифровку с кнопками
  // ✅ / ✏️ / ❌ и пишем в дневник только после ✅.
  bot.on("message:voice", async (ctx) => {
    try {
      await withChatAction(ctx, "typing", async () => {
        const text = await transcribeVoiceMessage(ctx);
        if (text === undefined) return;

        // «Спасибо» голосом — как текстом: без кнопок и без запроса к ИИ.
        const smallTalk = smallTalkReply(text);
        if (smallTalk) {
          await ctx.reply(smallTalk);
          return;
        }
        await ctx.reply(buildVoiceConfirmMessage(text), {
          reply_markup: voiceConfirmKeyboard("meal"),
        });
      });
    } catch (err) {
      console.error("Не удалось обработать голосовое сообщение:", err);
      await ctx.reply("Не получилось обработать голосовое сообщение, попробуйте ещё раз.");
    }
  });

  bot.callbackQuery(voiceConfirmPattern("meal"), async (ctx) => {
    const text = await settleVoiceConfirmation(ctx, ctx.match[1] as VoiceConfirmAction, {
      reject: "Не записываю. Запишите голосовое ещё раз или напишите текстом.",
      edit:
        `Пришлите исправленный вариант текстом (${COPY_TRANSCRIPT_HINT}) ` +
        "или запишите голосовое ещё раз.",
    });
    if (text === undefined) return;
    // Время записи — когда пришло голосовое (сообщение с расшифровкой отправлено сразу
    // за ним), а не когда нажали ✅: «на ужин» в 23:50 не должно уехать на завтра.
    const sentDate = ctx.callbackQuery.message?.date;
    const sentAt = sentDate ? new Date(sentDate * 1000) : new Date();
    await withChatAction(ctx, "typing", () => logDescribedMeal(db, ctx, text, "voice", sentAt));
  });

  // Альбом (несколько фото с одним media_group_id) — один приём пищи: части собираем
  // в буфер и обрабатываем вместе, с контекстом первой части.
  const albums = new MediaGroupBuffer<{ ctx: MyContext; photo: IncomingPhoto }>(
    ALBUM_COLLECT_DELAY_MS,
    (parts) => logPhotoMeal(db, parts[0].ctx, parts.map((part) => part.photo)),
  );

  bot.on("message:photo", async (ctx) => {
    const photo = ctx.message.photo.at(-1);
    if (!photo) return;
    const incoming: IncomingPhoto = {
      messageId: ctx.message.message_id,
      fileId: photo.file_id,
      caption: ctx.message.caption,
    };

    const groupId = ctx.message.media_group_id;
    if (groupId) {
      albums.add(`${ctx.chat.id}:${groupId}`, { ctx, photo: incoming });
      return;
    }
    await logPhotoMeal(db, ctx, [incoming]);
  });

  bot.callbackQuery(/^delete_meal:(\d+)$/, async (ctx) => {
    const mealId = Number(ctx.match[1]);
    const deleted = deleteMealWithUndo(db, deletedEntries, mealId, ctx.from.id);
    if (!deleted) {
      await ctx.answerCallbackQuery({
        text: "Не удалось удалить запись.",
        show_alert: true,
      });
      return;
    }

    await ctx.editMessageText(`🗑 Запись удалена: ${shortLabel(deleted.description, 60)}`, {
      reply_markup: undoDeleteKeyboard("meal", mealId),
    });
    await ctx.answerCallbackQuery();
  });
}
