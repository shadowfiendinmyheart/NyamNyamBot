import type Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import {
  CoachError,
  type AskCoachInput,
  type CoachDataSource,
  type CommentOnPeriodInput,
} from "../ai/coach.js";
import { trimToLastSentence } from "../utils/text.js";
import { classifyApiError, getClient, THINKING_DISABLED } from "./client.js";
import {
  buildCommentRequest,
  buildContextBlock,
  buildSnapshotBlock,
  COACH_SYSTEM_PROMPT,
  COACH_TOOLS,
  COMMENT_SYSTEM_PROMPT,
} from "./coachPrompts.js";

// Лимиты токенов держат ответ заведомо короче лимита сообщения Telegram (4096):
// кириллица — примерно 2.5–3 символа на токен.
const CHAT_MAX_TOKENS = 700;
const COMMENT_MAX_TOKENS = 250;
const MAX_REPLY_CHARS = 4000;
const MAX_TOOL_ROUNDS = 5;

export async function askCoach(input: AskCoachInput): Promise<string> {
  const system = [COACH_SYSTEM_PROMPT, buildSnapshotBlock(input.dataSource.getSnapshot())];
  if (input.context) system.push(buildContextBlock(input.context));

  const messages: Anthropic.MessageParam[] = [
    ...input.history.map((m) => ({ role: m.role, content: m.text })),
    { role: "user", content: input.question },
  ];

  for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
    const response = await createMessage({
      max_tokens: CHAT_MAX_TOKENS,
      system: system.join("\n\n"),
      tools: COACH_TOOLS,
      messages,
    });

    const toolUses = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === "tool_use",
    );
    if (response.stop_reason !== "tool_use" || toolUses.length === 0) {
      return finalizeText(response);
    }

    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: toolUses.map((toolUse) => runTool(input.dataSource, toolUse)),
    });
  }

  throw new CoachError(
    "Ням-Ням запуталась в ваших записях 🐱 Попробуйте задать вопрос проще или про период покороче.",
    { retryable: false },
  );
}

export async function commentOnPeriod(input: CommentOnPeriodInput): Promise<string> {
  const response = await createMessage({
    max_tokens: COMMENT_MAX_TOKENS,
    system: COMMENT_SYSTEM_PROMPT,
    messages: [
      { role: "user", content: buildCommentRequest(input.kind, input.snapshot, input.summaries) },
    ],
  });
  return finalizeText(response);
}

async function createMessage(
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, "model">,
): Promise<Anthropic.Message> {
  return getClient()
    .messages.create({ model: config.anthropicModel, ...params, ...THINKING_DISABLED })
    .catch((err: unknown) => {
      throw toCoachError(err);
    });
}

function runTool(
  dataSource: CoachDataSource,
  toolUse: Anthropic.ToolUseBlock,
): Anthropic.ToolResultBlockParam {
  const args = (toolUse.input ?? {}) as Record<string, unknown>;
  console.log(`[coach] ${toolUse.name} ${JSON.stringify(args)}`);

  try {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: JSON.stringify(callTool(dataSource, toolUse.name, args)),
    };
  } catch (err) {
    return {
      type: "tool_result",
      tool_use_id: toolUse.id,
      content: err instanceof Error ? err.message : String(err),
      is_error: true,
    };
  }
}

function callTool(
  dataSource: CoachDataSource,
  name: string,
  args: Record<string, unknown>,
): unknown {
  switch (name) {
    case "get_daily_summaries":
      return dataSource.getDailySummaries(String(args.start_date), String(args.end_date));
    case "get_meal_items":
      return dataSource.getMealItems(String(args.date));
    case "get_weight_history":
      return dataSource.getWeightHistory(Number(args.limit));
    default:
      throw new Error(`Неизвестный инструмент: ${name}`);
  }
}

function finalizeText(response: Anthropic.Message): string {
  let text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();

  const cutOff = response.stop_reason === "max_tokens";
  // Оборвалась на вызове инструмента — текст перед ним лишь вступление вроде
  // «Сейчас посмотрю ваши записи…», а не ответ. Проверяем до обрезки: иначе пустая
  // строка превратилась бы в «…».
  const cutOffOnTool = cutOff && response.content.some((block) => block.type === "tool_use");
  if (!text || cutOffOnTool) {
    throw new CoachError("Ням-Ням не смогла сформулировать ответ. Попробуйте ещё раз.", {
      retryable: true,
    });
  }

  if (cutOff) text = trimToLastSentence(text);
  if (text.length > MAX_REPLY_CHARS) text = trimToLastSentence(text, MAX_REPLY_CHARS);
  return text;
}

function toCoachError(err: unknown): CoachError {
  switch (classifyApiError(err)) {
    case "unavailable":
    case "timeout":
      return new CoachError(
        "Ням-Ням сейчас не может ответить — сервис перегружен. Попробуйте через пару минут 🐾",
        { retryable: true, cause: err },
      );
    default:
      return new CoachError("Ням-Ням не смогла ответить. Попробуйте ещё раз.", {
        retryable: false,
        cause: err,
      });
  }
}
