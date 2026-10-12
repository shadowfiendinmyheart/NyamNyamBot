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
  today: {
    date: "2026-08-23",
    totals: { kcal: 0, proteinG: 0, fatG: 0, carbG: 0 },
    meals: [],
    workouts: [],
    burnedKcal: 0,
  },
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
    getExerciseHistory: vi.fn(() => []),
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

    expect(reply.text).toBe("Всё отлично!");
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

    expect(reply.text).toBe("За неделю всё хорошо.");
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

  it("без offer_diary_entry не предлагает записать в дневник", async () => {
    createMock.mockResolvedValue(textResponse("Мур!"));

    const reply = await askCoach({ history: [], question: "Как дела?", dataSource: makeDataSource() });

    expect(reply.offerDiaryEntry).toBe(false);
  });

  it("offer_diary_entry — ответ с предложением записать в дневник", async () => {
    createMock
      .mockResolvedValueOnce(toolResponse("offer_diary_entry", {}))
      .mockResolvedValueOnce(textResponse("Яблоко — отличный перекус! Запишите кнопкой ниже."));

    const reply = await askCoach({
      history: [],
      question: "Съел яблоко",
      dataSource: makeDataSource(),
    });

    expect(reply).toEqual({
      text: "Яблоко — отличный перекус! Запишите кнопкой ниже.",
      offerDiaryEntry: true,
    });
    const { messages, tools } = createMock.mock.calls[1][0];
    expect(tools.map((t: { name: string }) => t.name)).toContain("offer_diary_entry");
    expect(messages[2].content[0]).toMatchObject({ tool_use_id: "toolu_1" });
    expect(messages[2].content[0].is_error).toBeUndefined();
  });

  it("текст вместе с одним offer_diary_entry — ответ без второго запроса", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Отличный перекус! Запишите кнопкой ниже." },
        { type: "tool_use", id: "toolu_1", name: "offer_diary_entry", input: {} },
      ],
      stop_reason: "tool_use",
    });

    const reply = await askCoach({ history: [], question: "Съел яблоко", dataSource: makeDataSource() });

    expect(reply).toEqual({ text: "Отличный перекус! Запишите кнопкой ниже.", offerDiaryEntry: true });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  const mealEntry = "🌙 Ужин\n\n• пельмени — 100 г: 250 ккал (Б 10 / Ж 12.5 / У 25)";
  const correctedItem = {
    name: "пельмени",
    estimated_weight_g: 200,
    kcal: 500.4,
    protein_g: 20.04,
    fat_g: 25,
    carb_g: 50,
  };

  it("разговор о записи: правка и ответ приходят одним запросом", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Поправила: 200 г — это 500 ккал." },
        { type: "tool_use", id: "toolu_1", name: "correct_meal", input: { items: [correctedItem] } },
      ],
      stop_reason: "tool_use",
    });

    const reply = await askCoach({
      history: [],
      question: "Было 200 г",
      meal: { entry: mealEntry },
      dataSource: makeDataSource(),
    });

    expect(reply).toEqual({
      text: "Поправила: 200 г — это 500 ккал.",
      offerDiaryEntry: false,
      mealCorrection: [
        { name: "пельмени", estimatedWeightG: 200, kcal: 500, proteinG: 20, fatG: 25, carbG: 50 },
      ],
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const call = createMock.mock.calls[0][0];
    expect(call.max_tokens).toBe(1500);
    expect(call.system).toContain(mealEntry);
    expect(call.system).toContain("ПОЛНЫМ новым составом");
    expect(call.tools.map((t: { name: string }) => t.name)).toContain("correct_meal");
  });

  it("вопрос о записи без правки — ответ без нового состава", async () => {
    createMock.mockResolvedValueOnce(textResponse("Для ужина — в самый раз."));

    const reply = await askCoach({
      history: [],
      question: "Это много?",
      meal: { entry: mealEntry },
      dataSource: makeDataSource(),
    });

    expect(reply).toEqual({ text: "Для ужина — в самый раз.", offerDiaryEntry: false });
    expect(reply.mealCorrection).toBeUndefined();
  });

  it("без записи (и для удалённой записи) инструмента правки нет", async () => {
    createMock.mockResolvedValue(textResponse("Мур!"));

    await askCoach({ history: [], question: "?", dataSource: makeDataSource() });
    await askCoach({ history: [], question: "?", meal: { entry: null }, dataSource: makeDataSource() });

    for (const [call] of createMock.mock.calls) {
      expect(call.tools.map((t: { name: string }) => t.name)).not.toContain("correct_meal");
      expect(call.max_tokens).toBe(700);
    }
    expect(createMock.mock.calls[1][0].system).toContain("её уже удалили");
  });

  it("пустой состав — ошибка инструмента модели, а не правка", async () => {
    createMock
      .mockResolvedValueOnce({
        content: [
          { type: "text", text: "Поправила." },
          { type: "tool_use", id: "toolu_1", name: "correct_meal", input: { items: [] } },
        ],
        stop_reason: "tool_use",
      })
      .mockResolvedValueOnce(textResponse("Удалить запись можно кнопкой «🗑 Удалить»."));

    const reply = await askCoach({
      history: [],
      question: "Я это не ел",
      meal: { entry: mealEntry },
      dataSource: makeDataSource(),
    });

    expect(reply.mealCorrection).toBeUndefined();
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[1][0].messages[2].content[0]).toMatchObject({
      tool_use_id: "toolu_1",
      is_error: true,
    });
  });

  it("оборванный по max_tokens вызов correct_meal — CoachError, запись не правится", async () => {
    createMock.mockResolvedValueOnce({
      content: [
        { type: "text", text: "Поправила." },
        { type: "tool_use", id: "toolu_1", name: "correct_meal", input: { items: [correctedItem] } },
      ],
      stop_reason: "max_tokens",
    });

    await expect(
      askCoach({ history: [], question: "Было 200 г", meal: { entry: mealEntry }, dataSource: makeDataSource() }),
    ).rejects.toMatchObject({ name: "CoachError", retryable: true });
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

    expect(reply.text).toBe("Белка мало.");
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
    const store: unknown[] = [];

    await expect(
      askCoach({ history: [], question: "?", dataSource: makeDataSource() }).then((r) => store.push(r)),
    ).rejects.toMatchObject({ name: "CoachError", retryable: true });
    expect(store).toEqual([]);
  });

  it("гарантирует, что ответ укладывается в лимит Telegram", async () => {
    createMock.mockResolvedValue(textResponse("Очень длинный совет. ".repeat(400)));

    const reply = await askCoach({ history: [], question: "?", dataSource: makeDataSource() });

    expect(reply.text.length).toBeLessThanOrEqual(4000);
    expect(reply.text.endsWith(".")).toBe(true);
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

  it("ответ прокси 200 не в формате Anthropic — retryable CoachError, а не TypeError", async () => {
    createMock.mockResolvedValue({ error: { message: "upstream provider error" } });

    const err = await askCoach({ history: [], question: "?", dataSource: makeDataSource() }).catch(
      (e: unknown) => e,
    );

    expect(err).toMatchObject({ name: "CoachError", retryable: true });
    expect(String((err as Error).cause)).toContain("upstream provider error");
  });
});

describe("claude/coach commentOnPeriod", () => {
  beforeEach(() => {
    createMock.mockReset();
  });

  const meal = {
    time: "13:00",
    mealType: "lunch" as const,
    description: "обед",
    kcal: 450,
    proteinG: 31,
    fatG: 12,
    carbG: 44,
    items: [
      { name: "гречка", weightG: 200, kcal: 220, proteinG: 8, fatG: 2, carbG: 42 },
      { name: "котлета куриная", weightG: 120, kcal: 230, proteinG: 23, fatG: 10, carbG: 2 },
    ],
  };
  const dayInput = {
    kind: "day" as const,
    snapshot,
    days: [
      {
        ...snapshot.today,
        totals: { kcal: 450, proteinG: 31, fatG: 12, carbG: 44 },
        meals: [meal],
      },
    ],
  };

  function assessResponse(input: unknown, stopReason = "tool_use") {
    return { ...toolResponse("assess_diet", input), stop_reason: stopReason };
  }

  it("оценивает рацион одним вызовом инструмента assess_diet по составу приёмов пищи", async () => {
    createMock.mockResolvedValue(
      assessResponse({
        verdict: "green",
        summary: "Белок и сложные углеводы в обед.",
        advice: "Добавьте овощей к ужину",
      }),
    );

    const comment = await commentOnPeriod(dayInput);

    expect(comment).toEqual({
      verdict: "green",
      summary: "Белок и сложные углеводы в обед.",
      advice: "Добавьте овощей к ужину",
    });
    const call = createMock.mock.calls[0][0];
    expect(call.tools.map((tool: { name: string }) => tool.name)).toEqual(["assess_diet"]);
    expect(call.tool_choice).toEqual({ type: "tool", name: "assess_diet" });
    expect(call.max_tokens).toBe(600);
    expect(call.thinking).toEqual({ type: "disabled" });
    const content: string = call.messages[0].content;
    expect(content).toContain("рацион за сегодня");
    expect(content).toContain('"date":"2026-08-23"');
    // Состав приёма пищи — вместо одного описания.
    expect(content).toContain('"name":"котлета куриная"');
    expect(content).toContain('"weightG":200');
    // Сегодняшний день — только среди дней отчёта, без второй копии в снимке.
    expect(content).toContain('"timeZone":"Europe/Moscow"');
    expect(content).not.toContain('"today"');
    expect(content.match(/"date":"2026-08-23"/g)).toHaveLength(1);
  });

  it("недельная оценка просит оценить неделю", async () => {
    createMock.mockResolvedValue(assessResponse({ verdict: "yellow", summary: "Неплохо." }));

    await commentOnPeriod({ ...dayInput, kind: "week" });

    expect(createMock.mock.calls[0][0].messages[0].content).toContain("рацион за эту неделю");
  });

  it("без светофора и совета — verdict и advice null, неизвестный светофор тоже null", async () => {
    createMock.mockResolvedValueOnce(
      assessResponse({ summary: "Пока мало записей — точнее оценю завтра." }),
    );
    createMock.mockResolvedValueOnce(
      assessResponse({ verdict: "purple", summary: "Разнообразно.", advice: "  " }),
    );

    expect(await commentOnPeriod(dayInput)).toEqual({
      verdict: null,
      summary: "Пока мало записей — точнее оценю завтра.",
      advice: null,
    });
    expect(await commentOnPeriod(dayInput)).toEqual({
      verdict: null,
      summary: "Разнообразно.",
      advice: null,
    });
  });

  it("слишком длинный текст обрезается по границе предложения", async () => {
    const text = `${"Первое предложение про обед. ".repeat(20)}Хвост`;
    createMock.mockResolvedValue(
      assessResponse({ verdict: "green", summary: text, advice: text }),
    );

    const comment = await commentOnPeriod(dayInput);

    expect(comment.summary.length).toBeLessThanOrEqual(300);
    expect(comment.summary.endsWith("Первое предложение про обед.")).toBe(true);
    expect(comment.advice!.length).toBeLessThanOrEqual(240);
    expect(comment.advice!.endsWith("Первое предложение про обед.")).toBe(true);
  });

  it("убирает эмодзи модели в начале — светофор, 🐱 и 💡 ставит бот", async () => {
    createMock.mockResolvedValue(
      assessResponse({
        summary: "🐱 Пока мало записей 🐾",
        advice: "💡 Запишите ужин",
      }),
    );

    expect(await commentOnPeriod(dayInput)).toEqual({
      verdict: null,
      summary: "Пока мало записей 🐾",
      advice: "Запишите ужин",
    });
  });

  it("пустая или оборванная оценка — ошибка, чтобы отчёт ушёл без неё", async () => {
    createMock.mockResolvedValueOnce(assessResponse({ verdict: "green", summary: " " }));
    createMock.mockResolvedValueOnce(
      assessResponse({ verdict: "green", summary: "Хорошо" }, "max_tokens"),
    );
    createMock.mockResolvedValueOnce(textResponse("Неплохо, мур!"));

    for (let i = 0; i < 3; i++) {
      await expect(commentOnPeriod(dayInput)).rejects.toBeInstanceOf(CoachError);
    }
  });
});
