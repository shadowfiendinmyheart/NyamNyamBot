import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { proxyHttpAgent } from "../utils/proxy.js";

let client: Anthropic | undefined;

function getClient(): Anthropic {
  client ??= new Anthropic({
    apiKey: config.anthropicApiKey,
    baseURL: config.anthropicBaseUrl,
    // По умолчанию SDK ждёт ответа до 10 минут и делает 2 повтора — пользователь
    // всё это время сидит без ответа. Лучше быстро сказать «попробуйте ещё раз».
    timeout: 90_000,
    maxRetries: 1,
    ...(proxyHttpAgent ? { httpAgent: proxyHttpAgent } : {}),
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
const THINKING_DISABLED = { thinking: { type: "disabled" } } as object;

// Прокси (ANTHROPIC_BASE_URL) при сбое у себя иногда отвечает 200, но не сообщением
// Anthropic, а своей ошибкой ({"error": ...}), ответом в формате OpenAI или
// HTML-страницей. SDK форму ответа не проверяет — без этой проверки код падал бы на
// response.content с TypeError, а пользователь не узнал бы, что сбой временный.
// Начало тела — в тексте ошибки: вызывающий код логирует её (через cause) рядом с тем,
// чей это был запрос.
const MAX_LOGGED_BODY_CHARS = 1000;

export class UnexpectedResponseError extends Error {
  constructor(body: string) {
    super(
      `ИИ-сервис вернул ответ не в формате Anthropic Messages: ${body.slice(0, MAX_LOGGED_BODY_CHARS)}`,
    );
    this.name = "UnexpectedResponseError";
  }
}

function ensureMessage(response: unknown): Anthropic.Message {
  if (
    typeof response === "object" &&
    response !== null &&
    Array.isArray((response as { content?: unknown }).content)
  ) {
    return response as Anthropic.Message;
  }
  throw new UnexpectedResponseError(
    typeof response === "string" ? response : String(JSON.stringify(response)),
  );
}

// Единственная точка вызова Messages API: модель из конфига, отключённый thinking и
// проверка формы ответа — каждому месту вызова остаётся лишь .catch с переводом ошибки
// для пользователя.
export function createMessage(
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
): Promise<Anthropic.Message> {
  return getClient()
    .messages.create({ model: config.anthropicModel, ...params, ...THINKING_DISABLED })
    .then(ensureMessage);
}

// Прокси (ANTHROPIC_BASE_URL) время от времени не укладывается в свой собственный
// Cloudflare-таймаут на медленных запросах (524 и подобные) — это внешняя
// перегрузка, а не баг в коде, и такие ошибки стоит явно помечать как временные,
// чтобы пользователь получил внятное "попробуйте чуть позже", а не сырой stack trace.
export type ApiErrorKind = "unavailable" | "timeout" | "other";

export function classifyApiError(err: unknown): ApiErrorKind {
  // SyntaxError — тело ответа 200 с content-type JSON не разобралось (обрезано или это
  // HTML-страница прокси): SDK бросает его в обход своих повторов. Как и
  // UnexpectedResponseError — сбой на стороне сервиса.
  if (err instanceof UnexpectedResponseError || err instanceof SyntaxError) return "unavailable";
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.RateLimitError) {
    return "unavailable";
  }
  if (err instanceof Anthropic.APIError && (err.status === undefined || err.status >= 500)) {
    return "timeout";
  }
  return "other";
}
