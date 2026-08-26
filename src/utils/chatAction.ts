import type { Context } from "grammy";

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
  action: "typing" | "upload_photo" | "record_voice" | "upload_voice",
  asyncFn: () => Promise<T>,
): Promise<T> {
  // Отправляем индикатор сразу
  await ctx.replyWithChatAction(action).catch(() => {
    // Игнорируем ошибки отправки chat action — не критично
  });

  // Обновляем каждые 4 секунды (Telegram показывает действие ~5 секунд)
  const interval = setInterval(() => {
    ctx.replyWithChatAction(action).catch(() => {
      // Игнорируем ошибки
    });
  }, 4000);

  try {
    return await asyncFn();
  } finally {
    clearInterval(interval);
  }
}
