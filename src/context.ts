import type { Context } from "grammy";
import type { ConversationFlavor } from "@grammyjs/conversations";

export type MyContext = ConversationFlavor<Context>;

// Идёт ли сейчас какой-нибудь диалог (анкета, правка, запись тренировки…): он
// перехватит ответ раньше нового диалога, поэтому сначала его нужно закончить.
export function hasActiveConversation(ctx: MyContext): boolean {
  return Object.keys(ctx.conversation.active()).length > 0;
}

export const FINISH_CONVERSATION_FIRST_TEXT =
  "Сначала закончите текущий диалог или отправьте /cancel.";
