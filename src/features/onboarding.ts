import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { upsertProfile } from "../db/profiles.js";
import { addWeightEntry } from "../db/weightLog.js";
import { isCancelInput, mainKeyboard } from "./mainMenu.js";
import { ACTIVITY_LABEL, ACTIVITY_QUESTION, GOAL_LABEL, SEX_LABEL } from "./profile.js";
import { calculateDailyTargets } from "../nutrition/calculations.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

// С cancel вопрос можно бросить: команда или кнопка меню завершает диалог; сообщение
// вместо ответа (фото, еда или тренировка текстом) тоже закрывает диалог и уходит
// обычным обработчикам; чужие кнопки обрабатываются как обычно, а вопрос ждёт дальше.
// Без cancel диалог ждёт только свой ответ (онбординг пройти обязательно).
export interface CancelOptions {
  cancelledText: string;
}

async function haltIfCancelled(
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

export function onboardingConversation(db: Db) {
  return async function onboarding(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

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
      "Присылайте фото еды, опишите текстом или голосовым сообщением, что съели.",
    ];

    await ctx.reply(parts.join("\n"), { reply_markup: mainKeyboard });
  };
}
