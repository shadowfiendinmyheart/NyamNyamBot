import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

let client: Anthropic | undefined;

export function getClient(): Anthropic {
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl,
    // По умолчанию SDK ждёт ответа до 10 минут и делает 2 повтора — пользователь
    // всё это время сидит без ответа. Лучше быстро сказать «попробуйте ещё раз».
    timeout: 90_000,
    maxRetries: 1,
    // При работе через сторонний прокси (ANTHROPIC_BASE_URL) официальный
    // User-Agent SDK ("Anthropic/JS ...") блокируется файрволом прокси (Cloudflare
    // 403 "Your request was blocked") — с прямым api.anthropic.com такой проблемы нет.
    ...(config.anthropicBaseUrl
      ? { defaultHeaders: { "User-Agent": "food-calculator-bot/1.0", "Authorization": `Bearer ${config.anthropicApiKey}` } }
      : {}),
  });
  return client;
}

// Прокси может подменить модель (например, на claude-opus-4-8) и сам включить
// thinking — тогда модель тратит весь max_tokens на рассуждения и не успевает
// ответить. Отключаем явно; в типах SDK 0.32 этого поля ещё нет.
export const THINKING_DISABLED = { thinking: { type: "disabled" } } as object;

// Прокси (ANTHROPIC_BASE_URL) время от времени не укладывается в свой собственный
// Cloudflare-таймаут на медленных запросах (524 и подобные) — это внешняя
// перегрузка, а не баг в коде, и такие ошибки стоит явно помечать как временные,
// чтобы пользователь получил внятное "попробуйте чуть позже", а не сырой stack trace.
export type ApiErrorKind = "unavailable" | "timeout" | "other";

export function classifyApiError(err: unknown): ApiErrorKind {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError) {
    return "unavailable";
  }
  if (err instanceof Anthropic.APIError && (err.status === undefined || err.status >= 500)) {
    return "timeout";
  }
  return "other";
}
