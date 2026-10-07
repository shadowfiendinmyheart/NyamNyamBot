import { Bot, InlineKeyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { config } from "../config.js";
import {
  getNotificationSettings,
  normalizeSummaryTime,
  updateNotificationSettings,
  type NotificationSettings,
} from "../db/users.js";
import { isMessageNotModified } from "../utils/telegram.js";

type Db = BetterSQLite3Database<typeof schema>;

export const NOTIFICATIONS_BUTTON = "🔔 Уведомления";
// Где выключить напоминания — подсказка под ними.
export const NOTIFICATIONS_PATH = `«⚙️ Меню» → «👤 Профиль» → «${NOTIFICATIONS_BUTTON}»`;

const TOGGLE_PREFIX = "notif:toggle:";
const SET_TIME_PREFIX = "notif:settime:";

type ToggleKey = "eveningSummaryEnabled" | "weeklyReportEnabled" | "remindersEnabled";

const TOGGLES: Record<string, ToggleKey> = {
  summary: "eveningSummaryEnabled",
  weekly: "weeklyReportEnabled",
  reminders: "remindersEnabled",
};

// Время вечерней сводки на выбор: с 18:00 до 23:30 каждые полчаса. Сводка — итог
// «сегодня», так что позже полуночи её ставить незачем.
export const SUMMARY_TIME_OPTIONS: string[] = Array.from({ length: 12 }, (_, index) => {
  const minutes = 18 * 60 + index * 30;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${minutes % 60 ? "30" : "00"}`;
});

function onOff(enabled: boolean): string {
  return enabled ? "✅ вкл" : "⛔ выкл";
}

export function buildNotificationsMessage(
  settings: NotificationSettings,
  weeklyReportTime: string = config.weeklyReportTime,
): string {
  return [
    `${NOTIFICATIONS_BUTTON}`,
    "",
    `🌙 Вечерняя сводка — ${onOff(settings.eveningSummaryEnabled)}, ` +
      `в ${settings.eveningSummaryTime}. Итоги дня и мой комментарий.`,
    `📅 Недельный отчёт — ${onOff(settings.weeklyReportEnabled)}, ` +
      `по воскресеньям в ${weeklyReportTime}.`,
    `⏰ Напоминания — ${onOff(settings.remindersEnabled)}. Напомню взвеситься, ` +
      "если вес не обновлялся неделю, и про пропущенный обед или ужин.",
    "",
    "Время — по вашему часовому поясу. Нажмите на пункт, чтобы включить или выключить.",
  ].join("\n");
}

export function notificationsKeyboard(settings: NotificationSettings): InlineKeyboard {
  const mark = (enabled: boolean) => (enabled ? "✅" : "⛔");
  return new InlineKeyboard()
    .text(`${mark(settings.eveningSummaryEnabled)} Сводка`, `${TOGGLE_PREFIX}summary`)
    .text(`🕐 Время: ${settings.eveningSummaryTime}`, "notif:time")
    .row()
    .text(`${mark(settings.weeklyReportEnabled)} Недельный отчёт`, `${TOGGLE_PREFIX}weekly`)
    .text(`${mark(settings.remindersEnabled)} Напоминания`, `${TOGGLE_PREFIX}reminders`)
    .row()
    .text("◀️ Назад", "menu:profile");
}

// Варианты времени по три в ряд; текущее отмечено ✅.
export function summaryTimeKeyboard(current: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  SUMMARY_TIME_OPTIONS.forEach((time, index) => {
    keyboard.text(time === current ? `✅ ${time}` : time, `${SET_TIME_PREFIX}${time}`);
    if (index % 3 === 2) keyboard.row();
  });
  return keyboard.row().text("◀️ Назад", "menu:notifications");
}

export function registerNotifications(bot: Bot<MyContext>, db: Db): void {
  async function showSettings(ctx: MyContext, userId: number): Promise<void> {
    const settings = getNotificationSettings(db, userId);
    try {
      await ctx.editMessageText(buildNotificationsMessage(settings), {
        reply_markup: notificationsKeyboard(settings),
      });
    } catch (err) {
      if (!isMessageNotModified(err)) throw err;
    }
  }

  bot.callbackQuery("menu:notifications", async (ctx) => {
    await ctx.answerCallbackQuery();
    await showSettings(ctx, ctx.from.id);
  });

  bot.callbackQuery(new RegExp(`^${TOGGLE_PREFIX}(\\w+)$`), async (ctx) => {
    const key = TOGGLES[ctx.match[1]];
    if (!key) {
      await ctx.answerCallbackQuery();
      return;
    }
    const enabled = !getNotificationSettings(db, ctx.from.id)[key];
    updateNotificationSettings(db, ctx.from.id, { [key]: enabled });
    await ctx.answerCallbackQuery({ text: enabled ? "Включила 🔔" : "Выключила 🔕" });
    await showSettings(ctx, ctx.from.id);
  });

  bot.callbackQuery("notif:time", async (ctx) => {
    await ctx.answerCallbackQuery();
    const { eveningSummaryTime } = getNotificationSettings(db, ctx.from.id);
    await ctx.editMessageText(
      "🌙 Во сколько присылать вечернюю сводку? Время — по вашему часовому поясу.",
      { reply_markup: summaryTimeKeyboard(eveningSummaryTime) },
    );
  });

  bot.callbackQuery(new RegExp(`^${SET_TIME_PREFIX}(.+)$`), async (ctx) => {
    const time = normalizeSummaryTime(ctx.match[1]);
    if (!time) {
      await ctx.answerCallbackQuery();
      return;
    }
    // Выбор времени заодно включает сводку: иначе новое время ни на что не влияет.
    updateNotificationSettings(db, ctx.from.id, {
      eveningSummaryTime: time,
      eveningSummaryEnabled: true,
    });
    await ctx.answerCallbackQuery({ text: `Пришлю сводку в ${time}` });
    await showSettings(ctx, ctx.from.id);
  });
}
