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

// У части моделей (Gemini 3.8 Flash через RouterAI) рассуждения обязательны, а угадать
// это по имени нельзя: такие отвечают «Reasoning is mandatory … cannot be disabled».
export function isMandatoryReasoningRejected(err: unknown): boolean {
  return err instanceof Error && /reasoning is mandatory/i.test(err.message);
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

// Учёт токенов каждого запроса — для scripts/compareModels.ts (сравнение моделей по
// цене); бот его не использует.
type UsageObserver = (model: string, usage: Anthropic.Usage) => void;
let usageObserver: UsageObserver | undefined;

export function observeUsage(observer: UsageObserver | undefined): void {
  usageObserver = observer;
}

// Что за запрос — для учёта расхода в логе: фото, текст/голос, разговор с Ням-Ням,
// оценка рациона в сводке.
export type AiCallKind = "photo" | "message" | "coach" | "comment";

export interface AiPrices {
  inputPerM?: number;
  outputPerM?: number;
}

// Поля кэша есть в ответе, но не в типах SDK 0.32.
type UsageWithCache = Anthropic.Usage & {
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

// Строка лога о расходе одного запроса. Закэшированный вход прокси отдаёт отдельно от
// input_tokens; в ₽ он считается по цене обычного входа — скидку RouterAI на кэш не
// знаем, так что цена — оценка сверху. Без цен в конфиге — только токены.
export function formatUsageLine(
  kind: AiCallKind,
  model: string,
  usage: Anthropic.Usage,
  prices: AiPrices = {},
): string {
  const { cache_read_input_tokens, cache_creation_input_tokens } = usage as UsageWithCache;
  const input = (usage.input_tokens ?? 0) + (cache_creation_input_tokens ?? 0);
  const cached = cache_read_input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  let line = `[ai-usage] kind=${kind} model=${model} in=${input} cached=${cached} out=${output}`;
  if (prices.inputPerM !== undefined && prices.outputPerM !== undefined) {
    const rub = ((input + cached) * prices.inputPerM + output * prices.outputPerM) / 1_000_000;
    line += ` ≈${rub.toFixed(2)}₽`;
  }
  return line;
}

// Модели, отказавшиеся работать без рассуждений: следующие запросы к ним сразу идут с
// рассуждениями, без заведомо отклонённой попытки.
const reasoningRequired = new Set<string>();

// Рассуждения тратят тот же max_tokens, что и ответ: лимиты коуча (600–1500) рассчитаны
// на длину текста, и без запаса модель обрывалась бы ещё до ответа. Длину текста держат
// промпт и обрезка в claude/coach.ts.
const REASONING_TOKENS = 4000;

function sendMessage(
  params: MessageParams,
  kind: AiCallKind,
  keepThinking = false,
): Promise<Anthropic.Message> {
  const model = config.anthropicModel;
  return getClient()
    .messages.create({
      model,
      ...params,
      ...(keepThinking ? { max_tokens: params.max_tokens + REASONING_TOKENS } : thinkingOff(model)),
    })
    .then(ensureMessage)
    .then((message) => {
      if (message.usage) {
        usageObserver?.(model, message.usage);
        console.log(formatUsageLine(kind, model, message.usage, config.aiPrices));
      }
      return message;
    });
}

// Единственная точка вызова Messages API: модель из конфига, отключённый thinking,
// совместимый с ним tool_choice и проверка формы ответа — каждому месту вызова остаётся
// лишь .catch с переводом ошибки для пользователя. kind — для строки расхода в логе.
export function createMessage(kind: AiCallKind, params: MessageParams): Promise<Anthropic.Message> {
  const model = config.anthropicModel;
  if (reasoningRequired.has(model)) return sendMessage(withoutForcedToolChoice(params), kind, true);
  const first = hasMandatoryThinking(model)
    ? sendMessage(withoutForcedToolChoice(params), kind)
    : sendMessage(params, kind).catch((err: unknown) => {
        if (!isForcedToolChoiceRejected(err)) throw err;
        console.warn(
          `Модель ${config.anthropicModel} не принимает принудительный tool_choice (thinking включил прокси?) — повторяю запрос с auto`,
        );
        return sendMessage(withoutForcedToolChoice(params), kind);
      });
  return first.catch((err: unknown) => {
    if (!isMandatoryReasoningRejected(err)) throw err;
    console.warn(
      `Модель ${model} не даёт отключить рассуждения — повторяю запрос с ними и tool_choice auto, следующие сразу так`,
    );
    reasoningRequired.add(model);
    return sendMessage(withoutForcedToolChoice(params), kind, true);
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
