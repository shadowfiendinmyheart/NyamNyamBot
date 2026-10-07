import type { Conversation } from "@grammyjs/conversations";
import { Bot, InlineKeyboard, type Api, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import {
  FINISH_CONVERSATION_FIRST_TEXT,
  hasActiveConversation,
  type MyContext,
} from "../context.js";
import type { WorkoutEstimate } from "../ai/messageAnalyzer.js";
import { getProfileByUserId } from "../db/profiles.js";
import {
  createWorkout,
  getWorkoutById,
  updateWorkout,
  type ExerciseInput,
  type WorkoutEntry,
  type WorkoutSource,
} from "../db/workouts.js";
import {
  calculateWorkoutKcal,
  rescaleWorkoutKcal,
  MAX_WORKOUT_MIN,
  type ActivityLevel,
  type WorkoutActivityType,
  type WorkoutIntensity,
} from "../nutrition/calculations.js";
import { noProfileReply } from "./profile.js";
import { askChoice, askNumber } from "./onboarding.js";
import { deletedEntries, deleteWorkoutWithUndo, undoDeleteKeyboard } from "./deletedEntries.js";
import {
  capitalize,
  formatExercise,
  formatWorkoutLine,
  INTENSITY_LABEL,
  workoutBonusNote,
  WORKOUT_TYPE_EMOJI,
  WORKOUT_TYPE_NAME,
} from "./workoutFormat.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

// Основы слов для `/workout бег 40`: «бегал» и «пробежка» тоже подходят.
const TYPE_STEMS: Array<[WorkoutActivityType, string[]]> = [
  ["walking", ["ходьб", "ходил", "прогул", "шаг", "пешк"]],
  ["running", ["бег", "пробеж"]],
  ["cycling", ["вело", "велик", "байк"]],
  ["swimming", ["плав", "бассейн"]],
  ["strength", ["силов", "зал", "качалк", "штанг", "гантел", "тренаж"]],
  ["hiit", ["hiit", "хиит", "интервал", "кроссфит", "кругов", "табат"]],
  ["yoga", ["йог", "пилатес", "растяжк", "стретч"]],
  [
    "sports",
    ["футбол", "баскетбол", "волейбол", "теннис", "хоккей", "бокс", "единоборств", "бадминтон"],
  ],
  ["dancing", ["танц"]],
  ["skiing", ["лыж", "коньк", "сноуборд"]],
];

const INTENSITY_STEMS: Array<[WorkoutIntensity, string[]]> = [
  ["low", ["легк", "лёгк", "спокойн", "медленн"]],
  ["moderate", ["средн", "умерен"]],
  ["high", ["интенсив", "быстр", "тяжел", "тяжёл", "жестк", "жёстк"]],
];

const MINUTE_WORDS = new Set(["м", "мин", "минут", "минуты", "минута"]);
const HOUR_WORDS = new Set(["ч", "час", "часа", "часов"]);
// Число с такой единицей — не длительность («бег 5 км 30 минут»), оно остаётся в названии.
const NON_TIME_UNIT =
  /^(км|кг|раз|раза|ккал)$|^(километр|метр|килограмм|повтор|подход|шаг|калори|круг|этаж)/;

export interface ParsedWorkout {
  activityType: WorkoutActivityType;
  name: string;
  durationMin: number;
  intensity: WorkoutIntensity;
  exercises?: ExerciseInput[];
}

function findByStem<T>(word: string, table: Array<[T, string[]]>): T | undefined {
  return table.find(([, stems]) => stems.some((stem) => word.startsWith(stem)))?.[0];
}

function toNumber(token: string | undefined): number | undefined {
  if (token === undefined) return undefined;
  const value = Number(token.replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

// «бег 40», «плавание 1.5 ч интенсивно», «бег 1 час 30 минут», «бег 5 км 30 минут» →
// тренировка; undefined, если нет длительности или названия. Числа с явными «ч»/«мин»
// складываются; без них длительность — первое число без другой единицы (км, раз…).
export function parseWorkoutCommand(text: string): ParsedWorkout | undefined {
  const tokens = text
    .toLowerCase()
    .replace(/([а-яёa-z])(\d)/g, "$1 $2")
    .replace(/(\d)([а-яёa-z])/g, "$1 $2")
    .split(/\s+/)
    .filter(Boolean);

  const minutesPerUnit = (unit: string | undefined): number | undefined => {
    if (unit === undefined) return undefined;
    if (HOUR_WORDS.has(unit)) return 60;
    if (MINUTE_WORDS.has(unit)) return 1;
    return undefined;
  };
  const hasExplicitUnits = tokens.some(
    (token, i) => toNumber(token) !== undefined && minutesPerUnit(tokens[i + 1]) !== undefined,
  );

  let durationMin: number | undefined;
  let intensity: WorkoutIntensity = "moderate";
  const nameWords: string[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    const value = toNumber(token);
    if (value !== undefined) {
      const unit = tokens[i + 1];
      const multiplier = minutesPerUnit(unit);
      if (multiplier !== undefined) {
        durationMin = (durationMin ?? 0) + value * multiplier;
        i++;
        continue;
      }
      const isOtherUnit = unit !== undefined && NON_TIME_UNIT.test(unit);
      if (!hasExplicitUnits && !isOtherUnit && durationMin === undefined) {
        durationMin = value;
        continue;
      }
      nameWords.push(token);
      continue;
    }
    const tokenIntensity = findByStem(token, INTENSITY_STEMS);
    if (tokenIntensity) {
      intensity = tokenIntensity;
      continue;
    }
    nameWords.push(token);
  }

  if (durationMin === undefined || nameWords.length === 0) return undefined;
  durationMin = Math.round(durationMin);
  if (durationMin < 1 || durationMin > MAX_WORKOUT_MIN) return undefined;

  const name = nameWords.join(" ");
  const activityType =
    nameWords.map((word) => findByStem(word, TYPE_STEMS)).find(Boolean) ?? "other";
  return { activityType, name, durationMin, intensity };
}

export function buildWorkoutMessage(
  workout: WorkoutEntry,
  activityLevel: ActivityLevel,
  durationEstimated = false,
): string {
  const parts = [
    formatWorkoutLine(workout),
    ...workout.exercises.map((exercise) => `• ${capitalize(formatExercise(exercise))}`),
    `🔥 Сожжено: ~${workout.kcalBurned} ккал`,
    "",
    workoutBonusNote(activityLevel, workout.kcalBurned),
  ];
  if (durationEstimated) {
    parts.push(
      "",
      "⚠️ Длительность не указана и оценена примерно. Если не так, нажмите «✏️ Изменить» " +
        "и укажите, сколько минут длилась тренировка.",
    );
  }
  return parts.join("\n");
}

// Сообщение о сохранённой тренировке — после «↩️ Вернуть» или из истории дня. Без
// профиля нет уровня активности для подписи про норму — только сама тренировка.
export function buildStoredWorkoutMessage(db: Db, workout: WorkoutEntry): string {
  const profile = getProfileByUserId(db, workout.userId);
  return profile
    ? buildWorkoutMessage(workout, profile.activityLevel)
    : `${formatWorkoutLine(workout)}\n🔥 Сожжено: ~${workout.kcalBurned} ккал`;
}

export function workoutActionsKeyboard(workoutId: number): InlineKeyboard {
  return new InlineKeyboard()
    .text("✏️ Изменить", `edit_workout:${workoutId}`)
    .text("🗑 Удалить", `delete_workout:${workoutId}`);
}

const NO_PROFILE = noProfileReply(
  "Чтобы посчитать расход калорий на тренировке, мне нужен ваш вес — сначала заполните анкету.",
);

const COMMAND_HINT =
  "🐱 Не разобрала тренировку. Проще всего описать её обычным сообщением: «бег 40 минут», " +
  "«плавание 1.5 ч интенсивно», «подтягивания 3×10, отжимания 3×20, скакалка 15 минут». " +
  "Или нажмите «⚙️ Меню» → «🏋️ Тренировка» — спрошу по шагам.";

export interface SavedWorkout {
  workout: WorkoutEntry;
  activityLevel: ActivityLevel;
}

// Считает расход по весу из профиля и записывает тренировку. Без профиля ничего не пишет.
export function saveWorkout(
  db: Db,
  userId: number,
  input: ParsedWorkout,
  source: WorkoutSource,
  rawText: string | null,
): SavedWorkout | undefined {
  const profile = getProfileByUserId(db, userId);
  if (!profile) return undefined;

  const workout = createWorkout(db, {
    userId,
    activityType: input.activityType,
    description: input.name,
    durationMin: input.durationMin,
    intensity: input.intensity,
    kcalBurned: calculateWorkoutKcal({ ...input, weightKg: profile.weightKg }),
    source,
    rawText,
    exercises: input.exercises,
  });
  return { workout, activityLevel: profile.activityLevel };
}

export interface SavedRecognizedWorkout extends SavedWorkout {
  durationEstimated: boolean;
}

// Записывает тренировки, распознанные ИИ в тексте/голосе, без ответа пользователю —
// чтобы вызывающий мог записать их в одной транзакции с едой. undefined — нет профиля
// (без веса расход не посчитать), тогда ничего не записано.
export function saveRecognizedWorkouts(
  db: Db,
  userId: number,
  estimates: WorkoutEstimate[],
  source: "text" | "voice",
  rawText: string,
): SavedRecognizedWorkout[] | undefined {
  const saved: SavedRecognizedWorkout[] = [];
  for (const estimate of estimates) {
    const result = saveWorkout(db, userId, estimate, source, rawText);
    if (!result) return undefined;
    saved.push({ ...result, durationEstimated: estimate.durationEstimated });
  }
  return saved;
}

export async function replyRecognizedWorkouts(
  ctx: Context,
  saved: SavedRecognizedWorkout[] | undefined,
): Promise<void> {
  if (!saved) {
    await ctx.reply(NO_PROFILE.text, { reply_markup: NO_PROFILE.reply_markup });
    return;
  }
  for (const { workout, activityLevel, durationEstimated } of saved) {
    await ctx.reply(buildWorkoutMessage(workout, activityLevel, durationEstimated), {
      reply_markup: workoutActionsKeyboard(workout.id),
    });
  }
}

async function replyWorkoutSaved(ctx: Context, saved: SavedWorkout | undefined): Promise<void> {
  if (!saved) {
    await ctx.reply(NO_PROFILE.text, { reply_markup: NO_PROFILE.reply_markup });
    return;
  }
  await ctx.reply(buildWorkoutMessage(saved.workout, saved.activityLevel), {
    reply_markup: workoutActionsKeyboard(saved.workout.id),
  });
}

const TYPE_CHOICES = Object.fromEntries(
  (Object.keys(WORKOUT_TYPE_NAME) as WorkoutActivityType[]).map((type) => [
    type,
    `${WORKOUT_TYPE_EMOJI[type]} ${capitalize(WORKOUT_TYPE_NAME[type])}`,
  ]),
) as Record<WorkoutActivityType, string>;

export function workoutConversation(db: Db) {
  return async function workout(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const hasProfile = await conversation.external(() => !!getProfileByUserId(db, userId));
    if (!hasProfile) {
      await ctx.reply(NO_PROFILE.text, { reply_markup: NO_PROFILE.reply_markup });
      return;
    }

    // Пользователь может передумать посреди ввода — не запираем его в диалоге.
    const cancel = { cancelledText: "Запись тренировки отменена." };

    const activityType = await askChoice(
      conversation,
      ctx,
      "🏃 Какая была активность? /cancel — отменить.",
      TYPE_CHOICES,
      "wtype",
      cancel,
    );
    const durationMin = await askNumber(
      conversation,
      ctx,
      "Сколько минут длилась тренировка?",
      { min: 1, max: MAX_WORKOUT_MIN, integer: true },
      cancel,
    );
    const intensity = await askChoice(
      conversation,
      ctx,
      "Какая интенсивность?",
      INTENSITY_LABEL,
      "wintensity",
      cancel,
    );

    const saved = await conversation.external(() =>
      saveWorkout(
        db,
        userId,
        { activityType, name: WORKOUT_TYPE_NAME[activityType], durationMin, intensity },
        "command",
        null,
      ),
    );
    await replyWorkoutSaved(ctx, saved);
  };
}

const EDIT_FIELD_CHOICES = {
  duration: "⏱ Длительность",
  intensity: "💪 Интенсивность",
};

type WorkoutEditOutcome =
  | { status: "updated"; text: string }
  | { status: "gone" }
  | { status: "noProfile" };

// Правка тренировки кнопкой «✏️ Изменить»: длительность или интенсивность, расход
// пересчитывается с весом, с которым тренировку записали (rescaleWorkoutKcal); профиль
// нужен для подписи про норму. api — внешний bot.api: внутри
// conversation.external нельзя пользоваться ctx диалога.
export function workoutEditConversation(db: Db, api: Api) {
  return async function workoutEdit(
    conversation: MyConversation,
    ctx: Context,
    workoutId: number,
    chatId: number,
    messageId: number,
  ): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const workout = await conversation.external(() => getWorkoutById(db, workoutId, userId));
    if (!workout) {
      await ctx.reply("Эта тренировка уже не найдена — возможно, она была удалена.");
      return;
    }

    const cancel = { cancelledText: "Правка тренировки отменена." };
    const field = await askChoice(
      conversation,
      ctx,
      `✏️ ${formatWorkoutLine(workout)}\n\nЧто поправить? /cancel — отменить.`,
      EDIT_FIELD_CHOICES,
      "wedit",
      cancel,
    );

    let { durationMin, intensity } = workout;
    if (field === "duration") {
      durationMin = await askNumber(
        conversation,
        ctx,
        `Сколько минут длилась тренировка? Сейчас — ${workout.durationMin} мин.`,
        { min: 1, max: MAX_WORKOUT_MIN, integer: true },
        cancel,
      );
    } else {
      intensity = await askChoice(
        conversation,
        ctx,
        `Какая интенсивность? Сейчас — ${INTENSITY_LABEL[workout.intensity].toLowerCase()}.`,
        INTENSITY_LABEL,
        "wedit_int",
        cancel,
      );
    }

    const outcome = await conversation.external((): WorkoutEditOutcome => {
      const profile = getProfileByUserId(db, userId);
      if (!profile) return { status: "noProfile" };
      const kcalBurned = rescaleWorkoutKcal(workout.kcalBurned, workout, {
        activityType: workout.activityType,
        intensity,
        durationMin,
      });
      const updated = updateWorkout(db, workoutId, userId, { durationMin, intensity, kcalBurned });
      return updated
        ? { status: "updated", text: buildWorkoutMessage(updated, profile.activityLevel) }
        : { status: "gone" };
    });

    if (outcome.status === "noProfile") {
      await ctx.reply(NO_PROFILE.text, { reply_markup: NO_PROFILE.reply_markup });
      return;
    }
    if (outcome.status === "gone") {
      await ctx.reply("Не получилось обновить тренировку — возможно, она была удалена.");
      return;
    }

    const { text } = outcome;
    await conversation.external(async () => {
      try {
        await api.editMessageText(chatId, messageId, text, {
          reply_markup: workoutActionsKeyboard(workoutId),
        });
      } catch (err) {
        console.error("Не удалось обновить исходное сообщение о тренировке:", err);
      }
    });
    // Исходное сообщение может быть далеко вверху чата — результат присылаем и отдельно.
    await ctx.reply(`✅ Обновила тренировку:\n\n${text}`, {
      reply_markup: workoutActionsKeyboard(workoutId),
    });
  };
}

export function registerWorkout(bot: Bot<MyContext>, db: Db): void {
  bot.command("workout", async (ctx) => {
    if (!ctx.from) return;

    const arg = ctx.match.trim();
    if (!arg) {
      if (ctx.conversation.active("workout")) return;
      await ctx.conversation.enter("workout");
      return;
    }

    const parsed = parseWorkoutCommand(arg);
    if (!parsed) {
      await ctx.reply(COMMAND_HINT);
      return;
    }
    await replyWorkoutSaved(ctx, saveWorkout(db, ctx.from.id, parsed, "command", arg));
  });

  bot.callbackQuery("menu:workout", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.conversation.active("workout")) return;
    await ctx.conversation.enter("workout");
  });

  // Пока диалог идёт, эти кнопки перехватывает он сам; сюда попадаем, только если
  // диалог уже закрыт (отменён, прерван сообщением или бот перезапускался).
  bot.callbackQuery(/^(wtype|wintensity):/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Этот вопрос уже неактуален — начните запись заново: «⚙️ Меню» → «🏋️ Тренировка».",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  });

  bot.callbackQuery(/^(wedit|wedit_int):/, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Эта правка уже неактуальна — нажмите «✏️ Изменить» под тренировкой ещё раз.",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  });

  bot.callbackQuery(/^edit_workout:(\d+)$/, async (ctx) => {
    const workoutId = Number(ctx.match[1]);
    if (!getWorkoutById(db, workoutId, ctx.from.id)) {
      await ctx.answerCallbackQuery({ text: "Тренировка не найдена.", show_alert: true });
      return;
    }

    const chatId = ctx.callbackQuery.message?.chat.id;
    const messageId = ctx.callbackQuery.message?.message_id;
    if (!chatId || !messageId) {
      await ctx.answerCallbackQuery({
        text: "Не удалось определить сообщение.",
        show_alert: true,
      });
      return;
    }

    if (hasActiveConversation(ctx)) {
      await ctx.answerCallbackQuery({
        text: FINISH_CONVERSATION_FIRST_TEXT,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.conversation.enter("workoutEdit", workoutId, chatId, messageId);
  });

  bot.callbackQuery(/^delete_workout:(\d+)$/, async (ctx) => {
    const workoutId = Number(ctx.match[1]);
    const deleted = deleteWorkoutWithUndo(db, deletedEntries, workoutId, ctx.from.id);
    if (!deleted) {
      await ctx.answerCallbackQuery({ text: "Не удалось удалить запись.", show_alert: true });
      return;
    }
    await ctx.editMessageText(`🗑 Тренировка удалена: ${formatWorkoutLine(deleted)}`, {
      reply_markup: undoDeleteKeyboard("workout", workoutId),
    });
    await ctx.answerCallbackQuery();
  });
}
