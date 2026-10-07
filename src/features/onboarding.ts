import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Api, type Bot, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getProfileByUserId, upsertProfile } from "../db/profiles.js";
import { addWeightEntry } from "../db/weightLog.js";
import { isCancelInput, mainKeyboard } from "./mainMenu.js";
import { ACTIVITY_LABEL, ACTIVITY_QUESTION, GOAL_LABEL, SEX_LABEL } from "./profile.js";
import {
  calculateDailyTargets,
  type ActivityLevel,
  type Goal,
  type Sex,
} from "../nutrition/calculations.js";
import {
  buildVoiceConfirmMessage,
  settleVoiceConfirmation,
  transcribeVoiceInConversation,
  voiceConfirmKeyboard,
  voiceConfirmPattern,
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

export async function askChoice<T extends string>(
  conversation: MyConversation,
  ctx: Context,
  question: string,
  options: Record<T, string>,
  prefix: string,
  cancel?: CancelOptions,
): Promise<T> {
  const keyboard = new InlineKeyboard();
  for (const [value, label] of Object.entries(options) as [T, string][]) {
    keyboard.text(label, `${prefix}:${value}`).row();
  }
  await ctx.reply(question, { reply_markup: keyboard });

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
  options: { min: number; max: number; integer: boolean },
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
    const value = Number(text.trim().replace(",", "."));
    // Не число вообще — это обычное сообщение (например, тренировка текстом), а не ответ.
    if (cancel && !Number.isFinite(value)) await conversation.halt({ next: true });

    if (
      Number.isFinite(value) &&
      value >= options.min &&
      value <= options.max &&
      (!options.integer || Number.isInteger(value))
    ) {
      return value;
    }

    await response.reply(
      `Введите число от ${options.min} до ${options.max}${options.integer ? "" : ", можно с десятичной частью"}.`,
    );
  }
}

// --- Анкета: шаг назад, ответы текстом, подсказки на посторонний ввод ---

export const ONBOARDING_BACK_DATA = "onb:back";
const BACK_LABEL = "◀️ Назад";
// Префиксы кнопок анкеты — по ним узнаём нажатия под уже пройденными вопросами.
export const ONBOARDING_CALLBACK_PATTERN = /^(sex|activity|goal|onb):/;

export const BACK = Symbol("back");
export type Back = typeof BACK;

// Режим анкеты: первая — обязательная (без неё нет нормы), повторная — из меню, с отменой.
interface OnboardingMode {
  cancel?: CancelOptions;
}

const FINISH_FIRST_TEXT =
  "Сначала закончите анкету — без неё не посчитать дневную норму. Осталось совсем немного 🙂";

function withCancelHint(text: string, mode: OnboardingMode): string {
  return mode.cancel ? `${text}\n/cancel — отменить анкету.` : text;
}

function normalizeAnswer(text: string): string {
  return text
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Ответ текстом на вопрос с кнопками: номер варианта («2»), название варианта или
// слово из words в любом слове ответа (короткие — точное совпадение, длинные — начало
// слова: «мужской» → «муж»). Если подходят несколько — побеждает самое раннее слово:
// «очень высокая» → «очень», а не «высок».
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

  for (const answerWord of answer.split(" ")) {
    const value = values.find((candidate) =>
      (words[candidate] ?? []).some((word) =>
        word.length < 3 ? answerWord === word : answerWord.startsWith(word),
      ),
    );
    if (value) return value;
  }
  return undefined;
}

// Число из ответа, единицы после него допустимы: «175 см», «78,5 кг», «30 лет».
export function parseNumberAnswer(
  text: string,
  options: { min: number; max: number; integer: boolean },
): number | undefined {
  const match = /^(\d+(?:[.,]\d+)?)\s*[a-zа-яё.]*$/i.exec(text.trim());
  if (!match) return undefined;
  const value = Number(match[1].replace(",", "."));
  if (value < options.min || value > options.max) return undefined;
  if (options.integer && !Number.isInteger(value)) return undefined;
  return value;
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
  very_active: ["очень"],
};

export const GOAL_WORDS: Partial<Record<Goal, string[]>> = {
  lose: ["похуд", "сброс", "скинут", "снизит"],
  maintain: ["поддерж", "сохран", "удерж"],
  gain: ["набор", "набрат", "масс"],
};

// Нажатие кнопки, которая не отвечает на текущий вопрос. Кнопки прошлых вопросов анкеты
// не работают; прочие в повторной анкете обрабатываются как обычно, а в первой — ждут.
async function handleStrayCallback(
  conversation: MyConversation,
  response: Context,
  mode: OnboardingMode,
): Promise<void> {
  const data = response.callbackQuery?.data ?? "";
  if (ONBOARDING_CALLBACK_PATTERN.test(data)) {
    await response.answerCallbackQuery({
      text: "Этот вопрос уже пройден — ответьте на последний вопрос анкеты.",
    });
    return;
  }
  if (mode.cancel) await conversation.skip({ next: true });
  await response.answerCallbackQuery({ text: FINISH_FIRST_TEXT, show_alert: true });
}

// Команда или кнопка главного меню посреди анкеты: в повторной — отмена, в первой — просьба
// закончить. true — ввод обработан и вопрос ждёт дальше.
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
  // Есть ли «◀️ Назад» (у первого вопроса нет).
  back: boolean;
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
  const message = await ctx.reply(question.text, { reply_markup: question.keyboard });

  // Убираем кнопки у вопроса, на который ответили, чтобы их нельзя было нажать позже.
  const close = (label?: string) =>
    conversation.external(async () => {
      const { chat, message_id: messageId } = message;
      const empty = { reply_markup: new InlineKeyboard() };
      await (label
        ? api.editMessageText(chat.id, messageId, `${question.text}\n\n✅ ${label}`, empty)
        : api.editMessageReplyMarkup(chat.id, messageId, empty)
      ).catch(() => {});
    });

  for (;;) {
    const response = await conversation.wait();

    const data = response.callbackQuery?.data;
    if (data !== undefined) {
      if (data === ONBOARDING_BACK_DATA && question.back) {
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
      await handleStrayCallback(conversation, response, mode);
      continue;
    }

    const text = response.message?.text?.trim();
    if (text !== undefined) {
      if (await handleMenuInput(conversation, response, text, mode)) continue;
      const parsed = question.fromText(text);
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

function backKeyboard(keyboard = new InlineKeyboard()): InlineKeyboard {
  return keyboard.text(BACK_LABEL, ONBOARDING_BACK_DATA);
}

function askOnboardingChoice<T extends string>(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  text: string,
  options: Record<T, string>,
  words: Partial<Record<T, string[]>>,
  prefix: string,
  back: boolean,
  mode: OnboardingMode,
): Promise<T | Back> {
  const keyboard = new InlineKeyboard();
  for (const [value, label] of Object.entries(options) as [T, string][]) {
    keyboard.text(label, `${prefix}:${value}`).row();
  }
  const hint = "Выберите вариант кнопкой под вопросом или напишите его словами.";
  return askQuestion<T>(
    conversation,
    ctx,
    api,
    {
      text,
      back,
      keyboard: back ? backKeyboard(keyboard) : keyboard,
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
  text: string,
  options: { min: number; max: number; integer: boolean },
  back: boolean,
  mode: OnboardingMode,
): Promise<number | Back> {
  const hint =
    `Введите число от ${options.min} до ${options.max}` +
    `${options.integer ? "" : ", можно с десятичной частью"}.`;
  return askQuestion<number>(
    conversation,
    ctx,
    api,
    {
      text,
      back,
      keyboard: back ? backKeyboard() : undefined,
      fromText: (answer) => {
        const value = parseNumberAnswer(answer, options);
        return value === undefined ? { hint } : { value };
      },
      nonTextHint: `Сейчас жду ответ числом. ${hint}`,
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

// Открытый вопрос «зачем вам бот» — ответ текстом или голосом (голос — только после
// подтверждения расшифровки). Кнопка под вопросом оставляет current: «Пропустить», если
// ответа ещё нет, и «Оставить как есть», если есть. Расшифровка хранится в тексте
// сообщения с кнопками «Да/Нет», поэтому отдельного состояния для голоса не нужно.
// back — вопрос задаётся внутри анкеты: есть «◀️ Назад», а на посторонние сообщения
// отвечаем подсказкой. Без back (правка из профиля) такое сообщение закрывает диалог.
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  options: { cancel?: CancelOptions; back: true },
): Promise<string | null | Back>;
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  options?: { cancel?: CancelOptions; back?: false },
): Promise<string | null>;
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  { cancel, back = false }: { cancel?: CancelOptions; back?: boolean } = {},
): Promise<string | null | Back> {
  const keyboard = new InlineKeyboard().text(
    current ? "✅ Оставить как есть" : "⏭ Пропустить",
    MOTIVATION_SKIP_DATA,
  );
  const question = await ctx.reply(MOTIVATION_QUESTION, {
    reply_markup: back ? backKeyboard(keyboard.row()) : keyboard,
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
    if (cancel) await haltIfCancelled(conversation, response, cancel);

    const data = response.callbackQuery?.data;
    if (data === MOTIVATION_SKIP_DATA) {
      await response.answerCallbackQuery();
      return done(current);
    }
    if (data === ONBOARDING_BACK_DATA && back) {
      await response.answerCallbackQuery();
      return done(BACK);
    }
    const voiceMatch = data?.match(voiceConfirmPattern("motivation"));
    if (voiceMatch) {
      const text = await settleVoiceConfirmation(
        response,
        voiceMatch[1] === "yes",
        `Не сохраняю. ${retryHint}`,
      );
      if (text !== undefined) return done(normalizeMotivation(text));
      continue;
    }

    const text = response.message?.text?.trim();
    if (text !== undefined) {
      // Сюда команды и кнопки меню доходят только в онбординге (без cancel): его
      // нужно пройти до конца.
      if (isCancelInput(text)) {
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

    if (data !== undefined) {
      await handleStrayCallback(conversation, response, { cancel });
      continue;
    }
    // Прочие сообщения (фото…): в анкете — подсказка, при правке из профиля сообщение
    // закрывает диалог и уходит обычным обработчикам.
    if (response.message) {
      if (!back) await conversation.halt({ next: true });
      await response.reply(withCancelHint(`Сейчас жду ответ на вопрос. ${retryHint}`, { cancel }));
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
      text: "Анкета уже закрыта. Пройти её заново: «⚙️ Меню» → «🔄 Пройти анкету заново».",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  });
}

export function onboardingConversation(db: Db, api: Api) {
  return async function onboarding(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // Повторную анкету (профиль уже есть) можно отменить, и прежний ответ «зачем вам бот»
    // можно оставить как есть. Первую нужно пройти: без неё не посчитать норму.
    const previous = await conversation.external(() => getProfileByUserId(db, userId));
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
    const answers: {
      sex?: Sex;
      age?: number;
      heightCm?: number;
      weightKg?: number;
      activityLevel?: ActivityLevel;
      goal?: Goal;
      motivation?: string | null;
    } = {};

    // Запоминает ответ шага; BACK пробрасывает дальше — шаг ничего не записал.
    const keep =
      <K extends keyof typeof answers>(key: K) =>
      (value: (typeof answers)[K] | Back): Back | undefined => {
        if (value === BACK) return BACK;
        answers[key] = value;
        return undefined;
      };

    const steps: Array<(title: string, back: boolean) => Promise<Back | undefined>> = [
      async (title, back) =>
        keep("sex")(
          await askOnboardingChoice(conversation, ctx, api, `${title}Укажите пол:`,
            SEX_LABEL, SEX_WORDS, "sex", back, mode),
        ),
      async (title, back) =>
        keep("age")(
          await askOnboardingNumber(conversation, ctx, api, `${title}Сколько вам лет?`,
            { min: 10, max: 100, integer: true }, back, mode),
        ),
      async (title, back) =>
        keep("heightCm")(
          await askOnboardingNumber(conversation, ctx, api, `${title}Какой у вас рост, см?`,
            { min: 100, max: 250, integer: true }, back, mode),
        ),
      async (title, back) =>
        keep("weightKg")(
          await askOnboardingNumber(conversation, ctx, api, `${title}Какой у вас текущий вес, кг?`,
            { min: 30, max: 300, integer: false }, back, mode),
        ),
      async (title, back) =>
        keep("activityLevel")(
          await askOnboardingChoice(conversation, ctx, api, `${title}${ACTIVITY_QUESTION}`,
            ACTIVITY_LABEL, ACTIVITY_WORDS, "activity", back, mode),
        ),
      async (title, back) =>
        keep("goal")(
          await askOnboardingChoice(conversation, ctx, api, `${title}Какая у вас цель?`,
            GOAL_LABEL, GOAL_WORDS, "goal", back, mode),
        ),
      async () =>
        keep("motivation")(
          await askMotivation(conversation, ctx, api, previous?.motivation ?? null, {
            ...mode,
            back: true,
          }),
        ),
    ];

    let step = 0;
    while (step < steps.length) {
      const result = await steps[step](`(${step + 1}/${steps.length}) `, step > 0);
      step += result === BACK ? -1 : 1;
    }

    // Все шаги пройдены, значит каждый записал свой ответ.
    const { sex, age, heightCm, weightKg, activityLevel, goal, motivation = null } =
      answers as Required<typeof answers>;
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
        ? ["🐱 Ням-Ням запомнила, зачем вам бот, и будет учитывать это в советах.", ""]
        : []),
      "Присылайте фото еды, опишите текстом или голосовым сообщением, что съели.",
    ];

    await ctx.reply(parts.join("\n"), { reply_markup: mainKeyboard });
  };
}
