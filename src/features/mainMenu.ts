import { Bot, InlineKeyboard, Keyboard } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import {
  FINISH_CONVERSATION_FIRST_TEXT,
  hasActiveConversation,
  type MyContext,
} from "../context.js";
import { deleteProfile, getProfileByUserId } from "../db/profiles.js";
import { getUserTimeZone } from "../db/users.js";
import {
  buildProfileMessage,
  FILL_PROFILE_BUTTON,
  FILL_PROFILE_DATA,
  fillProfileKeyboard,
  RESTART_ONBOARDING_BUTTON,
} from "./profile.js";
import { NOTIFICATIONS_BUTTON } from "./notifications.js";
import { sendDayView } from "./history.js";

type Db = BetterSQLite3Database<typeof schema>;

export const TODAY_BUTTON = "📋 Сегодня";
export const MENU_BUTTON = "⚙️ Меню";
export const COACH_BUTTON = "🐱 Спросить Ням-Ням";
// Клавиатура режима разговора с Ням-Ням (features/coach) вместо главной.
export const COACH_EXIT_BUTTON = "✖️ Завершить разговор";

// Выход из пошагового диалога: любая команда или кнопка главного меню / режима коуча.
export function isCancelInput(text: string): boolean {
  return (
    text.startsWith("/") ||
    [TODAY_BUTTON, MENU_BUTTON, COACH_BUTTON, COACH_EXIT_BUTTON].includes(text)
  );
}

export const mainKeyboard = new Keyboard()
  .text(TODAY_BUTTON)
  .text(MENU_BUTTON)
  .row()
  .text(COACH_BUTTON)
  .resized()
  .persistent();

export const HELP_TEXT = [
  "🐱 Я Ням-Ням — считаю КБЖУ и веду ваш дневник питания.",
  "",
  "🍽 Пришлите фото еды, опишите текстом или голосовым, что съели, — я посчитаю калории " +
    "и БЖУ. К фото можно добавить подпись («без сахара», «половина порции») — учту её. " +
    "Несколько фото одного приёма пищи (суп и второе) — отправьте альбомом.",
  "✏️ Если я ошиблась с оценкой — нажмите «✏️ Изменить» под записью и напишите, что не так. " +
    "«🕐 Время» — поменять приём пищи или день, «🗑 Удалить» — убрать запись (можно «↩️ Вернуть»).",
  "🕐 Забыли записать вовремя? Напишите, когда ели: «вчера на ужин…», «в 9 утра…».",
  "🏋️ Тренировку просто опишите: «бегал 40 минут». ⚖️ Вес — просто числом: «78.5».",
  "",
  `${TODAY_BUTTON} — дневник за сегодня и сколько осталось до нормы; ◀️ — прошлые дни, ` +
    "🔁 — записать ту же еду ещё раз.",
  `${MENU_BUTTON} — вес, тренировка и профиль: норма, активность, часовой пояс, ` +
    `«${NOTIFICATIONS_BUTTON}», анкета.`,
  `${COACH_BUTTON} — поговорить со мной о питании, тренировках, самочувствии и срывах. ` +
    "Я вижу ваш профиль, дневник, тренировки и вес. Напишете в разговоре, что съели, — " +
    `предложу записать в дневник. «${COACH_EXIT_BUTTON}» — вернуться к записи еды.`,
].join("\n");

export const WELCOME_BACK_TEXT = [
  "🐱 С возвращением! Профиль уже настроен — просто присылайте фото еды, описание " +
    "текстом или голосовым.",
  "",
  `${TODAY_BUTTON} — что уже съедено сегодня и сколько осталось до нормы.`,
  `${MENU_BUTTON} — вес, тренировки, профиль и уведомления.`,
].join("\n");

const MENU_TEXT = "⚙️ Меню";

// Частые действия — сверху, по два в ряд. Анкета, удаление профиля и настройки —
// внутри «👤 Профиль».
function menuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("⚖️ Вес", "menu:weight")
    .text("🏋️ Тренировка", "menu:workout")
    .row()
    .text("👤 Профиль", "menu:profile")
    .text("❓ Помощь", "menu:help");
}

function backKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("◀️ Назад", "menu:back");
}

// Без профиля править нечего — только заполнить анкету (пояс и уведомления живут
// отдельно от анкеты и доступны всегда).
export function profileKeyboard(hasProfile: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (hasProfile) {
    keyboard
      .text("🏃 Активность", "menu:activity")
      .text("🕐 Часовой пояс", "menu:timezone")
      .row()
      .text(NOTIFICATIONS_BUTTON, "menu:notifications")
      .text("✍️ Зачем мне бот", "menu:motivation")
      .row()
      .text(RESTART_ONBOARDING_BUTTON, "menu:restart")
      .text("🗑 Удалить профиль", "menu:reset");
  } else {
    keyboard
      .text(FILL_PROFILE_BUTTON, FILL_PROFILE_DATA)
      .row()
      .text("🕐 Часовой пояс", "menu:timezone")
      .text(NOTIFICATIONS_BUTTON, "menu:notifications");
  }
  return keyboard.row().text("◀️ Назад", "menu:back");
}

export const RESET_CONFIRM_TEXT = [
  "🗑 Удалить профиль?",
  "",
  "Удалю анкету: пол, возраст, рост, цель, уровень активности, дневную норму КБЖУ " +
    "и ответ «зачем мне бот».",
  "",
  "Останутся дневник питания, тренировки, история веса, часовой пояс и настройки " +
    "уведомлений — после новой анкеты всё будет на месте.",
].join("\n");

const PROFILE_DELETED_TEXT =
  "🗑 Профиль удалён. Дневник, тренировки и история веса на месте. Чтобы я снова " +
  `считала норму, нажмите «${FILL_PROFILE_BUTTON}».`;

export function resetConfirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Да, удалить", "menu:reset_do")
    .text("❌ Отмена", "menu:profile");
}

// Экран «👤 Профиль»: анкета и норма, кнопки — в зависимости от того, есть ли профиль.
export function buildProfileView(
  db: Db,
  userId: number,
): { text: string; reply_markup: InlineKeyboard } {
  const profile = getProfileByUserId(db, userId);
  return {
    text: buildProfileMessage(profile, getUserTimeZone(db, userId)),
    reply_markup: profileKeyboard(profile !== undefined),
  };
}

async function startOnboarding(ctx: MyContext): Promise<void> {
  // Повторная анкета пропускает чужие кнопки к обычным обработчикам — в том числе эти.
  if (ctx.conversation.active("onboarding")) return;
  await ctx.conversation.enter("onboarding");
}

export function registerMainMenu(bot: Bot<MyContext>, db: Db): void {
  bot.hears(TODAY_BUTTON, async (ctx) => {
    await sendDayView(ctx, db);
  });

  bot.hears(MENU_BUTTON, async (ctx) => {
    await ctx.reply(MENU_TEXT, { reply_markup: menuKeyboard() });
  });

  bot.callbackQuery("menu:back", async (ctx) => {
    await ctx.editMessageText(MENU_TEXT, { reply_markup: menuKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:help", async (ctx) => {
    await ctx.editMessageText(HELP_TEXT, { reply_markup: backKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:profile", async (ctx) => {
    const { text, reply_markup } = buildProfileView(db, ctx.from.id);
    await ctx.editMessageText(text, { reply_markup });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:reset", async (ctx) => {
    await ctx.editMessageText(RESET_CONFIRM_TEXT, { reply_markup: resetConfirmKeyboard() });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:reset_do", async (ctx) => {
    const deleted = deleteProfile(db, ctx.from.id);
    await ctx.editMessageText(deleted ? PROFILE_DELETED_TEXT : "🐱 Профиля и так нет.", {
      reply_markup: fillProfileKeyboard(),
    });
    await ctx.answerCallbackQuery();
  });

  bot.callbackQuery("menu:restart", async (ctx) => {
    await ctx.editMessageText("Открываю анкету...");
    await ctx.answerCallbackQuery();
    await startOnboarding(ctx);
  });

  // «📝 Заполнить анкету» под сообщениями «нет профиля», в профиле и после удаления.
  bot.callbackQuery(FILL_PROFILE_DATA, async (ctx) => {
    if (getProfileByUserId(db, ctx.from.id)) {
      await ctx.answerCallbackQuery({
        text: "Анкета уже заполнена — поменять ответы можно в «👤 Профиль».",
        show_alert: true,
      });
      return;
    }
    if (hasActiveConversation(ctx) && !ctx.conversation.active("onboarding")) {
      await ctx.answerCallbackQuery({ text: FINISH_CONVERSATION_FIRST_TEXT, show_alert: true });
      return;
    }
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
    await startOnboarding(ctx);
  });
}
