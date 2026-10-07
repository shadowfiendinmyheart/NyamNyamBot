import type { Conversation } from "@grammyjs/conversations";
import { Bot, InlineKeyboard, type Api, type Context } from "grammy";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../db/schema.js";
import type { MyContext } from "../context.js";
import { getProfileByUserId, setProfileMotivation } from "../db/profiles.js";
import { mainKeyboard } from "./mainMenu.js";
import { askMotivation, MOTIVATION_SKIP_DATA } from "./onboarding.js";
import { voiceConfirmPattern } from "./voiceConfirm.js";

type Db = BetterSQLite3Database<typeof schema>;
type MyConversation = Conversation<MyContext>;

// «✍️ Зачем мне бот» в профиле: поменять ответ, не проходя анкету заново (в том числе
// тем, кто заполнил анкету до появления этого вопроса).
export function motivationConversation(db: Db, api: Api) {
  return async function motivation(conversation: MyConversation, ctx: Context): Promise<void> {
    const userId = ctx.from?.id;
    if (!userId) return;

    const profile = await conversation.external(() => getProfileByUserId(db, userId));
    if (!profile) {
      await ctx.reply("Сначала пройдите анкету: «⚙️ Меню» → «🔄 Пройти анкету заново».");
      return;
    }

    if (profile.motivation) {
      await ctx.reply(`💭 Сейчас записано:\n\n${profile.motivation}`);
    }
    const motivation = await askMotivation(conversation, ctx, api, profile.motivation, {
      cancelledText: "Хорошо, оставила как было.",
    });

    if (motivation === profile.motivation) {
      await ctx.reply(
        motivation ? "Хорошо, оставила как было." : "Хорошо, расскажете, когда захотите.",
        { reply_markup: mainKeyboard },
      );
      return;
    }

    await conversation.external(() => setProfileMotivation(db, userId, motivation));
    await ctx.reply("🐱 Запомнила! Буду учитывать это в советах.", {
      reply_markup: mainKeyboard,
    });
  };
}

export function registerMotivation(bot: Bot<MyContext>): void {
  bot.callbackQuery("menu:motivation", async (ctx) => {
    await ctx.answerCallbackQuery();
    if (ctx.conversation.active("motivation") || ctx.conversation.active("onboarding")) return;
    await ctx.conversation.enter("motivation");
  });

  // Пока вопрос открыт, эти кнопки перехватывает диалог; сюда попадаем, только если он
  // уже закончился (или бот перезапускался).
  const staleAnswer = async (ctx: MyContext) => {
    await ctx.answerCallbackQuery({
      text: "Этот вопрос уже неактуален — откройте «👤 Мой профиль» → «✍️ Зачем мне бот».",
      show_alert: true,
    });
    await ctx.editMessageReplyMarkup({ reply_markup: new InlineKeyboard() }).catch(() => {});
  };
  bot.callbackQuery(MOTIVATION_SKIP_DATA, staleAnswer);
  bot.callbackQuery(voiceConfirmPattern("motivation"), staleAnswer);
}
