import { Bot, InlineKeyboard, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getUserTimeZone, setUserTimeZone } from "../db/users.js";
import {
  COMMON_TIMEZONES,
  formatLocalTime,
  formatTimeZone,
  isValidTimeZone,
  parseTimeZoneText,
} from "../utils/timezones.js";

type Db = BetterSQLite3Database<typeof schema>;

const SET_TIMEZONE_PREFIX = "settz:";

export const TIMEZONE_QUESTION = [
  "В каком часовом поясе вы живёте?",
  "",
  "По нему я определяю завтрак/обед/ужин, границы дня и время вечерней сводки. " +
    "Выберите город кнопкой или напишите свой город либо смещение — например, " +
    "«UTC+5» или «МСК+2».",
].join("\n");

export const TIMEZONE_HINT =
  "Не узнала пояс. Выберите город кнопкой или напишите крупный город рядом с вами, " +
  "смещение от UTC («UTC+5») или от Москвы («МСК+2»).";

// Частые пояса по два в ряд; текущий отмечен ✅.
export function timeZoneKeyboard(prefix: string, current?: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  Object.keys(COMMON_TIMEZONES).forEach((timeZone, index) => {
    const label = formatTimeZone(timeZone);
    keyboard.text(timeZone === current ? `✅ ${label}` : label, `${prefix}${timeZone}`);
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard.row();
}

// «Москва (UTC+3), сейчас 14:05».
export function describeTimeZone(timeZone: string, now: Date = new Date()): string {
  return `${formatTimeZone(timeZone, now)}, сейчас ${formatLocalTime(timeZone, now)}`;
}

function buildTimeZoneChangedMessage(timeZone: string): string {
  return (
    `🕐 Часовой пояс: ${describeTimeZone(timeZone)}.\n` +
    "Если время не совпадает с вашим — выберите другой пояс в профиле."
  );
}

async function sendTimeZonePicker(ctx: Context, db: Db, userId: number): Promise<void> {
  const current = getUserTimeZone(db, userId);
  await ctx.reply(
    [
      `🕐 Сейчас: ${describeTimeZone(current)}`,
      "",
      "Выберите пояс кнопкой. Нет вашего города — отправьте его командой, например: " +
        "/timezone Екатеринбург, /timezone UTC+5 или /timezone МСК+2.",
    ].join("\n"),
    { reply_markup: timeZoneKeyboard(SET_TIMEZONE_PREFIX, current).text("◀️ Назад", "menu:back") },
  );
}

export function registerTimeZone(bot: Bot<MyContext>, db: Db): void {
  bot.command("timezone", async (ctx) => {
    if (!ctx.from) return;

    const arg = ctx.match.trim();
    if (!arg) {
      await sendTimeZonePicker(ctx, db, ctx.from.id);
      return;
    }

    const timeZone = parseTimeZoneText(arg);
    if (!timeZone) {
      await ctx.reply(TIMEZONE_HINT);
      return;
    }
    setUserTimeZone(db, ctx.from.id, timeZone);
    await ctx.reply(buildTimeZoneChangedMessage(timeZone));
  });

  bot.callbackQuery("menu:timezone", async (ctx) => {
    if (!ctx.from) return;
    await ctx.answerCallbackQuery();
    await sendTimeZonePicker(ctx, db, ctx.from.id);
  });

  bot.callbackQuery(new RegExp(`^${SET_TIMEZONE_PREFIX}`), async (ctx) => {
    if (!ctx.from) return;
    const timeZone = ctx.callbackQuery.data.slice(SET_TIMEZONE_PREFIX.length);
    await ctx.answerCallbackQuery();
    if (!isValidTimeZone(timeZone)) return;

    setUserTimeZone(db, ctx.from.id, timeZone);
    await ctx.editMessageText(buildTimeZoneChangedMessage(timeZone));
  });
}
