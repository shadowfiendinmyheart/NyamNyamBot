export interface TranscribeAudioInput {
  audioBuffer: Buffer;
  mimeType: string;
  filename: string;
}

export type Transcriber = (input: TranscribeAudioInput) => Promise<string>;

// Провайдер-независимая ошибка распознавания речи — по аналогии с FoodAnalyzerError:
// reply-текст для пользователя уже на русском, `retryable` подсказывает, стоит ли
// предложить повторить попытку.
export class TranscriberError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { retryable: boolean; cause?: unknown }) {
    super(message, { cause: options.cause });
    this.name = "TranscriberError";
    this.retryable = options.retryable;
  }
}

// Единственная точка переключения провайдера распознавания речи: остальной код зовёт
// transcribeAudio отсюда, а не из ../openai/transcribeAudio.js напрямую.
export { transcribeAudio } from "../openai/transcribeAudio.js";
