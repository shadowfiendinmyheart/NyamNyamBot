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
// Как отключить — зависит от модели: Sonnet 5.5 на {type: "disabled"} отвечает
// ошибкой («Reasoning is mandatory…»), выключатель у неё — {type: "between_tools"};
// у Opus 5.5 и Fable thinking не отключается вовсе — поле не передаём.
export function thinkingOff(model: string): object {
  if (/sonnet-5[.-]5/.test(model)) return { thinking: { type: "between_tools" } };
  if (/opus-5[.-]5|fable|mythos/.test(model)) return {};
  return { thinking: { type: "disabled" } };
}

// С включённым thinking API принимает только tool_choice auto/none — на {type: "tool"}
// и {type: "any"} отвечает invalid_request_error «tool_choice: type "tool" and "any"
// are not supported for this model». У моделей, где thinking до конца не выключается,
// вызов инструмента требуем в system prompt, а tool_choice ставим auto.
export function hasMandatoryThinking(model: string): boolean {
  return /sonnet-5[.-]5|opus-5[.-]5|fable|mythos/.test(model);
}

type MessageParams = Omit<Anthropic.MessageCreateParamsNonStreaming, "model">;

export function withoutForcedToolChoice(params: MessageParams): MessageParams {
  const choice = params.tool_choice;
  if (choice?.type !== "tool" && choice?.type !== "any") return params;
  const instruction =
    choice.type === "tool"
      ? `Ответь только вызовом инструмента ${choice.name}, без текста до или после него.`
      : "Ответь только вызовом одного из инструментов, без текста до или после него.";
  const system: Anthropic.TextBlockParam[] =
    typeof params.system === "string"
      ? [{ type: "text", text: params.system }]
      : [...(params.system ?? [])];
  system.push({ type: "text", text: instruction });
  return { ...params, system, tool_choice: { type: "auto" } };
}

// Прокси может подменить модель и сам включить thinking — по конфигу этого не угадать,
// отказ из-за tool_choice видно только по ответу (400 или ошибка в теле ответа 200).
export function isForcedToolChoiceRejected(err: unknown): boolean {
  return err instanceof Error && /tool_choice[^]*not supported/.test(err.message);
}

// Прокси (ANTHROPIC_BASE_URL) при сбое у себя иногда отвечает 200, но не сообщением
// Anthropic, а своей ошибкой ({"error": ...}), ответом в формате OpenAI или
// HTML-страницей. SDK форму ответа не проверяет — без этой проверки код падал бы на
// response.content с TypeError, а пользователь не узнал бы, что сбой временный.
// Начало тела — в тексте ошибки: вызывающий код логирует её (через cause) рядом с тем,
// чей это был запрос.
const MAX_LOGGED_BODY_CHARS = 1000;

export class UnexpectedResponseError extends Error {
  // error.type, если прокси вернул в теле ответа 200 ошибку Anthropic
  // ({"type":"error","error":{"type":…}}) — по нему отличаем сбой сервиса от отказа
  // в самом запросе.
  readonly apiErrorType: string | null;

  constructor(body: string, apiErrorType: string | null = null) {
    super(
      `ИИ-сервис вернул ответ не в формате Anthropic Messages: ${body.slice(0, MAX_LOGGED_BODY_CHARS)}`,
    );
    this.name = "UnexpectedResponseError";
    this.apiErrorType = apiErrorType;
  }
}

function apiErrorTypeOf(response: unknown): string | null {
  if (typeof response !== "object" || response === null) return null;
  const error = (response as { error?: { type?: unknown } }).error;
  return typeof error?.type === "string" ? error.type : null;
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
    apiErrorTypeOf(response),
  );
}

function sendMessage(params: MessageParams): Promise<Anthropic.Message> {
  return getClient()
    .messages.create({
      model: config.anthropicModel,
      ...params,
      ...thinkingOff(config.anthropicModel),
    })
    .then(ensureMessage);
}

// Единственная точка вызова Messages API: модель из конфига, отключённый thinking,
// совместимый с ним tool_choice и проверка формы ответа — каждому месту вызова остаётся
// лишь .catch с переводом ошибки для пользователя.
export function createMessage(params: MessageParams): Promise<Anthropic.Message> {
  if (hasMandatoryThinking(config.anthropicModel)) {
    return sendMessage(withoutForcedToolChoice(params));
  }
  return sendMessage(params).catch((err: unknown) => {
    if (!isForcedToolChoiceRejected(err)) throw err;
    console.warn(
      `Модель ${config.anthropicModel} не принимает принудительный tool_choice (thinking включил прокси?) — повторяю запрос с auto`,
    );
    return sendMessage(withoutForcedToolChoice(params));
  });
}

// Прокси (ANTHROPIC_BASE_URL) время от времени не укладывается в свой собственный
// Cloudflare-таймаут на медленных запросах (524 и подобные) — это внешняя
// перегрузка, а не баг в коде, и такие ошибки стоит явно помечать как временные,
// чтобы пользователь получил внятное "попробуйте чуть позже", а не сырой stack trace.
export type ApiErrorKind = "unavailable" | "timeout" | "other";

// Отказ в самом запросе (параметры, ключ, доступ, модель) — повтор не поможет.
const PERMANENT_ERROR_TYPES = new Set([
  "invalid_request_error",
  "authentication_error",
  "permission_error",
  "not_found_error",
]);

export function classifyApiError(err: unknown): ApiErrorKind {
  if (
    err instanceof UnexpectedResponseError &&
    err.apiErrorType !== null &&
    PERMANENT_ERROR_TYPES.has(err.apiErrorType)
  ) {
    return "other";
  }
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
