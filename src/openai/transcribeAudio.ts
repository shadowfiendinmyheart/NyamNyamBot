import OpenAI, { toFile } from "openai";
import { config } from "../config.js";
import { TranscriberError } from "../ai/transcriber.js";
import type { TranscribeAudioInput } from "../ai/transcriber.js";

let client: OpenAI | undefined;

function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: config.openaiApiKey });
  return client;
}

export async function transcribeAudio(input: TranscribeAudioInput): Promise<string> {
  const response = await getClient()
    .audio.transcriptions.create({
      file: await toFile(input.audioBuffer, input.filename, { type: input.mimeType }),
      model: "whisper-1",
      language: "ru",
    })
    .catch((err: unknown) => {
      throw toTranscriberError(err);
    });

  const text = response.text.trim();
  if (!text) {
    throw new TranscriberError("Не получилось распознать речь в голосовом сообщении.", {
      retryable: false,
    });
  }

  return text;
}

function toTranscriberError(err: unknown): TranscriberError {
  if (err instanceof OpenAI.APIConnectionError || err instanceof OpenAI.RateLimitError) {
    return new TranscriberError(
      "Сервис распознавания речи сейчас перегружен или недоступен. Попробуйте отправить голосовое сообщение ещё раз через пару минут.",
      { retryable: true, cause: err },
    );
  }
  if (err instanceof OpenAI.APIError && (err.status === undefined || err.status >= 500)) {
    return new TranscriberError(
      "Сервис распознавания речи не успел ответить вовремя (перегружен). Попробуйте отправить голосовое сообщение ещё раз через пару минут.",
      { retryable: true, cause: err },
    );
  }
  return new TranscriberError(
    "Не получилось распознать голосовое сообщение. Попробуйте ещё раз или опишите текстом.",
    { retryable: false, cause: err },
  );
}
