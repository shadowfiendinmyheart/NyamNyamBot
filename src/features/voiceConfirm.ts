import type { Conversation } from "@grammyjs/conversations";
import { InlineKeyboard, type Api, type Context } from "grammy";
import type { MessageEntity } from "grammy/types";
import type { MyContext } from "../context.js";
import { transcribeAudio, TranscriberError } from "../ai/transcriber.js";
import { downloadTelegramFile } from "../utils/telegram.js";

// Флоу для голосового ввода: голосовое → расшифровка → сообщение с текстом и кнопками
// «✅ / ✏️ Исправить / ❌» → только после ✅ расшифровка идёт дальше (в запись еды,
// коучу, в уточнение оценки, в «зачем вам бот»). Расшифровка бывает неточной, и так
// пользователь видит её до запроса к ИИ.

// Где было голосовое — от этого зависит callback_data и обработчик нажатия.
export type VoiceConfirmScope = "meal" | "coach" | "fix" | "motivation";

// "edit" — ✏️: кнопки убираются, а исправленный вариант пользователь присылает обычным
// сообщением. Состояния для этого не нужно: в каждом флоу следующее сообщение и так
// попадает туда же, куда шла бы расшифровка (запись еды, коуч, ожидающий диалог).
export type VoiceConfirmAction = "yes" | "edit" | "no";

// Расшифровка хранится в тексте самого сообщения с кнопками, а не в памяти:
// callback_data ограничена 64 байтами, а так подтверждение переживает перезапуск бота.
const PREFIX = "🎙 Услышала:\n\n";
// Так начинались подтверждения до единого голоса Ням-Ням — кнопки под ними ещё работают.
const LEGACY_PREFIX = "🎙 Распознал:\n\n";
const SUFFIX = "\n\nВсё верно?";
// После нажатия в сообщении остаётся расшифровка с этим префиксом (и пояснением ниже).
const SETTLED_PREFIX = "🎙 ";

// Telegram не принимает сообщения длиннее 4096 символов. Голосовое на несколько минут
// даёт расшифровку длиннее — её обрезаем, и дальше идёт ровно то, что видит пользователь.
const TELEGRAM_MAX_MESSAGE_LENGTH = 4096;
const TRUNCATION_MARK = "…";
export const MAX_TRANSCRIPT_LENGTH =
  TELEGRAM_MAX_MESSAGE_LENGTH - PREFIX.length - SUFFIX.length - TRUNCATION_MARK.length;

function truncateTranscript(transcript: string, maxLength = MAX_TRANSCRIPT_LENGTH): string {
  return transcript.length > maxLength
    ? `${transcript.slice(0, maxLength).trimEnd()}${TRUNCATION_MARK}`
    : transcript;
}

export function buildVoiceConfirmMessage(transcript: string): string {
  return `${PREFIX}${truncateTranscript(transcript)}${SUFFIX}`;
}

export function parseVoiceConfirmMessage(message: string | undefined): string | undefined {
  const prefix = [PREFIX, LEGACY_PREFIX].find((candidate) => message?.startsWith(candidate));
  if (!message || !prefix || !message.endsWith(SUFFIX)) return undefined;
  const transcript = message.slice(prefix.length, message.length - SUFFIX.length).trim();
  return transcript || undefined;
}

export function voiceConfirmKeyboard(scope: VoiceConfirmScope): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅", `voice_${scope}:yes`)
    .text("✏️ Исправить", `voice_${scope}:edit`)
    .text("❌", `voice_${scope}:no`);
}

// ctx.match[1] — VoiceConfirmAction. Старые кнопки «Да/Нет» дают те же yes/no.
export function voiceConfirmPattern(scope: VoiceConfirmScope): RegExp {
  return new RegExp(`^voice_${scope}:(yes|edit|no)$`);
}

// Что написать под расшифровкой после нажатия «❌» и «✏️» — своё в каждом флоу.
export interface VoiceSettleHints {
  reject: string;
  edit: string;
}

// Часть подсказки к ✏️: моноширинную расшифровку Telegram копирует по нажатию.
export const COPY_TRANSCRIPT_HINT = "нажмите на расшифровку — она скопируется";

// Текст сообщения после нажатия: расшифровка без кнопок, при ❌ / ✏️ — с пояснением.
// При ✏️ расшифровка моноширинная (entity code, без parse_mode — экранировать нечего),
// чтобы её можно было скопировать целиком и поправить пару слов.
export function buildSettledVoiceMessage(
  transcript: string,
  action: VoiceConfirmAction,
  hints: VoiceSettleHints,
): { text: string; entities: MessageEntity[] } {
  const note =
    action === "no" ? `\n\n❌ ${hints.reject}` : action === "edit" ? `\n\n✏️ ${hints.edit}` : "";
  const shown = truncateTranscript(
    transcript,
    TELEGRAM_MAX_MESSAGE_LENGTH - SETTLED_PREFIX.length - note.length - TRUNCATION_MARK.length,
  );
  const entities: MessageEntity[] =
    action === "edit" ? [{ type: "code", offset: SETTLED_PREFIX.length, length: shown.length }] : [];
  return { text: `${SETTLED_PREFIX}${shown}${note}`, entities };
}

// Обрабатывает нажатие ✅ / ✏️ / ❌: отвечает на callback, убирает кнопки и оставляет в
// сообщении расшифровку с пояснением из hints. Возвращает расшифровку, только если
// пользователь подтвердил её (✅).
export async function settleVoiceConfirmation(
  ctx: Context,
  action: VoiceConfirmAction,
  hints: VoiceSettleHints,
): Promise<string | undefined> {
  const text = parseVoiceConfirmMessage(ctx.callbackQuery?.message?.text);
  if (!text) {
    await ctx.answerCallbackQuery({ text: "Не удалось прочитать расшифровку.", show_alert: true });
    return undefined;
  }
  await ctx.answerCallbackQuery();

  // Кнопки убираем до долгого запроса к ИИ. Повторное нажатие (обновления чата идут
  // по очереди) упадёт здесь с «message is not modified» — так ничего не задвоится.
  const settled = buildSettledVoiceMessage(text, action, hints);
  try {
    await ctx.editMessageText(settled.text, {
      entities: settled.entities,
      reply_markup: new InlineKeyboard(),
    });
  } catch {
    return undefined;
  }

  return action === "yes" ? text : undefined;
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
