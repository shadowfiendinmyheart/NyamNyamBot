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
  if (transcript.length <= maxLength) return transcript;
  let cut = transcript.slice(0, maxLength);
  // Не разрываем суррогатную пару (эмодзи): одинокую половину Telegram не примет.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut.trimEnd()}${TRUNCATION_MARK}`;
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

// Что сказать после «❌» (под расшифровкой) и «✏️» (отдельным сообщением) — своё в
// каждом флоу.
export interface VoiceSettleHints {
  reject: string;
  edit: string;
}

// Текст сообщения после нажатия: расшифровка без кнопок, при ❌ — с пояснением. При ✏️
// расшифровка моноширинная (entity code, без parse_mode — экранировать нечего), чтобы
// её можно было скопировать целиком и поправить пару слов; подсказка к ✏️ идёт
// отдельным сообщением, так копируемый текст не обрезается ради неё.
export function buildSettledVoiceMessage(
  transcript: string,
  action: VoiceConfirmAction,
  rejectHint: string,
): { text: string; entities: MessageEntity[] } {
  const note = action === "no" ? `\n\n❌ ${rejectHint}` : "";
  const shown = truncateTranscript(
    transcript,
    TELEGRAM_MAX_MESSAGE_LENGTH - SETTLED_PREFIX.length - note.length - TRUNCATION_MARK.length,
  );
  const entities: MessageEntity[] =
    action === "edit" ? [{ type: "code", offset: SETTLED_PREFIX.length, length: shown.length }] : [];
  return { text: `${SETTLED_PREFIX}${shown}${note}`, entities };
}

export function buildVoiceEditHint(editHint: string): string {
  return `✏️ ${editHint}\n\nЧтобы поправить пару слов, нажмите на расшифровку — она скопируется.`;
}

// Сообщения с расшифровкой, под которыми кнопку уже нажали. Защита от двух разных
// кнопок подряд (✏️, затем ✅): у второго нажатия в callback — снимок исходного текста,
// и правка сообщения проходит. В памяти, последние MAX_SETTLED; после перезапуска бота
// повтор той же кнопки по-прежнему отсекает «message is not modified».
const MAX_SETTLED = 1000;
const settledMessages = new Set<string>();

// true — сообщение ещё не обрабатывали (и теперь оно помечено). Внутри диалога
// (@grammyjs/conversations) звать через conversation.external: код диалога
// переигрывается на каждом обновлении.
export function claimVoiceConfirmation(chatId: number, messageId: number): boolean {
  const key = `${chatId}:${messageId}`;
  if (settledMessages.has(key)) return false;
  settledMessages.add(key);
  if (settledMessages.size > MAX_SETTLED) {
    settledMessages.delete(settledMessages.values().next().value!);
  }
  return true;
}

type ClaimVoiceConfirmation = (chatId: number, messageId: number) => boolean | Promise<boolean>;

// Обрабатывает нажатие ✅ / ✏️ / ❌ (action — ctx.match[1] из voiceConfirmPattern):
// отвечает на callback, убирает кнопки и оставляет в сообщении расшифровку, при ✏️
// присылает подсказку. Возвращает расшифровку, только если пользователь подтвердил её.
export async function settleVoiceConfirmation(
  ctx: Context,
  action: string,
  hints: VoiceSettleHints,
  claim: ClaimVoiceConfirmation = claimVoiceConfirmation,
): Promise<string | undefined> {
  const settledAction: VoiceConfirmAction =
    action === "yes" || action === "edit" ? action : "no";
  const message = ctx.callbackQuery?.message;
  const text = parseVoiceConfirmMessage(message?.text);
  if (!message || !text) {
    await ctx.answerCallbackQuery({ text: "Не удалось прочитать расшифровку.", show_alert: true });
    return undefined;
  }
  await ctx.answerCallbackQuery();
  if (!(await claim(message.chat.id, message.message_id))) return undefined;

  // Кнопки убираем до долгого запроса к ИИ. Повторное нажатие после перезапуска бота
  // (обновления чата идут по очереди) упадёт здесь с «message is not modified».
  const settled = buildSettledVoiceMessage(text, settledAction, hints.reject);
  try {
    await ctx.editMessageText(settled.text, {
      entities: settled.entities,
      reply_markup: new InlineKeyboard(),
    });
  } catch {
    return undefined;
  }

  if (settledAction === "edit") await ctx.reply(buildVoiceEditHint(hints.edit));
  return settledAction === "yes" ? text : undefined;
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
