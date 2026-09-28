import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CoachDataSource, CoachSnapshot } from "../ai/coach.js";

const createMock = vi.fn();

class FakeAPIConnectionError extends Error {}
class FakeRateLimitError extends Error {}
class FakeAPIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

vi.mock("@anthropic-ai/sdk", () => ({
  default: Object.assign(
    class {
      messages = { create: createMock };
    },
    {
      APIConnectionError: FakeAPIConnectionError,
      RateLimitError: FakeRateLimitError,
      APIError: FakeAPIError,
    },
  ),
}));

vi.mock("../config.js", () => ({
  config: {
    anthropicApiKey: "test-key",
    anthropicBaseUrl: undefined,
    anthropicModel: "claude-sonnet-5",
  },
}));

const { askCoach, commentOnPeriod } = await import("./coach.js");
const { CoachError } = await import("../ai/coach.js");

const snapshot: CoachSnapshot = {
  now: "воскресенье, 23 августа 2026 г. в 12:00 (2026-08-23)",
  timeZone: "Europe/Moscow",
  profile: null,
  today: { date: "2026-08-23", totals: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0 }, meals: [] },
  recentWeights: [],
};

function makeDataSource(): CoachDataSource & { [K in keyof CoachDataSource]: ReturnType<typeof vi.fn> } {
  return {
    getSnapshot: vi.fn(() => snapshot),
    getDailySummaries: vi.fn(() => [{ date: "2026-08-22", totals: {}, meals: [] }]),
    getMealItems: vi.fn(() => {
      throw new Error("Некорректная дата");
    }),
    getWeightHistory: vi.fn(() => []),
  } as never;
}

function textResponse(text: string, stopReason = "end_turn") {
  return { content: [{ type: "text", text }], stop_reason: stopReason };
}

function toolResponse(name: string, input: unknown, id = "toolu_1") {
  return { content: [{ type: "tool_use", id, name, input }], stop_reason: "tool_use" };
}

describe("claude/coach askCoach", () => {
  beforeEach(() => {
    createMock.mockReset();
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("передаёт снимок, контекст и историю и возвращает текст ответа", async () => {
    createMock.mockResolvedValue(textResponse("Всё отлично!"));

    const reply = await askCoach({
      history: [
        { role: "user", text: "Привет" },
        { role: "assistant", text: "Мур!" },
      ],
      question: "Как я поел?",
      context: "🌙 Итоги дня",
      dataSource: makeDataSource(),
    });

    expect(reply).toBe("Всё отлично!");
    const call = createMock.mock.calls[0][0];
    expect(call.model).toBe("claude-sonnet-5");
    expect(call.max_tokens).toBe(700);
    expect(call.thinking).toEqual({ type: "disabled" });
    expect(call.system).toContain("Ням-Ням");
    expect(call.system).toContain('"timeZone":"Europe/Moscow"');
    expect(call.system).toContain("🌙 Итоги дня");
    expect(call.messages).toEqual([
      { role: "user", content: "Привет" },
      { role: "assistant", content: "Мур!" },
      { role: "user", content: "Как я поел?" },
    ]);
  });

  it("выполняет инструменты и передаёт результаты обратно модели", async () => {
    const dataSource = makeDataSource();
    createMock
      .mockResolvedValueOnce(
        toolResponse("get_daily_summaries", { start_date: "2026-08-17", end_date: "2026-08-23" }),
      )
      .mockResolvedValueOnce(toolResponse("get_meal_items", { date: "вчера" }, "toolu_2"))
      .mockResolvedValueOnce(textResponse("За неделю всё хорошо."));

    const reply = await askCoach({ history: [], question: "Как неделя?", dataSource });

    expect(reply).toBe("За неделю всё хорошо.");
    expect(dataSource.getDailySummaries).toHaveBeenCalledWith("2026-08-17", "2026-08-23");

    // messages — один и тот же массив, который дополняется по ходу цикла:
    // [вопрос, tool_use 1, tool_result 1, tool_use 2, tool_result 2].
    const { messages } = createMock.mock.calls[2][0];
    expect(messages[2]).toEqual({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: "toolu_1",
          content: JSON.stringify([{ date: "2026-08-22", totals: {}, meals: [] }]),
        },
      ],
    });
    // Ошибка источника данных уходит модели как is_error, а не роняет ответ.
    expect(messages[4].content[0]).toMatchObject({
      tool_use_id: "toolu_2",
      is_error: true,
      content: "Некорректная дата",
    });
  });

  it("бросает CoachError, если модель зациклилась на инструментах", async () => {
    createMock.mockResolvedValue(toolResponse("get_weight_history", { limit: 5 }));

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }),
    ).rejects.toBeInstanceOf(CoachError);
    expect(createMock).toHaveBeenCalledTimes(6);
  });

  it("обрезает оборванный по max_tokens ответ до последнего предложения", async () => {
    createMock.mockResolvedValue(textResponse("Белка мало. Добавьте творо", "max_tokens"));

    const reply = await askCoach({ history: [], question: "?", dataSource: makeDataSource() });

    expect(reply).toBe("Белка мало.");
  });

  it("пустой ответ, оборванный по max_tokens, — CoachError, а не «…»", async () => {
    createMock.mockResolvedValue(textResponse("", "max_tokens"));

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }),
    ).rejects.toMatchObject({ name: "CoachError", retryable: true });
  });

  it("ответ, оборванный на вызове инструмента, — CoachError, а не вступление", async () => {
    createMock.mockResolvedValue({
      content: [
        { type: "text", text: "Сейчас посмотрю ваши записи за неделю." },
        { type: "tool_use", id: "toolu_1", name: "get_daily_summaries", input: {} },
      ],
      stop_reason: "max_tokens",
    });
    const store: string[] = [];

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }).then((r) => store.push(r)),
    ).rejects.toMatchObject({ name: "CoachError", retryable: true });
    expect(store).toEqual([]);
  });

  it("гарантирует, что ответ укладывается в лимит Telegram", async () => {
    createMock.mockResolvedValue(textResponse("Очень длинный совет. ".repeat(400)));

    const reply = await askCoach({ history: [], question: "?", dataSource: makeDataSource() });

    expect(reply.length).toBeLessThanOrEqual(4000);
    expect(reply.endsWith(".")).toBe(true);
  });

  it("пустой ответ — CoachError", async () => {
    createMock.mockResolvedValue(textResponse("   "));

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }),
    ).rejects.toBeInstanceOf(CoachError);
  });

  it("перегрузка API — retryable CoachError", async () => {
    createMock.mockRejectedValue(new FakeAPIError("524", 524));

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }),
    ).rejects.toMatchObject({ name: "CoachError", retryable: true });
  });

  it("прочая ошибка API — не-retryable CoachError", async () => {
    createMock.mockRejectedValue(new FakeAPIError("bad request", 400));

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }),
    ).rejects.toMatchObject({ name: "CoachError", retryable: false });
  });
});

describe("claude/coach commentOnPeriod", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  it("делает один вызов без инструментов с данными периода", async () => {
    createMock.mockResolvedValue(textResponse("Неплохо, мур!"));

    const comment = await commentOnPeriod({
      kind: "week",
      snapshot,
      summaries: [snapshot.today],
    });

    expect(comment).toBe("Неплохо, мур!");
    const call = createMock.mock.calls[0][0];
    expect(call.tools).toBeUndefined();
    expect(call.max_tokens).toBe(250);
    expect(call.messages[0].content).toContain("итогам этой недели");
    expect(call.messages[0].content).toContain('"date":"2026-08-23"');
  });

  it("оборванный пустой комментарий — ошибка, чтобы отчёт ушёл без него", async () => {
    createMock.mockResolvedValue(textResponse("", "max_tokens"));

    await expect(
      commentOnPeriod({ kind: "day", snapshot, summaries: [snapshot.today] }),
    ).rejects.toBeInstanceOf(CoachError);
  });
});
