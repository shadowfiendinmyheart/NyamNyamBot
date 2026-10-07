import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Api, type Context } from "grammy";
import type { MyContext } from "../context.js";
import { transcribeAudio, TranscriberError } from "../ai/transcriber.js";
import { downloadTelegramFile } from "../utils/telegram.js";

// Единый флоу для голосового ввода: голосовое → расшифровка → сообщение с текстом и
// кнопками «Да/Нет» → только после «Да» расшифровка идёт дальше (в дневник, коучу,
// в уточнение оценки). Расшифровка бывает неточной, и так пользователь видит её заранее.

// Где было голосовое — от этого зависит callback_data и обработчик нажатия.
export type VoiceConfirmScope = "meal" | "coach" | "fix" | "motivation";

// Расшифровка хранится в тексте самого сообщения с кнопками, а не в памяти:
// callback_data ограничена 64 байтами, а так подтверждение переживает перезапуск бота.
const PREFIX = "🎙 Распознал:\n\n";
const SUFFIX = "\n\nВсё верно?";

// Telegram не принимает сообщения длиннее 4096 символов. Голосовое на несколько минут
// даёт расшифровку длиннее — её обрезаем, и дальше идёт ровно то, что видит пользователь.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TRUNCATION_MARK = "…";
export const MAX_TRANSCRIPT_LENGTH =
  TELEGRAM_MAX_MESSAGE_LENGTH - PREFIX.length - SUFFIX.length - TRUNCATION_MARK.length;

export function buildVoiceConfirmMessage(transcript: string): string {
  const shown =
    transcript.length > MAX_TRANSCRIPT_LENGTH
      ? `${transcript.slice(0, MAX_TRANSCRIPT_LENGTH).trimEnd()}${TRUNCATION_MARK}`
      : transcript;
  return `${PREFIX}${shown}${SUFFIX}`;
}

export function parseVoiceConfirmMessage(message: string | undefined): string | undefined {
  if (!message?.startsWith(PREFIX) || !message.endsWith(SUFFIX)) return undefined;
  const transcript = message.slice(PREFIX.length, message.length - SUFFIX.length).trim();
  return transcript || undefined;
}

export function voiceConfirmKeyboard(scope: VoiceConfirmScope): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Да", `voice_${scope}:yes`)
    .text("❌ Нет", `voice_${scope}:no`);
}

// ctx.match[1] — "yes" или "no".
export function voiceConfirmPattern(scope: VoiceConfirmScope): RegExp {
  return new RegExp(`^voice_${scope}:(yes|no)$`);
}

// Обрабатывает нажатие «Да/Нет»: отвечает на callback, убирает кнопки и оставляет в
// сообщении расшифровку (при «Нет» — с подсказкой rejectHint). Возвращает расшифровку,
// только если пользователь подтвердил её.
export async function settleVoiceConfirmation(
  ctx: Context,
  confirmed: boolean,
  rejectHint: string,
): Promise<string | undefined> {
  const text = parseVoiceConfirmMessage(ctx.callbackQuery?.message?.text);
  if (!text) {
    await ctx.answerCallbackQuery({ text: "Не удалось прочитать расшифровку.", show_alert: true });
    return undefined;
  }
  await ctx.answerCallbackQuery();

  // Кнопки убираем до долгого запроса к ИИ. Повторное нажатие (обновления чата идут
  // по очереди) упадёт здесь с «message is not modified» — так ничего не задвоится.
  try {
    await ctx.editMessageText(
      confirmed ? `🎙 ${text}` : `🎙 ${text}\n\n❌ ${rejectHint}`,
      { reply_markup: new InlineKeyboard() },
    );
  } catch {
    return undefined;
  }

  return confirmed ? text : undefined;
}

// Расшифровка голосового внутри диалога (@grammyjs/conversations): все внешние вызовы
// идут через conversation.external. undefined — ошибка уже показана пользователю.
export async function transcribeVoiceInConversation(
  conversation: Conversation<MyContext>,
  api: Api,
  response: Context,
  voice: { file_id: string; file_size?: number },
): Promise<string | undefined> {
  // Whisper API ограничен 25MB
  const maxSizeBytes = 25 * 1024 * 1024;
  if (voice.file_size && voice.file_size > maxSizeBytes) {
    await response.reply(
      "Голосовое сообщение слишком длинное (больше 25MB). Попробуйте записать короче или напишите текстом.",
    );
    return undefined;
  }

  const voiceFile = await conversation.external(() => api.getFile(voice.file_id));
  if (!voiceFile.file_path) {
    await response.reply("Не удалось скачать голосовое сообщение, попробуйте ещё раз.");
    return undefined;
  }
  const filePath = voiceFile.file_path;

  try {
    const buffer = await conversation.external(() => downloadTelegramFile(filePath));
    return await conversation.external(() =>
      transcribeAudio({
        audioBuffer: buffer,
        mimeType: "audio/ogg",
        filename: filePath.split("/").pop() ?? "voice.oga",
      }),
    );
  } catch (err) {
    console.error("Не удалось распознать голосовое сообщение в диалоге:", err);
    await response.reply(
      err instanceof TranscriberError
        ? err.message
        : "Не получилось распознать голосовое сообщение, попробуйте ещё раз или напишите текстом.",
    );
    return undefined;
  }
}
