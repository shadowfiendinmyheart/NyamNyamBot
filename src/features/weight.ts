import type { Conversation } from "@grammyjs/conversations";
import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import { config } from "../config.js";
import type { MyContext } from "../context.js";
import {
  getProfileByUserId,
  updateProfileMetrics,
  type ProfileRow,
  type ProfileUpdateResult,
} from "../db/profiles.js";
import { getWeightHistory, logWeight, type WeightLogRow } from "../db/weightLog.js";
import type { ActivityLevel } from "../nutrition/calculations.js";
import { askNumber } from "./onboarding.js";
import { ACTIVITY_LABEL, ACTIVITY_QUESTION } from "./profile.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

export const MIN_WEIGHT_KG = 30;
export const MAX_WEIGHT_KG = 300;
const HISTORY_SIZE = 5;
const SET_ACTIVITY_PREFIX = "setactivity:";

const NO_PROFILE_TEXT =
  "Сначала заполните анкету — без неё не из чего пересчитывать норму. " +
  "Меню → «🔄 Пройти анкету заново».";

function roundWeight(value: number): number {
  return Math.round(value * 10) / 10;
}

export function parseWeight(text: string): number | undefined {
  const value = Number(text.trim().replace(",", "."));
  if (!Number.isFinite(value) || value < MIN_WEIGHT_KG || value > MAX_WEIGHT_KG) {
    return undefined;
  }
  return roundWeight(value);
}

function formatSigned(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return "0";
  return rounded > 0 ? `+${rounded}` : `−${Math.abs(rounded)}`;
}

function buildTargetsLines(before: ProfileRow, after: ProfileRow): string[] {
  const kcalLine =
    before.dailyKcalTarget === after.dailyKcalTarget
      ? `${after.dailyKcalTarget} ккал (без изменений)`
      : `${before.dailyKcalTarget} → ${after.dailyKcalTarget} ккал ` +
        `(${formatSigned(after.dailyKcalTarget - before.dailyKcalTarget)})`;

  return [
    "🎯 Дневная норма:",
    kcalLine,
    `Б ${after.proteinGTarget.toFixed(1)} / Ж ${after.fatGTarget.toFixed(1)} / ` +
      `У ${after.carbGTarget.toFixed(1)}`,
  ];
}

export function buildWeightLoggedMessage({ before, after }: ProfileUpdateResult): string {
  const delta = after.weightKg - before.weightKg;
  const deltaText = Math.round(delta * 10) === 0 ? "без изменений" : `${formatSigned(delta)} кг`;

  return [
    `⚖️ Вес записан: ${after.weightKg} кг (${deltaText})`,
    "",
    ...buildTargetsLines(before, after),
    "",
    `Активность: ${ACTIVITY_LABEL[after.activityLevel]}. Если начали тренироваться ` +
      "или стали двигаться меньше — обновите её, и норма пересчитается.",
  ].join("\n");
}

export function buildActivityChangedMessage({ before, after }: ProfileUpdateResult): string {
  if (before.activityLevel === after.activityLevel) {
    return `Уровень активности не изменился: ${ACTIVITY_LABEL[after.activityLevel]}.`;
  }

  return [
    `🏃 Активность: ${ACTIVITY_LABEL[before.activityLevel]} → ` +
      `${ACTIVITY_LABEL[after.activityLevel]}`,
    "",
    ...buildTargetsLines(before, after),
  ].join("\n");
}

export function buildWeightHistoryMessage(
  profile: ProfileRow,
  history: WeightLogRow[],
  timeZone: string,
): string {
  const lines = [`Текущий вес в профиле: ${profile.weightKg} кг`];
  if (history.length > 0) {
    lines.push("", "Последние записи:");
    for (const entry of history) {
      const date = entry.loggedAt.toLocaleDateString("ru-RU", { timeZone });
      lines.push(`${date} — ${entry.weightKg} кг`);
    }
  }
  return lines.join("\n");
}

function afterWeightKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("🏃 Изменить активность", "menu:activity");
}

function activityKeyboard(current: ActivityLevel): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const [value, label] of Object.entries(ACTIVITY_LABEL) as [ActivityLevel, string][]) {
    keyboard.text(value === current ? `✅ ${label}` : label, `${SET_ACTIVITY_PREFIX}${value}`).row();
  }
  return keyboard.text("◀️ Назад", "menu:back");
}

async function sendActivityPicker(ctx: Context, db: Db, userId: number) {
  const profile = getProfileByUserId(db, userId);
  if (!profile) {
    await ctx.reply(NO_PROFILE_TEXT);
    return;
  }
  await ctx.reply(`${ACTIVITY_QUESTION}\n\nСейчас: ${ACTIVITY_LABEL[profile.activityLevel]}`, {
    reply_markup: activityKeyboard(profile.activityLevel),
  });
}

async function replyWeightLogged(ctx: Context, result: ProfileUpdateResult | undefined) {
  if (!result) {
    await ctx.reply(NO_PROFILE_TEXT);
    return;
  }
  await ctx.reply(buildWeightLoggedMessage(result), { reply_markup: afterWeightKeyboard() });
}

export function weightConversation(db: Db) {
  return async function weight(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const snapshot = await conversation.external(() => {
      const profile = getProfileByUserId(db, userId);
      return profile ? { profile, history: getWeightHistory(db, userId, HISTORY_SIZE) } : undefined;
    });
    if (!snapshot) {
      await ctx.reply(NO_PROFILE_TEXT);
      return;
    }

    await ctx.reply(
      buildWeightHistoryMessage(snapshot.profile, snapshot.history, config.defaultTimezone),
    );
    const weightKg = await askNumber(conversation, ctx, "Введите текущий вес, кг:", {
      min: MIN_WEIGHT_KG,
      max: MAX_WEIGHT_KG,
      integer: false,
    });

    const result = await conversation.external(() =>
      logWeight(db, userId, roundWeight(weightKg)),
    );
    await replyWeightLogged(ctx, result);
  };
}

export function registerWeight(bot: Bot<MyContext>, db: Db): void {
  bot.command("weight", async (ctx) => {
    if (!ctx.from) return;

    const arg = ctx.match.trim();
    if (!arg) {
      if (ctx.conversation.active("weight")) return;
      await ctx.conversation.enter("weight");
      return;
    }

    const weightKg = parseWeight(arg);
    if (weightKg === undefined) {
      await ctx.reply(
        `Не понял вес. Пример: /weight 78.5 (от ${MIN_WEIGHT_KG} до ${MAX_WEIGHT_KG} кг).`,
      );
      return;
    }
    await replyWeightLogged(ctx, logWeight(db, ctx.from.id, weightKg));
  });

  bot.callbackQuery("menu:weight", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.conversation.active("weight")) return;
    await ctx.conversation.enter("weight");
  });

  bot.command("activity", async (ctx) => {
    if (!ctx.from) return;
    await sendActivityPicker(ctx, db, ctx.from.id);
  });

  bot.callbackQuery("menu:activity", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await sendActivityPicker(ctx, db, ctx.from.id);
  });

  bot.callbackQuery(new RegExp(`^${SET_ACTIVITY_PREFIX}`), async (ctx) => {
    if (!ctx.from) return;
    const level = ctx.callbackQuery.data.slice(SET_ACTIVITY_PREFIX.length);
    if (!(level in ACTIVITY_LABEL)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const result = updateProfileMetrics(db, ctx.from.id, {
      activityLevel: level as ActivityLevel,
    });
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(result ? buildActivityChangedMessage(result) : NO_PROFILE_TEXT);
  });
}
