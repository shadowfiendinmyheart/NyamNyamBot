import type { Api, Context } from "grammy";

/**
 * Поддерживает индикатор "печатает..." (или другое действие) в Telegram на протяжении
 * долгой операции. Telegram показывает chat action только ~5 секунд, поэтому для
 * долгих запросов (анализ изображения через Claude Vision, транскрипция аудио) нужно
 * периодически обновлять индикатор, иначе пользователю кажется, что бот завис.
 *
 * @param ctx Контекст grammY
 * @param action Тип действия (по умолчанию "typing")
 * @param asyncFn Асинхронная функция, которую нужно выполнить
 * @returns Результат asyncFn
 */
export async function withChatAction<T>(
  ctx: Context,
  action: ChatAction,
  asyncFn: () => Promise<T>,
): Promise<T> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return asyncFn();
  return withChatActionVia(ctx.api, chatId, action, asyncFn);
}

type ChatAction = "typing" | "upload_photo" | "record_voice" | "upload_voice";

/**
 * То же, что withChatAction, но через явный Api и chatId — для кода внутри
 * conversation.external, где нельзя пользоваться ctx диалога.
 */
export async function withChatActionVia<T>(
  api: Api,
  chatId: number,
  action: ChatAction,
  asyncFn: () => Promise<T>,
): Promise<T> {
  // Отправляем индикатор сразу
  await api.sendChatAction(chatId, action).catch(() => {
    // Игнорируем ошибки отправки chat action — не критично
  });

  // Обновляем каждые 4 секунды (Telegram показывает действие ~5 секунд)
  const interval = setInterval(() => {
    api.sendChatAction(chatId, action).catch(() => {
      // Игнорируем ошибки
    });
  }, 4000);

  try {
    return await asyncFn();
  } finally {
    clearInterval(interval);
  }
}
