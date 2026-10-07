import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Api, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getProfileByUserId, upsertProfile } from "../db/profiles.js";
import { addWeightEntry } from "../db/weightLog.js";
import { isCancelInput, mainKeyboard } from "./mainMenu.js";
import { ACTIVITY_LABEL, ACTIVITY_QUESTION, GOAL_LABEL, SEX_LABEL } from "./profile.js";
import { calculateDailyTargets } from "../nutrition/calculations.js";
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
export async function askMotivation(
  conversation: MyConversation,
  ctx: Context,
  api: Api,
  current: string | null,
  cancel?: CancelOptions,
): Promise<string | null> {
  const question = await ctx.reply(MOTIVATION_QUESTION, {
    reply_markup: new InlineKeyboard().text(
      current ? "✅ Оставить как есть" : "⏭ Пропустить",
      MOTIVATION_SKIP_DATA,
    ),
  });
  const done = async (motivation: string | null): Promise<string | null> => {
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

    // Прочие обновления: в онбординге игнорируем (как askNumber без cancel), при правке
    // из профиля — сообщение закрывает диалог, чужие кнопки обрабатываются как обычно.
    if (cancel) {
      if (response.message) await conversation.halt({ next: true });
      await conversation.skip({ next: true });
    }
  }
}

export function onboardingConversation(db: Db, api: Api) {
  return async function onboarding(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    // При повторной анкете прежний ответ «зачем вам бот» можно оставить как есть.
    const previous = await conversation.external(() => getProfileByUserId(db, userId));

    const sex = await askChoice(conversation, ctx, "Укажите пол:", SEX_LABEL, "sex");
    const age = await askNumber(conversation, ctx, "Сколько вам лет?", {
      min: 10,
      max: 100,
      integer: true,
    });
    const heightCm = await askNumber(conversation, ctx, "Какой у вас рост, см?", {
      min: 100,
      max: 250,
      integer: true,
    });
    const weightKg = await askNumber(conversation, ctx, "Какой у вас текущий вес, кг?", {
      min: 30,
      max: 300,
      integer: false,
    });
    const activityLevel = await askChoice(
      conversation,
      ctx,
      ACTIVITY_QUESTION,
      ACTIVITY_LABEL,
      "activity",
    );
    const goal = await askChoice(conversation, ctx, "Какая у вас цель?", GOAL_LABEL, "goal");
    const motivation = await askMotivation(
      conversation,
      ctx,
      api,
      previous?.motivation ?? null,
    );

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
