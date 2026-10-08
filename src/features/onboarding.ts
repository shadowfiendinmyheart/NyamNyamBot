import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Api, type Bot, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getProfileByUserId, upsertProfile } from "../db/profiles.js";
import { getUserByTelegramId, setUserTimeZone } from "../db/users.js";
import { addWeightEntry } from "../db/weightLog.js";
import { isValidTimeZone, parseTimeZoneText } from "../utils/timezones.js";
import { isCancelInput, mainKeyboard } from "./mainMenu.js";
import {
  ACTIVITY_LABEL,
  ACTIVITY_QUESTION,
  GOAL_LABEL,
  SEX_LABEL,
} from "./profile.js";
import {
  describeTimeZone,
  TIMEZONE_HINT,
  TIMEZONE_QUESTION,
  timeZoneKeyboard,
} from "./timezone.js";
import {
  calculateDailyTargets,
  type ActivityLevel,
  type Goal,
  type Sex,
} from "../nutrition/calculations.js";
import {
  buildVoiceConfirmMessage,
  COPY_TRANSCRIPT_HINT,
  settleVoiceConfirmation,
  transcribeVoiceInConversation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
  type VoiceConfirmAction,
} from "./voiceConfirm.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

// С cancel вопрос можно бросить: команда или кнопка меню завершает диалог; сообщение
// вместо ответа (фото, еда или тренировка текстом) тоже закрывает диалог и уходит
// обычным обработчикам; чужие кнопки обрабатываются как обычно, а вопрос ждёт дальше.
// Без cancel диалог ждёт только свой ответ (онбординг пройти обязательно).
export interface CancelOptions {
  cancelledText: string;
}

export async function haltIfCancelled(
  conversation: MyConversation,
  response: Context,
  cancel: CancelOptions,
): Promise<void> {
  const text = response.message?.text?.trim();
  if (text === undefined || !isCancelInput(text)) return;
  await response.reply(cancel.cancelledText);
  // /cancel обрабатывать больше нечем; остальные команды и кнопки — пропускаем дальше.
  await conversation.halt({ next: text !== "/cancel" });
}

export interface NumberRange {
  min: number;
  max: number;
  integer: boolean;
}

function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Слова, которые могут стоять рядом с числом в ответе: единицы и «мне», «примерно»…
// Короткие — точное совпадение, длинные — начало слова.
const NUMBER_FILLER_WORDS = [
  "см", "кг", "г", "м", "ч", "лет", "год", "года", "мин", "мне", "я", "где", "то", "уже",
  "сантиметр", "килограмм", "минут", "час", "примерн", "около", "почти", "вешу", "рост",
  "вес", "возраст", "сейчас", "кило",
];

function isNumberFiller(word: string): boolean {
  return NUMBER_FILLER_WORDS.some((filler) =>
    filler.length < 4 ? word === filler : word.startsWith(filler),
  );
}

// Число из ответа: «175», «175 см», «78,5кг», «мне 30», «примерно 75 кг». undefined —
// в ответе нет числа, чисел несколько («78 кг 500 г») или есть посторонние слова
// («съел 2 яблока») — это не ответ на вопрос.
export function parseNumberText(text: string): number | undefined {
  const words = text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/(\d)([a-zа-я])/g, "$1 $2")
    .replace(/([a-zа-я])(\d)/g, "$1 $2")
    .split(/[^a-zа-я0-9.]+/)
    .map((word) => word.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean);

  const numbers = words.filter((word) => /^\d+(\.\d+)?$/.test(word));
  if (numbers.length !== 1) return undefined;
  const others = words.filter((word) => word !== numbers[0]);
  if (!others.every(isNumberFiller)) return undefined;
  return Number(numbers[0]);
}

export function isInRange(value: number, range: NumberRange): boolean {
  return (
    value >= range.min && value <= range.max && (!range.integer || Number.isInteger(value))
  );
}

function numberHint(range: NumberRange): string {
  return (
    `Введите число от ${range.min} до ${range.max}` +
    `${range.integer ? "" : ", можно с десятичной частью"}.`
  );
}

function choiceKeyboard<T extends string>(
  options: Record<T, string>,
  prefix: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [value, label] of Object.entries(options) as [T, string][]) {
    keyboard.text(label, `${prefix}:${value}`).row();
  }
  return keyboard;
}

export async function askChoice<T extends string>(
  conversation: MyConversation,
  ctx: Context,
  question: string,
  options: Record<T, string>,
  prefix: string,
  cancel?: CancelOptions,
): Promise<T> {
  await ctx.reply(question, { reply_markup: choiceKeyboard(options, prefix) });

  const pattern = new RegExp(`^${prefix}:`);
  if (!cancel) {
    const response = await conversation.waitForCallbackQuery(pattern);
    await response.answerCallbackQuery();
    return response.callbackQuery.data.slice(prefix.length + 1) as T;
  }

  for (;;) {
    const response = await conversation.wait();
    await haltIfCancelled(conversation, response, cancel);
    const data = response.callbackQuery?.data;
    if (data !== undefined && pattern.test(data)) {
      await response.answerCallbackQuery();
      return data.slice(prefix.length + 1) as T;
    }
    if (response.message) await conversation.halt({ next: true });
    await conversation.skip({ next: true });
  }
}

export async function askNumber(
  conversation: MyConversation,
  ctx: Context,
  question: string,
  range: NumberRange,
  cancel?: CancelOptions,
): Promise<number> {
  await ctx.reply(question);

  for (;;) {
    const response = cancel ? await conversation.wait() : await conversation.waitFor("message:text");
    if (cancel) await haltIfCancelled(conversation, response, cancel);
    const text = response.message?.text;
    if (text === undefined) {
      if (response.message) await conversation.halt({ next: true });
      await conversation.skip({ next: true });
      continue;
    }
    const value = parseNumberText(text);
    // Не число вообще — это обычное сообщение (например, тренировка текстом), а не ответ.
    if (cancel && value === undefined) await conversation.halt({ next: true });
    if (value !== undefined && isInRange(value, range)) return value;

    await response.reply(numberHint(range));
  }
}

// --- Анкета: шаг назад, ответы текстом, подсказки на посторонний ввод ---

const BACK_LABEL = "◀️ Назад";
// У «Назад» каждого шага свои данные: лишнее нажатие (двойной тап) старой кнопки не
// уведёт ещё на шаг назад с уже следующего вопроса.
function backData(step: number): string {
  return `onb:back:${step}`;
}
// Префиксы кнопок анкеты — по ним узнаём нажатия под уже пройденными вопросами.
export const ONBOARDING_CALLBACK_PATTERN = /^(sex|activity|goal|tz|onb):/;

export const BACK = Symbol("back");
export type Back = typeof BACK;

// Режим анкеты: первая — обязательная (без неё нет нормы), повторная — из меню, с отменой.
interface OnboardingMode {
  cancel?: CancelOptions;
}

// Место вопроса в анкете: заголовок с прогрессом и «◀️ Назад» (нет у первого вопроса).
interface StepFrame {
  title: string;
  backData?: string;
}

const FINISH_FIRST_TEXT =
  "Сначала закончите анкету — без неё не посчитать дневную норму. Осталось совсем немного 🙂";

function withCancelHint(text: string, mode: OnboardingMode): string {
  return mode.cancel ? `${text}\n/cancel — отменить анкету.` : text;
}

function withBack(keyboard: InlineKeyboard, frame: StepFrame): InlineKeyboard {
  return frame.backData ? keyboard.text(BACK_LABEL, frame.backData) : keyboard;
}

// Ответ текстом на вопрос с кнопками: номер варианта («2»), название варианта или
// ключевые слова из words. Короткие слова — точное совпадение, длинные — начало слова
// («мужской» → «муж»), фразы с пробелом — подряд идущие слова («очень высок»).
// Если ответ подходит к нескольким вариантам («массу сбросить») или в нём есть
// отрицание («не очень активный») — не угадываем: undefined, пусть выберет кнопкой.
export function matchChoiceText<T extends string>(
  text: string,
  options: Record<T, string>,
  words: Partial<Record<T, string[]>> = {},
): T | undefined {
  const answer = normalizeAnswer(text);
  if (!answer) return undefined;

  const values = Object.keys(options) as T[];
  if (/^\d+$/.test(answer)) return values[Number(answer) - 1];

  const byLabel = values.find((value) => normalizeAnswer(options[value]) === answer);
  if (byLabel) return byLabel;

  const matched = new Set<T>();
  // Сначала фразы: совпавшая фраза вырезается, чтобы её слова не совпали ещё раз
  // («очень высокий» — это не ещё и «высокая»).
  let rest = ` ${answer} `;
  for (const value of values) {
    for (const phrase of (words[value] ?? []).filter((word) => word.includes(" "))) {
      const pattern = new RegExp(` ${phrase}\\S*`, "g");
      if (pattern.test(rest)) {
        matched.add(value);
        rest = rest.replace(pattern, " ");
      }
    }
  }

  const restWords = rest.trim().split(" ").filter(Boolean);
  if (restWords.includes("не")) return undefined;
  for (const answerWord of restWords) {
    for (const value of values) {
      const hit = (words[value] ?? []).some(
        (word) =>
          !word.includes(" ") &&
          (word.length < 3 ? answerWord === word : answerWord.startsWith(word)),
      );
      if (hit) matched.add(value);
    }
  }

  return matched.size === 1 ? [...matched][0] : undefined;
}

export const SEX_WORDS: Partial<Record<Sex, string[]>> = {
  male: ["м", "муж", "парен", "мальчик"],
  female: ["ж", "жен", "девушк", "девочк"],
};

export const ACTIVITY_WORDS: Partial<Record<ActivityLevel, string[]>> = {
  sedentary: ["сидяч", "мало", "нет"],
  light: ["легк", "небольш"],
  moderate: ["средн", "умерен"],
  active: ["высок"],
  very_active: ["очень высок", "оч высок", "тяжел", "каждый день"],
};

export const GOAL_WORDS: Partial<Record<Goal, string[]>> = {
  lose: ["похуд", "сброс", "скинут", "снизит"],
  maintain: ["поддерж", "сохран", "удерж"],
  gain: ["набор", "набрат", "масс"],
};

// Нажатие кнопки, которая не отвечает на текущий вопрос. Внутри анкеты кнопки прошлых
// вопросов не работают. Остальное при возможности отмены обрабатывается как обычно
// (вне анкеты — в том числе старые кнопки анкеты, у них свой обработчик), а в первой
// анкете ждёт её окончания.
async function handleStrayCallback(
  conversation: MyConversation,
  response: Context,
  mode: OnboardingMode,
  inQuestionnaire: boolean,
): Promise<void> {
  const data = response.callbackQuery?.data ?? "";
  if (inQuestionnaire && ONBOARDING_CALLBACK_PATTERN.test(data)) {
    await response.answerCallbackQuery({
      text: "Этот вопрос уже пройден — ответьте на последний вопрос анкеты.",
    });
    return;
  }
  if (mode.cancel) await conversation.skip({ next: true });
  await response.answerCallbackQuery({ text: FINISH_FIRST_TEXT, show_alert: true });
}

// Команда или кнопка главного меню вместо ответа: с отменой — отмена, в первой анкете —
// просьба закончить. true — ввод обработан и вопрос ждёт дальше.
async function handleMenuInput(
  conversation: MyConversation,
  response: Context,
  text: string,
  mode: OnboardingMode,
): Promise<boolean> {
  if (!isCancelInput(text)) return false;
  if (mode.cancel) await haltIfCancelled(conversation, response, mode.cancel);
  await response.reply(FINISH_FIRST_TEXT);
  return true;
}

interface Question<T> {
  text: string;
  frame: StepFrame;
  keyboard?: InlineKeyboard;
  fromCallback?: (data: string) => T | undefined;
  // Значение или подсказка, почему ответ не подошёл.
  fromText: (text: string) => { value: T } | { hint: string };
  // Что дописать к вопросу после ответа (для ответа числом — ничего, оно видно в чате).
  answerLabel?: (value: T) => string;
  nonTextHint: string;
}

async function askQuestion<T>(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  question: Question<T>,
  mode: OnboardingMode,
): Promise<T | Back> {
  const text = `${question.frame.title}${question.text}`;
  const keyboard = withBack(question.keyboard ?? new InlineKeyboard(), question.frame);
  const message = await ctx.reply(text, { reply_markup: keyboard });

  // Убираем кнопки у вопроса, на который ответили, чтобы их нельзя было нажать позже.
  const close = (label?: string) =>
    conversation.external(async () => {
      const { chat, message_id: messageId } = message;
      const empty = { reply_markup: new InlineKeyboard() };
      await (label
        ? api.editMessageText(chat.id, messageId, `${text}\n\n✅ ${label}`, empty)
        : api.editMessageReplyMarkup(chat.id, messageId, empty)
      ).catch(() => {});
    });

  for (;;) {
    const response = await conversation.wait();

    const data = response.callbackQuery?.data;
    if (data !== undefined) {
      if (question.frame.backData && data === question.frame.backData) {
        await response.answerCallbackQuery();
        await close();
        return BACK;
      }
      const value = question.fromCallback?.(data);
      if (value !== undefined) {
        await response.answerCallbackQuery();
        await close(question.answerLabel?.(value));
        return value;
      }
      await handleStrayCallback(conversation, response, mode, true);
      continue;
    }

    const answer = response.message?.text?.trim();
    if (answer !== undefined) {
      if (await handleMenuInput(conversation, response, answer, mode)) continue;
      const parsed = question.fromText(answer);
      if ("value" in parsed) {
        await close(question.answerLabel?.(parsed.value));
        return parsed.value;
      }
      await response.reply(withCancelHint(parsed.hint, mode));
      continue;
    }

    if (response.message) {
      await response.reply(withCancelHint(question.nonTextHint, mode));
      continue;
    }
    await conversation.skip({ next: true });
  }
}

interface ChoiceSpec<T extends string> {
  text: string;
  options: Record<T, string>;
  words: Partial<Record<T, string[]>>;
  prefix: string;
}

function askOnboardingChoice<T extends string>(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  frame: StepFrame,
  mode: OnboardingMode,
  spec: ChoiceSpec<T>,
): Promise<T | Back> {
  const { text, options, words, prefix } = spec;
  const hint = "Выберите вариант кнопкой под вопросом или напишите его словами.";
  return askQuestion<T>(
    conversation,
    ctx,
    api,
    {
      text,
      frame,
      keyboard: choiceKeyboard(options, prefix),
      fromCallback: (data) => {
        const value = data.startsWith(`${prefix}:`) ? data.slice(prefix.length + 1) : undefined;
        return value !== undefined && value in options ? (value as T) : undefined;
      },
      fromText: (answer) => {
        const value = matchChoiceText(answer, options, words);
        return value ? { value } : { hint: `Не поняла ответ. ${hint}` };
      },
      answerLabel: (value) => options[value],
      nonTextHint: hint,
    },
    mode,
  );
}

function askOnboardingNumber(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  frame: StepFrame,
  mode: OnboardingMode,
  spec: { text: string; range: NumberRange },
): Promise<number | Back> {
  const hint = `${numberHint(spec.range)} Например: «${spec.range.min + 10}».`;
  return askQuestion<number>(
    conversation,
    ctx,
    api,
    {
      text: spec.text,
      frame,
      fromText: (answer) => {
        const value = parseNumberText(answer);
        return value !== undefined && isInRange(value, spec.range) ? { value } : { hint };
      },
      nonTextHint: `Сейчас жду ответ числом. ${hint}`,
    },
    mode,
  );
}

const TIMEZONE_PREFIX = "tz:";

// Часовой пояс: частые — кнопками, остальные — городом или смещением текстом.
function askOnboardingTimeZone(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  frame: StepFrame,
  mode: OnboardingMode,
  current: string | undefined,
): Promise<string | Back> {
  return askQuestion<string>(
    conversation,
    ctx,
    api,
    {
      text: TIMEZONE_QUESTION,
      frame,
      keyboard: timeZoneKeyboard(TIMEZONE_PREFIX, current),
      fromCallback: (data) => {
        const timeZone = data.startsWith(TIMEZONE_PREFIX)
          ? data.slice(TIMEZONE_PREFIX.length)
          : undefined;
        return timeZone !== undefined && isValidTimeZone(timeZone) ? timeZone : undefined;
      },
      fromText: (answer) => {
        const timeZone = parseTimeZoneText(answer);
        return timeZone ? { value: timeZone } : { hint: TIMEZONE_HINT };
      },
      answerLabel: (timeZone) => describeTimeZone(timeZone),
      nonTextHint: TIMEZONE_HINT,
    },
    mode,
  );
}

export const MAX_MOTIVATION_LENGTH = 1500;

export const MOTIVATION_QUESTION = [
  "Расскажите своими словами, зачем вам бот.",
  "",
  "К чему хотите прийти, что хотите изменить, что мешало раньше. Можно текстом или " +
    "голосовым 🎙 — Ням-Ням будет учитывать это в советах.",
].join("\n");

export const MOTIVATION_SKIP_DATA = "motivation:skip";

export function normalizeMotivation(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_MOTIVATION_LENGTH
    ? `${trimmed.slice(0, MAX_MOTIVATION_LENGTH).trimEnd()}…`
    : trimmed;
}

// Где задаётся вопрос «зачем вам бот»: шаг анкеты (прогресс, «◀️ Назад», на посторонние
// сообщения — подсказка) или правка из профиля (отменяется, а постороннее сообщение
// закрывает диалог и уходит обычным обработчикам).
export type MotivationPlace =
  | { kind: "questionnaire"; mode: OnboardingMode; frame: StepFrame }
  | { kind: "profile"; cancel: CancelOptions };

// Открытый вопрос «зачем вам бот» — ответ текстом или голосом (голос — только после
// подтверждения расшифровки). Кнопка под вопросом оставляет current: «Пропустить», если
// ответа ещё нет, и «Оставить как есть», если есть. Расшифровка хранится в тексте
// сообщения с кнопками «Да/Нет», поэтому отдельного состояния для голоса не нужно.
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  place: { kind: "questionnaire"; mode: OnboardingMode; frame: StepFrame },
): Promise<string | null | Back>;
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  place: { kind: "profile"; cancel: CancelOptions },
): Promise<string | null>;
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  place: MotivationPlace,
): Promise<string | null | Back> {
  const inQuestionnaire = place.kind === "questionnaire";
  const mode: OnboardingMode = inQuestionnaire ? place.mode : { cancel: place.cancel };
  const frame: StepFrame = inQuestionnaire ? place.frame : { title: "" };

  const keyboard = new InlineKeyboard().text(
    current ? "✅ Оставить как есть" : "⏭ Пропустить",
    MOTIVATION_SKIP_DATA,
  );
  const question = await ctx.reply(`${frame.title}${MOTIVATION_QUESTION}`, {
    reply_markup: withBack(frame.backData ? keyboard.row() : keyboard, frame),
  });
  const done = async <T extends string | null | Back>(motivation: T): Promise<T> => {
    await conversation.external(() =>
      api
        .editMessageReplyMarkup(question.chat.id, question.message_id, {
          reply_markup: new InlineKeyboard(),
        })
        .catch(() => {}),
    );
    return motivation;
  };
  const retryHint = current
    ? "Расскажите ещё раз — текстом или голосом — или нажмите «Оставить как есть»."
    : "Расскажите ещё раз — текстом или голосом — или нажмите «Пропустить».";

  for (;;) {
    const response = await conversation.wait();

    const data = response.callbackQuery?.data;
    if (data === MOTIVATION_SKIP_DATA) {
      await response.answerCallbackQuery();
      return done(current);
    }
    if (frame.backData && data === frame.backData) {
      await response.answerCallbackQuery();
      return done(BACK);
    }
    const voiceMatch = data?.match(voiceConfirmPattern("motivation"));
    if (voiceMatch) {
      const text = await settleVoiceConfirmation(response, voiceMatch[1] as VoiceConfirmAction, {
        reject: `Не сохраняю. ${retryHint}`,
        edit: `Пришлите исправленный вариант текстом (${COPY_TRANSCRIPT_HINT}) или голосом.`,
      });
      if (text !== undefined) return done(normalizeMotivation(text));
      continue;
    }
    if (data !== undefined) {
      await handleStrayCallback(conversation, response, mode, inQuestionnaire);
      continue;
    }

    const text = response.message?.text?.trim();
    if (text !== undefined) {
      if (isCancelInput(text)) {
        if (mode.cancel) await haltIfCancelled(conversation, response, mode.cancel);
        // Без отмены — первая анкета, её нужно пройти до конца.
        await response.reply(`Сначала ответьте на вопрос. ${retryHint}`);
        continue;
      }
      const motivation = normalizeMotivation(text);
      if (motivation !== null) return done(motivation);
      continue;
    }

    const voice = response.message?.voice;
    if (voice) {
      const transcript = await transcribeVoiceInConversation(conversation, api, response, voice);
      if (transcript !== undefined) {
        await response.reply(buildVoiceConfirmMessage(transcript), {
          reply_markup: voiceConfirmKeyboard("motivation"),
        });
      }
      continue;
    }

    if (response.message) {
      if (!inQuestionnaire) await conversation.halt({ next: true });
      await response.reply(withCancelHint(`Сейчас жду ответ на вопрос. ${retryHint}`, mode));
      continue;
    }
    await conversation.skip({ next: true });
  }
}

export function registerOnboarding(bot: Bot<MyContext>): void {
  // Пока анкета идёт, её кнопки перехватывает диалог; сюда попадаем, только если он
  // уже закончился или прервался (например, бот перезапускался).
  bot.callbackQuery(ONBOARDING_CALLBACK_PATTERN, async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "Анкета уже закрыта. Начать её снова можно в «⚙️ Меню» → «👤 Профиль».",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  });
}

interface OnboardingAnswers {
  sex?: Sex;
  age?: number;
  heightCm?: number;
  weightKg?: number;
  activityLevel?: ActivityLevel;
  goal?: Goal;
  timeZone?: string;
  motivation?: string | null;
}

// Все ключи анкеты — для проверки, что каждый шаг записал ответ.
const ANSWER_KEYS: Record<keyof OnboardingAnswers, true> = {
  sex: true,
  age: true,
  heightCm: true,
  weightKg: true,
  activityLevel: true,
  goal: true,
  timeZone: true,
  motivation: true,
};

function isComplete(answers: OnboardingAnswers): answers is Required<OnboardingAnswers> {
  return (Object.keys(ANSWER_KEYS) as (keyof OnboardingAnswers)[]).every(
    (key) => answers[key] !== undefined,
  );
}

export function onboardingConversation(db: Db, api: Api) {
  return async function onboarding(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Повторную анкету (профиль уже есть) можно отменить, и прежний ответ «зачем вам бот»
    // можно оставить как есть. Первую нужно пройти: без неё не посчитать норму.
    const previous = await conversation.external(() => getProfileByUserId(db, userId));
    const previousTimeZone = await conversation.external(
      () => getUserByTelegramId(db, userId)?.timezone ?? undefined,
    );
    const mode: OnboardingMode = previous
      ? { cancel: { cancelledText: "Анкета отменена — профиль остался прежним." } }
      : {};
    if (previous) {
      await ctx.reply(
        "🔄 Пройдём анкету заново. Профиль обновится только после последнего вопроса. " +
          "/cancel — отменить.",
      );
    }

    // Шаги по порядку; «◀️ Назад» возвращает на предыдущий, и на него отвечают заново.
    const answers: OnboardingAnswers = {};
    type Step = (frame: StepFrame) => Promise<Back | undefined>;

    // Запоминает ответ шага; BACK пробрасывает дальше — шаг ничего не записал.
    const save =
      <K extends keyof OnboardingAnswers>(key: K) =>
      (value: OnboardingAnswers[K] | Back): Back | undefined => {
        if (value === BACK) return BACK;
        answers[key] = value;
        return undefined;
      };

    const choice =
      <K extends "sex" | "activityLevel" | "goal">(
        key: K,
        spec: ChoiceSpec<NonNullable<OnboardingAnswers[K]>>,
      ): Step =>
      async (frame) =>
        save(key)(await askOnboardingChoice(conversation, ctx, api, frame, mode, spec));

    const number =
      (key: "age" | "heightCm" | "weightKg", text: string, range: NumberRange): Step =>
      async (frame) =>
        save(key)(await askOnboardingNumber(conversation, ctx, api, frame, mode, { text, range }));

    const steps: Step[] = [
      choice("sex", { text: "Укажите пол:", options: SEX_LABEL, words: SEX_WORDS, prefix: "sex" }),
      number("age", "Сколько вам лет?", { min: 10, max: 100, integer: true }),
      number("heightCm", "Какой у вас рост, см?", { min: 100, max: 250, integer: true }),
      number("weightKg", "Какой у вас текущий вес, кг?", { min: 30, max: 300, integer: false }),
      choice("activityLevel", {
        text: ACTIVITY_QUESTION,
        options: ACTIVITY_LABEL,
        words: ACTIVITY_WORDS,
        prefix: "activity",
      }),
      choice("goal", {
        text: "Какая у вас цель?",
        options: GOAL_LABEL,
        words: GOAL_WORDS,
        prefix: "goal",
      }),
      async (frame) =>
        save("timeZone")(
          await askOnboardingTimeZone(conversation, ctx, api, frame, mode, previousTimeZone),
        ),
      async (frame) =>
        save("motivation")(
          await askMotivation(conversation, ctx, api, previous?.motivation ?? null, {
            kind: "questionnaire",
            mode,
            frame,
          }),
        ),
    ];

    let step = 0;
    while (step < steps.length) {
      const frame: StepFrame = {
        title: `(${step + 1}/${steps.length}) `,
        backData: step > 0 ? backData(step) : undefined,
      };
      const result = await steps[step](frame);
      step += result === BACK ? -1 : 1;
    }

    // Сюда доходим, только пройдя все шаги, — каждый записал ответ.
    if (!isComplete(answers)) throw new Error("Анкета завершилась без всех ответов");
    const { sex, age, heightCm, weightKg, activityLevel, goal, timeZone, motivation } = answers;
    const targets = calculateDailyTargets({ sex, age, heightCm, weightKg, activityLevel, goal });

    await conversation.external(() =>
      db.transaction(() => {
        upsertProfile(db, userId, {
          sex,
          age,
          heightCm,
          weightKg,
          activityLevel,
          goal,
          motivation,
          ...targets,
        });
        addWeightEntry(db, userId, weightKg);
        setUserTimeZone(db, userId, timeZone);
      }),
    );

    const parts = [
      "🎯 Ваша дневная норма готова!",
      "",
      `${targets.dailyKcalTarget} ккал`,
      `Б ${targets.proteinGTarget.toFixed(1)} / Ж ${targets.fatGTarget.toFixed(1)} / ` +
        `У ${targets.carbGTarget.toFixed(1)}`,
      "",
      ...(motivation
        ? ["🐱 Запомнила, зачем вам бот, — буду учитывать это в советах.", ""]
        : []),
      "Присылайте фото еды, опишите текстом или голосовым сообщением, что съели.",
    ];

    await ctx.reply(parts.join("\n"), { reply_markup: mainKeyboard });
  };
}
